// Тест магазина косметики: покупка через ЮKassa (подменённую), выдача предмета, защита от подделок
import assert from 'node:assert/strict'

const worker = (await import(new URL('../src/index.ts', import.meta.url).href)).default
const { CATALOG } = await import(new URL('../src/cosmetics.ts', import.meta.url).href)
const { YOOKASSA_API } = await import(new URL('../src/shop.ts', import.meta.url).href)

// KV и хаб аккаунтов в памяти — как в worker.test.mjs
const store = new Map()
const SKINS = {
  async get(key) {
    return store.get(key) ?? null
  },
  async put(key, value) {
    store.set(key, value)
  },
  async delete(key) {
    store.delete(key)
  },
}
const { FriendsHub } = await import(new URL('../src/hub.ts', import.meta.url).href)
const hubStore = new Map()
const hub = new FriendsHub(
  {
    storage: {
      async get(k) {
        const v = hubStore.get(k)
        return v === undefined ? undefined : structuredClone(v)
      },
      async put(k, v) {
        hubStore.set(k, structuredClone(v))
      },
      async delete(k) {
        return hubStore.delete(k)
      },
    },
  },
  {},
)
const base = { SKINS, FRIENDS: { idFromName: (n) => n, get: () => hub } }
const env = { ...base, YOOKASSA_SHOP_ID: '123456', YOOKASSA_SECRET_KEY: 'test_secret' }
const call = (method, path, { body, token, e = env } = {}) =>
  worker.fetch(
    new Request(`https://skins.test${path}`, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: token ? { authorization: `Bearer ${token}` } : {},
    }),
    e,
  )

async function register(nick) {
  const r = await call('POST', '/api/account/register', { body: { nick, password: 'correct horse 42' } })
  assert.equal(r.status, 200, `регистрация ${nick}`)
  return (await r.json()).token
}
const steve = await register('Steve')
const thief = await register('Thief')

// Подменённая ЮKassa: платежи в памяти, статус меняем вручную
const yoo = new Map()
let yooCalls = 0
const realFetch = globalThis.fetch
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url
  if (!url.startsWith(YOOKASSA_API)) return realFetch(input, init)
  yooCalls++
  assert.equal(init.headers.authorization, `Basic ${btoa('123456:test_secret')}`, 'ключи магазина')
  if (url === `${YOOKASSA_API}/payments` && init.method === 'POST') {
    assert.ok(init.headers['idempotence-key'], 'ключ идемпотентности')
    const body = JSON.parse(init.body)
    const id = `2d${String(yoo.size).padStart(6, '0')}-000f-5000-9000-1b68e7b15f3f`
    const p = { id, status: 'pending', paid: false, amount: body.amount, metadata: body.metadata, confirmation: { type: 'redirect', confirmation_url: `https://yoomoney.test/pay/${id}` } }
    yoo.set(id, p)
    return Response.json(p)
  }
  const m = /\/payments\/([^/]+)$/.exec(url)
  if (m && yoo.has(m[1])) return Response.json(yoo.get(m[1]))
  return new Response('{}', { status: 404 })
}

const paid = CATALOG.find((c) => c.price > 0)
const free = CATALOG.find((c) => c.price === 0 && c.spot !== paid.spot)
assert.ok(paid && free)
const price = paid.price.toFixed(2)

// Каталог говорит, работает ли магазин
assert.equal((await (await call('GET', '/api/cosmetics/catalog')).json()).shop, true)
assert.equal((await (await call('GET', '/api/cosmetics/catalog', { e: base })).json()).shop, false)

// Платное без покупки надеть нельзя, бесплатное — можно
let r = await call('PUT', '/api/cosmetics/Steve', { token: steve, body: { items: [paid.id, free.id] } })
assert.deepEqual((await r.json()).items, [free.id])

// Покупка: только владелец ника, только существующий платный предмет
assert.equal((await call('POST', '/api/shop/buy', { token: thief, body: { nick: 'Steve', item: paid.id } })).status, 403)
assert.equal((await call('POST', '/api/shop/buy', { token: steve, body: { nick: 'Steve', item: 'nope' } })).status, 404)
assert.equal((await call('POST', '/api/shop/buy', { token: steve, body: { nick: 'Steve', item: free.id } })).status, 400)
assert.equal((await call('POST', '/api/shop/buy', { token: steve, body: { nick: 'Steve', item: paid.id }, e: base })).status, 503, 'без ключей магазин выключен')

r = await call('POST', '/api/shop/buy', { token: steve, body: { nick: 'Steve', item: paid.id } })
assert.equal(r.status, 200)
const { paymentId, url } = await r.json()
assert.ok(url.startsWith('https://yoomoney.test/pay/'))
const sent = yoo.get(paymentId)
assert.equal(sent.amount.value, price, 'сумма — цена из каталога')
assert.equal(sent.amount.currency, 'RUB')
assert.deepEqual(sent.metadata, { nick: 'steve', item: paid.id })

// Пока не оплачено — предмета нет
r = await call('GET', `/api/shop/payment/${paymentId}`, { token: steve })
assert.equal((await r.json()).status, 'pending')
assert.equal((await call('GET', `/api/shop/payment/${paymentId}`, { token: thief })).status, 403, 'чужой платёж')

// Поддельное уведомление: в теле «оплачено», но ЮKassa говорит pending — ничего не выдаём
r = await call('POST', '/api/shop/yookassa', { body: { event: 'payment.succeeded', object: { id: paymentId, status: 'succeeded', paid: true } } })
assert.equal(r.status, 200)
assert.deepEqual((await (await call('GET', '/api/cosmetics/Steve')).json()).owned, [])

// Оплачено, но сумма не та (подмена) — не выдаём
yoo.set(paymentId, { ...sent, status: 'succeeded', paid: true, amount: { value: '1.00', currency: 'RUB' } })
await call('POST', '/api/shop/yookassa', { body: { event: 'payment.succeeded', object: { id: paymentId } } })
assert.deepEqual((await (await call('GET', '/api/cosmetics/Steve')).json()).owned, [])

// Настоящая оплата — предмет навсегда у игрока, и его можно надеть
yoo.set(paymentId, { ...sent, status: 'succeeded', paid: true })
r = await call('POST', '/api/shop/yookassa', { body: { event: 'payment.succeeded', object: { id: paymentId } } })
assert.equal(r.status, 200)
let cos = await (await call('GET', '/api/cosmetics/Steve')).json()
assert.deepEqual(cos.owned, [paid.id])
r = await call('PUT', '/api/cosmetics/Steve', { token: steve, body: { items: [paid.id, free.id] } })
assert.deepEqual((await r.json()).items, [paid.id, free.id])

// Повторное уведомление ничего не ломает и не ходит в ЮKassa заново
const before = yooCalls
await call('POST', '/api/shop/yookassa', { body: { event: 'payment.succeeded', object: { id: paymentId } } })
assert.equal(yooCalls, before)
cos = await (await call('GET', '/api/cosmetics/Steve')).json()
assert.deepEqual(cos.owned, [paid.id])
assert.equal((await (await call('GET', `/api/shop/payment/${paymentId}`, { token: steve })).json()).status, 'succeeded')

// Второй раз уже купленное не продаём
assert.equal((await call('POST', '/api/shop/buy', { token: steve, body: { nick: 'Steve', item: paid.id } })).status, 409)

// Отменённый платёж — без предмета; уведомление о несуществующем платеже — просто 200
const other = CATALOG.filter((c) => c.price > 0)[1]
r = await call('POST', '/api/shop/buy', { token: steve, body: { nick: 'Steve', item: other.id } })
const second = (await r.json()).paymentId
yoo.set(second, { ...yoo.get(second), status: 'canceled' })
assert.equal((await (await call('GET', `/api/shop/payment/${second}`, { token: steve })).json()).status, 'canceled')
assert.deepEqual((await (await call('GET', '/api/cosmetics/Steve')).json()).owned, [paid.id])
assert.equal((await call('POST', '/api/shop/yookassa', { body: { object: { id: 'nope' } } })).status, 200)
assert.equal((await call('POST', '/api/shop/yookassa', { body: 'мусор' })).status, 200)

// Страница возврата после оплаты
r = await call('GET', '/shop/return')
assert.equal(r.status, 200)
assert.match(await r.text(), /Косметика/)

// Админка: без ADMIN_NICKS и не-админу — 403; админ выдаёт и забирает
const admin = await register('Boss')
assert.equal((await call('POST', '/api/admin/cosmetics', { token: admin, body: {} })).status, 403)
const aenv = { ...env, ADMIN_NICKS: 'someone, boss' }
const acall = (body, token = admin) => call('POST', '/api/admin/cosmetics', { token, body, e: aenv })
assert.equal((await acall({}, thief)).status, 403)
assert.equal((await acall({})).status, 200)
assert.deepEqual(await (await acall({})).json(), { admin: true })
assert.equal((await acall({ nick: 'Steve', grant: ['нет_такого'] })).status, 400)
assert.equal((await acall({ nick: 'плохой ник' })).status, 400)
const another = CATALOG.filter((c) => c.price > 0 && c.id !== paid.id)[1]
let a = await (await acall({ nick: 'Steve', grant: [another.id, paid.id] })).json()
assert.deepEqual(a.owned, [paid.id, another.id])
a = await (await acall({ nick: 'steve', revoke: [paid.id] })).json()
assert.deepEqual(a.owned, [another.id])
assert.deepEqual((await (await acall({ nick: 'Steve' })).json()).owned, [another.id])
assert.deepEqual((await (await call('GET', '/api/cosmetics/Steve')).json()).owned, [another.id])

globalThis.fetch = realFetch
console.log('shop: все проверки пройдены')
