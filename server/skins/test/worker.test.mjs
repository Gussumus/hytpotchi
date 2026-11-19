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
const env = { SKINS }
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

const owner = 'a'.repeat(64)
const thief = 'b'.repeat(64)

// здоровье
let r = await call('GET', '/')
assert.equal(r.status, 200)
assert.equal((await r.json()).service, 'hytpotchi-skins')

// нет профиля
assert.equal((await call('GET', '/Steve.json')).status, 404)

// загрузка: первый захватывает ник
r = await call('PUT', '/api/skins/Steve?model=slim', { body: png(64, 64), token: owner })
assert.equal(r.status, 200, await r.clone().text())
const up = await r.json()
assert.equal(up.claimed, true)

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

// чужой ключ не может перезаписать ник
r = await call('PUT', '/api/skins/STEVE', { body: png(64, 64), token: thief })
assert.equal(r.status, 403)
assert.match((await r.json()).error, /занят/)

// владелец может обновить
r = await call('PUT', '/api/skins/Steve', { body: png(64, 32), token: owner })
assert.equal(r.status, 200)
assert.equal((await r.json()).claimed, false)
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
