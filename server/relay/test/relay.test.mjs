// Тест релея в Node: пропуски от хаба, настоящая логика пересылки TunnelCore, поддельные сокеты
import assert from 'node:assert/strict'

const { RelayHub, TunnelError } = await import(new URL('../core.ts', import.meta.url).href)
const { signRelay } = await import(new URL('../../skins/src/relaytoken.ts', import.meta.url).href)

function socket(name) {
  return {
    name,
    sent: [],
    closed: null,
    send(d) {
      this.sent.push(d)
    },
    close(code, reason) {
      this.closed = [code, reason]
    },
  }
}

const key = 'k'.repeat(40)
let clock = 1_000_000
const relay = new RelayHub(key, () => clock)
const hostId = 'a'.repeat(24)
const path = (kind) => `/api/tunnel/${hostId}/${kind}`
const status = async (p) => {
  try {
    await p
    return 200
  } catch (e) {
    assert.ok(e instanceof TunnelError, String(e))
    return e.status
  }
}

assert.throws(() => new RelayHub('short'))

const hostPass = await signRelay(key, 'h', hostId, clock + 60_000)
const guestPass = await signRelay(key, 'j', hostId, clock + 60_000)

// Без пропуска, с чужим ключом, с пропуском гостя вместо хозяина — нельзя
assert.equal(await status(relay.accept(path('control'), null, null)), 403)
assert.equal(await status(relay.accept(path('control'), await signRelay('x'.repeat(40), 'h', hostId, clock + 60_000), null)), 403)
assert.equal(await status(relay.accept(path('control'), guestPass, null)), 403)
assert.equal(await status(relay.accept('/api/tunnel/zz/control', hostPass, null)), 404)
// Гость раньше хозяина — мира ещё нет
assert.equal(await status(relay.accept(path('join'), guestPass, null)), 409)

// Хозяин подключился
const ctl = socket('control')
const a = await relay.accept(path('control'), hostPass, null)
a.tunnel.attach(ctl, a.role)
assert.equal(relay.stats().hosts, 1)

// Пропуск хозяина вместо гостя и истёкший пропуск гостя — нельзя
assert.equal(await status(relay.accept(path('join'), hostPass, null)), 403)
assert.equal(await status(relay.accept(path('join'), await signRelay(key, 'j', hostId, clock - 1), null)), 403)

// Гость: хозяин получает open, байты до data копятся, потом идут насквозь
const guest = socket('join')
const g = await relay.accept(path('join'), guestPass, null)
g.tunnel.attach(guest, g.role)
const open = JSON.parse(ctl.sent.at(-1))
assert.equal(open.t, 'open')
g.tunnel.message(guest, new Uint8Array([1, 2, 3]))

// data — только с пропуском хозяина (в том числе продлённым)
assert.equal(await status(relay.accept(`${path('data')}`, guestPass, open.c)), 403)
const renewed = await signRelay(key, 'h', hostId, clock + 120_000)
const data = socket('data')
const d = await relay.accept(path('data'), renewed, open.c)
d.tunnel.attach(data, d.role)
assert.deepEqual([...data.sent[0]], [1, 2, 3])
d.tunnel.message(data, new Uint8Array([9]))
assert.deepEqual([...guest.sent.at(-1)], [9])
g.tunnel.message(guest, new Uint8Array([4]))
assert.deepEqual([...data.sent.at(-1)], [4])

// Хозяин отключился — гость тоже
a.tunnel.closed(ctl)
assert.ok(guest.closed)

// Пустой туннель забывается через 10 минут
relay.sweep()
assert.equal(relay.stats().tunnels, 1)
clock += 11 * 60_000
relay.sweep()
assert.equal(relay.stats().tunnels, 0)

console.log('relay: все проверки пройдены')
