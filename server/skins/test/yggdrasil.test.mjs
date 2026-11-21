// Тест API Yggdrasil (authlib-injector): UUID как у Minecraft, подпись текстур, вход в мир, поиск профилей
import assert from 'node:assert/strict'

const { md5 } = await import(new URL('../src/md5.ts', import.meta.url).href)
const { handleYggdrasil, offlineUuid, rememberUuid } = await import(new URL('../src/yggdrasil.ts', import.meta.url).href)

// MD5: известные значения RFC 1321
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
const enc = (s) => new TextEncoder().encode(s)
assert.equal(hex(md5(enc(''))), 'd41d8cd98f00b204e9800998ecf8427e')
assert.equal(hex(md5(enc('abc'))), '900150983cd24fb0d6963f7d28e17f72')
assert.equal(hex(md5(enc('a'.repeat(1000)))), 'cabe45dcc9ae5b66ba86600cca6b8ba8')
// UUID офлайн-игрока — как в лаунчере и в самом Minecraft
assert.equal(offlineUuid('Notch'), 'b50ad385829d3141a2167e7d7539ba7f')

// Ключ подписи
const algo = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-1', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }
const pair = await crypto.subtle.generateKey(algo, true, ['sign', 'verify'])
const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64')
const pem = `-----BEGIN PRIVATE KEY-----\n${pkcs8.match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----\n`

const kv = new Map()
const env = {
  YGG_PRIVATE_KEY: pem,
  SKINS: {
    async get(k) {
      return kv.get(k) ?? null
    },
    async put(k, v) {
      kv.set(k, v)
    },
    async delete(k) {
      kv.delete(k)
    },
  },
}
const joins = new Map()
const hub = {
  async whoami(token) {
    return token === 'alice-token' ? { nick: 'Alice' } : null
  },
  async registered(nick) {
    return nick.toLowerCase() === 'alice'
  },
  async joined(serverId, nick) {
    joins.set(serverId, nick)
  },
  async hasJoined(serverId, nick) {
    return joins.get(serverId)?.toLowerCase() === nick.toLowerCase()
  },
}
const S = 'https://srv.test'
const get = async (path) => {
  const r = await handleYggdrasil(new Request(S + path), env, hub)
  return { status: r.status, body: r.status === 204 ? null : await r.json() }
}
const post = async (path, body) => {
  const r = await handleYggdrasil(new Request(S + path, { method: 'POST', body: JSON.stringify(body) }), env, hub)
  return { status: r.status, body: r.status === 204 ? null : await r.json() }
}

// Метаданные и открытый ключ
const root = (await get('/yggdrasil/')).body
assert.equal(root.meta.serverName, 'Hytpotchi')
assert.deepEqual(root.skinDomains, ['srv.test'])
assert.match(root.signaturePublickey, /^-----BEGIN PUBLIC KEY-----\n/)
const pubDer = Buffer.from(root.signaturePublickey.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64')
const pub = await crypto.subtle.importKey('spki', pubDer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-1' }, false, ['verify'])

// Скин и плащ Алисы
const aliceUuid = offlineUuid('Alice')
kv.set('profile:alice', JSON.stringify({ username: 'Alice', model: 'slim', hash: 'a'.repeat(64) }))
kv.set('cape:alice', 'c'.repeat(64))

// Вход в мир: чужой токен и чужой профиль — нельзя
assert.equal((await post('/yggdrasil/sessionserver/session/minecraft/join', { accessToken: 'bad', selectedProfile: aliceUuid, serverId: 's1' })).status, 403)
assert.equal((await post('/yggdrasil/sessionserver/session/minecraft/join', { accessToken: 'alice-token', selectedProfile: offlineUuid('Bob'), serverId: 's1' })).status, 403)
assert.equal((await post('/yggdrasil/sessionserver/session/minecraft/join', { accessToken: 'alice-token', selectedProfile: aliceUuid, serverId: 's1' })).status, 204)
assert.equal(kv.get(`uuid:${aliceUuid}`), 'Alice', 'UUID запомнен для поиска профиля')

// Мир проверяет игрока: другой serverId или ник — нет
assert.equal((await get('/yggdrasil/sessionserver/session/minecraft/hasJoined?username=Alice&serverId=other')).status, 204)
assert.equal((await get('/yggdrasil/sessionserver/session/minecraft/hasJoined?username=Bob&serverId=s1')).status, 204)
const joined = await get('/yggdrasil/sessionserver/session/minecraft/hasJoined?username=Alice&serverId=s1')
assert.equal(joined.status, 200)
assert.equal(joined.body.id, aliceUuid)
const tex = joined.body.properties.find((p) => p.name === 'textures')
const decoded = JSON.parse(Buffer.from(tex.value, 'base64').toString())
assert.equal(decoded.profileName, 'Alice')
assert.equal(decoded.textures.SKIN.url, `${S}/textures/${'a'.repeat(64)}`)
assert.equal(decoded.textures.SKIN.metadata.model, 'slim')
assert.equal(decoded.textures.CAPE.url, `${S}/textures/${'c'.repeat(64)}`)
// Подпись проверяется открытым ключом из метаданных (так делает authlib-injector)
assert.ok(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', pub, Buffer.from(tex.signature, 'base64'), enc(tex.value)))

// Профиль по UUID: без подписи по умолчанию, с подписью по unsigned=false; с дефисами тоже
const unsigned = (await get(`/yggdrasil/sessionserver/session/minecraft/profile/${aliceUuid}`)).body
assert.equal(unsigned.name, 'Alice')
assert.equal(unsigned.properties.find((p) => p.name === 'textures').signature, undefined)
const dashed = aliceUuid.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5')
const signedProfile = (await get(`/yggdrasil/sessionserver/session/minecraft/profile/${dashed}?unsigned=false`)).body
assert.ok(signedProfile.properties.find((p) => p.name === 'textures').signature)
assert.equal((await get(`/yggdrasil/sessionserver/session/minecraft/profile/${'0'.repeat(32)}`)).status, 204)

// Ники → UUID: только зарегистрированные
assert.deepEqual((await post('/yggdrasil/api/profiles/minecraft', ['Alice', 'Nobody', 'bad name!'])).body, [{ id: aliceUuid, name: 'Alice' }])

// Без ключа — работает, но без подписи
const noKey = { ...env, YGG_PRIVATE_KEY: undefined }
const r = await handleYggdrasil(new Request(S + '/yggdrasil/'), noKey, hub)
assert.equal((await r.json()).signaturePublickey, undefined)

// Заглушки сервисов Minecraft
assert.equal((await get('/yggdrasil/minecraftservices/player/attributes')).body.privileges.multiplayerServer.enabled, true)
assert.equal((await get('/yggdrasil/nope')).status, 404)

await rememberUuid(env, 'Bob')
assert.equal(kv.get(`uuid:${offlineUuid('Bob')}`), 'Bob')

console.log('yggdrasil: все проверки пройдены')
