// Тест хаба (аккаунты + друзья) в Node: хранилище Durable Object в памяти
import assert from 'node:assert/strict'

const { Hub } = await import(new URL('../src/hub.ts', import.meta.url).href)

function memoryStorage() {
  const map = new Map()
  return {
    map,
    async get(k) {
      const v = map.get(k)
      return v === undefined ? undefined : structuredClone(v)
    },
    async put(k, v) {
      map.set(k, structuredClone(v))
    },
    async delete(k) {
      return map.delete(k)
    },
  }
}

// Туннели: запоминаем, что хаб им сообщил
const tunnelLog = []
const tunnels = {
  async init(hostId, secretHash) {
    tunnelLog.push(['init', hostId, secretHash])
  },
  async allow(hostId, ticketHash, expires) {
    tunnelLog.push(['allow', hostId, ticketHash, expires])
  },
  async close(hostId) {
    tunnelLog.push(['close', hostId])
  },
}

let clock = 1_000_000
const storage = memoryStorage()
let hub = new Hub(storage, tunnels, () => clock)

const call = async (path, body, token) => {
  const res = await hub.handle(
    new Request(`https://srv.test${path}`, {
      method: 'POST',
      body: JSON.stringify(body ?? {}),
      headers: token ? { authorization: `Bearer ${token}` } : {},
    }),
  )
  return { status: res.status, body: await res.json() }
}
const acc = (a, b, t) => call(`/api/account/${a}`, b, t)
const fr = (a, b, t) => call(`/api/friends/${a}`, b, t)

// ---------- Регистрация ----------
const alice = await acc('register', { nick: 'Alice', password: 'password-1' })
assert.equal(alice.status, 200, JSON.stringify(alice.body))
assert.equal(alice.body.user.nick, 'Alice')
assert.match(alice.body.recovery, /^([A-Z2-9]{4}-){3}[A-Z2-9]{4}$/)
assert.equal(alice.body.token.length, 64)
const A = alice.body.token

assert.equal((await acc('register', { nick: 'alice', password: 'password-2' })).status, 409, 'ник без учёта регистра')
assert.equal((await acc('register', { nick: 'Ал', password: 'password-1' })).status, 400)
assert.equal((await acc('register', { nick: 'Bob', password: 'short' })).status, 400)

// На сервере нет ни пароля, ни токена, ни кода восстановления в открытом виде
const dump = JSON.stringify([...storage.map.entries()])
for (const secret of ['password-1', A, alice.body.recovery]) assert.ok(!dump.includes(secret))

const bob = (await acc('register', { nick: 'Bob_2', password: 'bobs-secret' })).body
const B = bob.token

// ---------- Вход ----------
assert.equal((await acc('login', { nick: 'ALICE', password: 'password-1' })).status, 200)
assert.equal((await acc('login', { nick: 'Alice', password: 'wrong-pass' })).status, 401)
assert.equal((await acc('login', { nick: 'Nobody', password: 'whatever1' })).status, 401)
assert.equal((await acc('me', {}, A)).body.user.nick, 'Alice')
assert.equal((await acc('me', {})).status, 401)

// Блокировка после 5 неверных паролей
for (let i = 0; i < 4; i++) await acc('login', { nick: 'Bob_2', password: 'nope-nope' })
assert.equal((await acc('login', { nick: 'Bob_2', password: 'nope-nope' })).status, 401)
assert.equal((await acc('login', { nick: 'Bob_2', password: 'bobs-secret' })).status, 429, 'заблокирован')
// С другого адреса владелец входит — подбор с одного адреса не блокирует аккаунт целиком
const fromIp = async (ip, body) => {
  const res = await hub.handle(
    new Request('https://srv.test/api/account/login', { method: 'POST', body: JSON.stringify(body), headers: { 'cf-connecting-ip': ip } }),
  )
  return res.status
}
for (let i = 0; i < 5; i++) await fromIp('6.6.6.6', { nick: 'Bob_2', password: 'nope-nope' })
assert.equal(await fromIp('6.6.6.6', { nick: 'Bob_2', password: 'bobs-secret' }), 429)
assert.equal(await fromIp('1.2.3.4', { nick: 'Bob_2', password: 'bobs-secret' }), 200)
clock += 6 * 60_000
assert.equal((await acc('login', { nick: 'Bob_2', password: 'bobs-secret' })).status, 200, 'блок снят')

// ---------- Восстановление и смена пароля ----------
assert.equal((await acc('recover', { nick: 'Alice', recovery: 'AAAA-BBBB-CCCC-DDDD', password: 'new-pass-1' })).status, 401)
const rec = await acc('recover', { nick: 'alice', recovery: alice.body.recovery.toLowerCase(), password: 'new-pass-1' })
assert.equal(rec.status, 200)
assert.notEqual(rec.body.recovery, alice.body.recovery)
assert.equal((await acc('me', {}, A)).status, 401, 'старые сеансы вышли')
let A2 = rec.body.token
assert.equal((await acc('login', { nick: 'Alice', password: 'new-pass-1' })).status, 200)
const other = (await acc('login', { nick: 'Alice', password: 'new-pass-1' })).body.token
assert.equal((await acc('password', { old: 'wrong', password: 'new-pass-2' }, A2)).status, 403)
assert.equal((await acc('password', { old: 'new-pass-1', password: 'new-pass-2' }, A2)).status, 200)
assert.equal((await acc('me', {}, other)).status, 401, 'другие сеансы вышли')
assert.equal((await acc('me', {}, A2)).status, 200, 'текущий остался')

// Выход
const tmp = (await acc('login', { nick: 'Alice', password: 'new-pass-2' })).body.token
assert.equal((await acc('logout', {}, tmp)).status, 200)
assert.equal((await acc('me', {}, tmp)).status, 401)

// whoami — для проверки владельца скина
assert.equal((await call('/internal/whoami', {}, A2)).body.user.nick, 'Alice')

// ---------- Друзья по нику ----------
assert.equal((await fr('request', { nick: 'Ghost' }, A2)).status, 404)
assert.equal((await fr('request', { nick: 'alice' }, A2)).status, 400)
assert.deepEqual((await fr('request', { nick: 'bob_2' }, A2)).body, { ok: true, accepted: false })
let s = (await fr('sync', {}, B)).body
assert.equal(s.me.nick, 'Bob_2')
assert.equal(s.requests[0].nick, 'Alice')
assert.equal((await fr('sync', {}, A2)).body.outgoing[0].nick, 'Bob_2')
assert.equal((await fr('respond', { id: s.requests[0].id, accept: true }, B)).status, 200)
s = (await fr('sync', { activity: { instance: 'Выживание', mc: '26.3', loader: null } }, A2)).body
assert.equal(s.friends[0].nick, 'Bob_2')
assert.equal(s.friends[0].online, true)

// ---------- Туннель ----------
// Алиса открыла мир без модов: хаб создаёт туннель и отдаёт секрет только ей
s = (await fr('sync', { host: { relay: true, world: 'Остров', mc: '26.3', loader: null } }, A2)).body
assert.ok(s.me.relay?.hostId && s.me.relay?.secret)
assert.equal(tunnelLog.at(-1)[0], 'init')
const hostId = s.me.relay.hostId
// Повторный sync не пересоздаёт туннель
assert.equal((await fr('sync', { host: { relay: true, world: 'Остров', mc: '26.3', loader: null } }, A2)).body.me.relay.hostId, hostId)

// Боб видит открытый мир, но не секрет
s = (await fr('sync', {}, B)).body
assert.equal(s.friends[0].host.relay, true)
assert.equal(s.friends[0].host.world, 'Остров')
assert.ok(!JSON.stringify(s).includes('secret'))
assert.equal(s.me.relay, null)

// Билет для входа
const j = await fr('join', { id: s.friends[0].id }, B)
assert.equal(j.status, 200)
assert.equal(j.body.hostId, hostId)
assert.equal(tunnelLog.at(-1)[0], 'allow')

// Приглашение в свой мир через туннель
assert.equal((await fr('invite', { to: s.friends[0].id }, B)).status, 409, 'у Боба мир закрыт')
const aliceView = (await fr('sync', { host: { relay: true, world: 'Остров', mc: '26.3', loader: null } }, A2)).body
assert.equal((await fr('invite', { to: aliceView.friends[0].id, note: 'Го!' }, A2)).status, 200)
const inv = (await fr('sync', {}, B)).body.invites[0]
assert.equal(inv.relay, true)
assert.equal(inv.fromNick, 'Alice')

// Чужак не может зайти
const eve = (await acc('register', { nick: 'Eve', password: 'eve-password' })).body.token
assert.equal((await fr('join', { id: aliceView.me.id }, eve)).status, 403)

// Хозяин-невидимка всё равно пускает друзей (например, по приглашению)
await fr('sync', { status: 'invisible', host: { relay: true, world: 'Остров', mc: '26.3', loader: null } }, A2)
assert.equal((await fr('join', { id: aliceView.me.id }, B)).status, 200)
await fr('sync', { status: 'online', host: { relay: true, world: 'Остров', mc: '26.3', loader: null } }, A2)

// Мир закрыт — туннель закрывается, входа нет
await fr('sync', { host: null }, A2)
assert.deepEqual(tunnelLog.at(-1), ['close', hostId])
assert.equal((await fr('join', { id: aliceView.me.id }, B)).status, 409)

// e4mc-адрес по-прежнему работает
await fr('sync', { host: { address: 'cool-fox.e4mc.link', mc: '26.3', loader: 'fabric' } }, A2)
assert.equal((await fr('sync', {}, B)).body.friends[0].host.address, 'cool-fox.e4mc.link')

// Невидимка и таймаут
await fr('sync', { status: 'invisible' }, A2)
assert.equal((await fr('sync', {}, B)).body.friends[0].online, false)
await fr('sync', { status: 'online' }, A2)
clock += 200_000
assert.equal((await fr('sync', {}, B)).body.friends[0].online, false)

// Статус переживает «засыпание» Durable Object
await fr('sync', { status: 'busy' }, A2)
hub = new Hub(storage, tunnels, () => clock)
assert.equal((await fr('sync', {}, B)).body.friends[0].status, 'busy')

// ---------- Сборка хозяина ----------
const pack = {
  name: 'Выживание',
  mc: '26.3',
  loader: 'fabric',
  loaderVersion: '0.20.1',
  files: [{ path: 'mods/sodium.jar', sha1: 'a'.repeat(40), size: 10, url: 'https://cdn.modrinth.com/x.jar' }],
}
assert.equal((await fr('pack/get', { id: aliceView.me.id }, B)).status, 404, 'ещё не делилась')
const put = await fr('pack', { pack }, A2)
assert.equal(put.status, 200)
assert.match(put.body.hash, /^[0-9a-f]{64}$/)
assert.equal((await fr('pack', { pack: { files: 'x' } }, A2)).status, 400)
assert.equal((await fr('pack', { pack: { mc: '1', files: [], junk: 'x'.repeat(1_100_000) } }, A2)).status, 413)
const got = await fr('pack/get', { id: aliceView.me.id }, B)
assert.equal(got.status, 200)
assert.equal(got.body.hash, put.body.hash)
assert.equal(got.body.pack.files[0].path, 'mods/sodium.jar')
assert.equal((await fr('pack/get', { id: aliceView.me.id }, eve)).status, 403, 'чужим — нет')

// Хеш сборки виден друзьям в открытом мире и попадает в приглашение
await fr('sync', { host: { relay: true, world: 'Остров', mc: '26.3', loader: 'fabric', pack: put.body.hash, mods: 1 } }, A2)
const bobView = (await fr('sync', {}, B)).body
assert.equal(bobView.friends[0].host.pack, put.body.hash)
assert.equal(bobView.friends[0].host.mods, 1)
await fr('invite', { to: aliceView.friends[0].id }, A2)
assert.equal((await fr('sync', {}, B)).body.invites.at(-1).pack, put.body.hash)

// Удаление
await fr('remove', { id: aliceView.me.id }, B)
assert.equal((await fr('sync', {}, A2)).body.friends.length, 0)

// Мусор
assert.equal((await fr('nope', {}, B)).status, 404)
const big = await hub.handle(new Request('https://srv.test/api/friends/sync', { method: 'POST', body: 'x'.repeat(9000) }))
assert.equal(big.status, 413)

console.log('hub: все проверки пройдены')
