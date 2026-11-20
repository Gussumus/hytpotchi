// Тест туннеля в Node: поддельные сокеты, настоящая логика пересылки
import assert from 'node:assert/strict'

const { TunnelCore } = await import(new URL('../src/tunnel.ts', import.meta.url).href)
const { sha256Hex } = await import(new URL('../src/hub.ts', import.meta.url).href)

function memoryStorage() {
  const map = new Map()
  return {
    async get(k) {
      return structuredClone(map.get(k))
    },
    async put(k, v) {
      map.set(k, structuredClone(v))
    },
    async delete(k) {
      return map.delete(k)
    },
  }
}

function socket(name) {
  return {
    name,
    sent: [],
    closedWith: null,
    send(d) {
      this.sent.push(d)
    },
    close(code, reason) {
      this.closedWith = [code, reason]
    },
  }
}

let clock = 1000
const t = new TunnelCore(memoryStorage(), () => clock)
const secret = 'host-secret-'.padEnd(64, 'x')
await t.init(await sha256Hex(secret))

// Без хозяина и билета — нельзя
await assert.rejects(t.authorize('control', 'wrong', null), { status: 403 })
await assert.rejects(t.authorize('join', 'ticket', null), { status: 403 })

// Хозяин подключается
const control = socket('control')
t.attach(control, await t.authorize('control', secret, null))
control.sent.length = 0
t.message(control, 'ping')
assert.deepEqual(control.sent, ['pong'])
control.sent.length = 0

// Гость с билетом
const ticket = 'ticket-123'
await t.allow(await sha256Hex(ticket), clock + 60_000)
const guest = socket('guest')
const role = await t.authorize('join', ticket, null)
t.attach(guest, role)
const open = JSON.parse(control.sent[0])
assert.equal(open.t, 'open')

// Байты гостя ждут в буфере, пока хозяин не подключит data
t.message(guest, new Uint8Array([1, 2, 3]))
t.message(guest, new Uint8Array([4]))
await assert.rejects(t.authorize('data', 'bad', open.c), { status: 403 })
const data = socket('data')
t.attach(data, await t.authorize('data', secret, open.c))
assert.deepEqual(data.sent.map((b) => [...b]), [[1, 2, 3], [4]])

// Дальше — насквозь в обе стороны
t.message(data, new Uint8Array([9, 9]))
assert.deepEqual([...guest.sent.at(-1)], [9, 9])
t.message(guest, new Uint8Array([5]))
assert.deepEqual([...data.sent.at(-1)], [5])

// Тот же билет годится для второго соединения (игра пингует, потом входит)
const guest2 = socket('guest2')
t.attach(guest2, await t.authorize('join', ticket, null))
assert.equal(t.stats().conns, 2)

// Гость закрыл — закрывается и data, хозяин получает close
t.closed(guest)
assert.ok(data.closedWith)
assert.equal(JSON.parse(control.sent.at(-1)).t, 'close')
assert.equal(t.stats().conns, 1)

// Билет истёк
clock += 61_000
await assert.rejects(t.authorize('join', ticket, null), { status: 403 })

// Хозяин отключился — гости отключаются, новые не входят
await t.allow(await sha256Hex('t2'), clock + 60_000)
t.closed(control)
assert.ok(guest2.closedWith)
await assert.rejects(t.authorize('join', 't2', null), { status: 409 })

// Мир закрыли — секрет больше не действует
const control2 = socket('control2')
t.attach(control2, await t.authorize('control', secret, null))
await t.close()
assert.ok(control2.closedWith)
await assert.rejects(t.authorize('control', secret, null), { status: 403 })

console.log('tunnel: все проверки пройдены')
