// Тест сервера скинов в Node: KV в памяти, реальные Request/Response
import assert from 'node:assert/strict'

const workerPath = new URL('../src/index.ts', import.meta.url).href
const worker = (await import(workerPath)).default

const store = new Map()
const SKINS = {
  async get(key, type) {
    const v = store.get(key)
    if (v === undefined) return null
    if (type === 'arrayBuffer') return v instanceof Uint8Array ? v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) : v
    return typeof v === 'string' ? v : new TextDecoder().decode(v)
  },
  async put(key, value) {
    store.set(key, value instanceof ArrayBuffer ? new Uint8Array(value) : value)
  },
  async delete(key) {
    store.delete(key)
  },
}
// Хаб аккаунтов в памяти — как Durable Object
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
const env = { SKINS, FRIENDS: { idFromName: (n) => n, get: () => hub } }
const call = (method, path, { body, token, headers = {} } = {}) =>
  worker.fetch(
    new Request(`https://skins.test${path}`, {
      method,
      body,
      headers: { ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    }),
    env,
  )

function png(w, h, size = 200) {
  const b = new Uint8Array(size)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  new DataView(b.buffer).setUint32(16, w)
  new DataView(b.buffer).setUint32(20, h)
  b[100] = 7
  return b
}

async function register(nick) {
  const r = await call('POST', '/api/account/register', {
    body: JSON.stringify({ nick, password: 'correct horse' }),
    headers: { 'content-type': 'application/json' },
  })
  assert.equal(r.status, 200, await r.clone().text())
  return (await r.json()).token
}

// Старый скин офлайн-игрока под ником Steve — пропадает, когда ник регистрируют
await SKINS.put('profile:steve', JSON.stringify({ username: 'Steve', model: 'default', hash: 'f'.repeat(64) }))
await SKINS.put('claim:steve', 'x')
const owner = await register('Steve')
const thief = await register('Thief')
assert.equal(store.has('profile:steve'), false)
assert.equal(store.has('claim:steve'), false)

// здоровье
let r = await call('GET', '/')
assert.equal(r.status, 200)
const root = await r.json()
assert.equal(root.service, 'hytpotchi-skins')
assert.equal(root.accounts, true)

// нет профиля
assert.equal((await call('GET', '/Steve.json')).status, 404)

// загрузка: только владелец аккаунта с этим ником
r = await call('PUT', '/api/skins/Steve?model=slim', { body: png(64, 64), token: owner })
assert.equal(r.status, 200, await r.clone().text())
const up = await r.json()

// профиль в формате CustomSkinLoader (регистр ника не важен)
r = await call('GET', '/steve.json')
assert.equal(r.status, 200)
const profile = await r.json()
assert.equal(profile.username, 'Steve')
assert.equal(profile.skins.slim, up.hash)

// текстура
r = await call('GET', `/textures/${up.hash}`)
assert.equal(r.status, 200)
assert.equal(r.headers.get('content-type'), 'image/png')
assert.equal(new Uint8Array(await r.arrayBuffer())[100], 7)

// чужой аккаунт не может перезаписать ник, незарегистрированный ник — тоже нельзя
r = await call('PUT', '/api/skins/STEVE', { body: png(64, 64), token: thief })
assert.equal(r.status, 403)
assert.match((await r.json()).error, /владелец/)

// Старые лаунчеры (до аккаунтов): ключ на свободный ник — можно, ник закрепляется за ключом
const legacy = 'c'.repeat(64)
assert.equal((await call('PUT', '/api/skins/Oldie', { body: png(64, 64), token: legacy })).status, 200)
assert.equal((await call('PUT', '/api/skins/Oldie', { body: png(64, 64), token: 'd'.repeat(64) })).status, 403, 'чужой ключ')
assert.equal((await call('PUT', '/api/skins/Oldie', { body: png(64, 64), token: legacy })).status, 200, 'свой ключ')
// …но под зарегистрированным ником старый ключ не проходит
assert.equal((await call('PUT', '/api/skins/Steve', { body: png(64, 64), token: legacy })).status, 403)
// Ник Oldie зарегистрировали — старый ключ больше не действует, скин Oldie снят
const oldieOwner = await register('Oldie')
assert.equal(store.has('profile:oldie'), false)
assert.equal((await call('PUT', '/api/skins/Oldie', { body: png(64, 64), token: legacy })).status, 403)
assert.equal((await call('PUT', '/api/skins/Oldie', { body: png(64, 64), token: oldieOwner })).status, 200)

// владелец может обновить
r = await call('PUT', '/api/skins/Steve', { body: png(64, 32), token: owner })
assert.equal(r.status, 200)
assert.ok((await (await call('GET', '/Steve.json')).json()).skins.default)

// неправильные данные
assert.equal((await call('PUT', '/api/skins/Steve', { body: png(128, 128), token: owner })).status, 400)
assert.equal((await call('PUT', '/api/skins/St', { body: png(64, 64), token: owner })).status, 400)
assert.equal((await call('PUT', '/api/skins/Alex', { body: png(64, 64), token: 'short' })).status, 403)
assert.equal((await call('GET', '/textures/../secret')).status, 404)

// удаление: только владелец
assert.equal((await call('DELETE', '/api/skins/Steve', { token: thief })).status, 403)
assert.equal((await call('DELETE', '/api/skins/Steve', { token: owner })).status, 200)
assert.equal((await call('GET', '/Steve.json')).status, 404)

console.log('skins worker: all checks passed')
