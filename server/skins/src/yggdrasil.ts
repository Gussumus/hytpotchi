/**
 * API в формате Yggdrasil (как у Mojang) для authlib-injector — скины и плащи на ванилле без модов.
 *
 * Лаунчер запускает игру с -javaagent:authlib-injector.jar=<сервер>/yggdrasil. Игра тогда ходит
 * за профилями и текстурами сюда, а не к Mojang, и проверяет подпись текстур нашим ключом.
 *
 *   GET  /yggdrasil/                                         метаданные и открытый ключ
 *   POST /yggdrasil/sessionserver/session/minecraft/join     игрок входит в мир (токен Hytpotchi)
 *   GET  /yggdrasil/sessionserver/session/minecraft/hasJoined?username=&serverId=   мир проверяет игрока
 *   GET  /yggdrasil/sessionserver/session/minecraft/profile/<uuid>[?unsigned=false] профиль с текстурами
 *   POST /yggdrasil/api/profiles/minecraft                   ники → UUID
 *   GET  /yggdrasil/minecraftservices/player/attributes      «можно играть по сети» (заглушка)
 *
 * UUID игрока — офлайновый UUID ника (как раньше), поэтому миры и инвентари не теряются.
 * Ключ подписи — секрет YGG_PRIVATE_KEY (PKCS#8 PEM, RSA). Без него текстуры не подписываются.
 */

import { md5 } from './md5.ts'

export interface YggEnv {
  SKINS: KVNamespace
  YGG_PRIVATE_KEY?: string
}

/** Доступ к хабу (аккаунты): кто владелец токена, запомнить/проверить вход в мир */
export interface YggHub {
  whoami(token: string): Promise<{ nick: string } | null>
  registered(nick: string): Promise<boolean>
  joined(serverId: string, nick: string, uuid: string): Promise<void>
  hasJoined(serverId: string, nick: string): Promise<boolean>
}

interface Profile {
  username: string
  model: 'default' | 'slim'
  hash: string
}

const NAME_RE = /^[A-Za-z0-9_]{3,16}$/
const UUID_RE = /^[0-9a-f]{32}$/

/** UUID офлайн-игрока (так считает сам Minecraft): MD5("OfflinePlayer:" + ник), версия 3 */
export function offlineUuid(nick: string): string {
  const h = md5(new TextEncoder().encode(`OfflinePlayer:${nick}`))
  h[6] = (h[6] & 0x0f) | 0x30
  h[8] = (h[8] & 0x3f) | 0x80
  return [...h].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
const noContent = () => new Response(null, { status: 204 })
const yggError = (status: number, error: string, errorMessage: string) => json({ error, errorMessage }, status)

// ---------- Ключ подписи ----------

const b64 = (buf: ArrayBuffer | Uint8Array) => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

function pemBody(pem: string): Uint8Array {
  const body = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')
  return Uint8Array.from(atob(body), (c) => c.charCodeAt(0))
}

interface Keys {
  sign: CryptoKey
  publicPem: string
}
let cachedKeys: { pem: string; keys: Promise<Keys> } | null = null

async function loadKeys(pem: string): Promise<Keys> {
  const algo = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-1' }
  const priv = await crypto.subtle.importKey('pkcs8', pemBody(pem), algo, true, ['sign'])
  const jwk = (await crypto.subtle.exportKey('jwk', priv)) as JsonWebKey
  const pub = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, ext: true }, algo, true, ['verify'])
  const spki = b64(await crypto.subtle.exportKey('spki', pub))
  const publicPem = `-----BEGIN PUBLIC KEY-----\n${spki.match(/.{1,64}/g)!.join('\n')}\n-----END PUBLIC KEY-----\n`
  return { sign: priv, publicPem }
}

function keys(env: YggEnv): Promise<Keys> | null {
  const pem = env.YGG_PRIVATE_KEY
  if (!pem) return null
  if (!cachedKeys || cachedKeys.pem !== pem) cachedKeys = { pem, keys: loadKeys(pem) }
  return cachedKeys.keys
}

// ---------- Профили ----------

async function nickOfUuid(env: YggEnv, uuid: string): Promise<string | null> {
  return env.SKINS.get(`uuid:${uuid}`)
}

/** Запомнить, какому нику принадлежит UUID (для поиска профиля по UUID) */
export async function rememberUuid(env: YggEnv, nick: string) {
  const uuid = offlineUuid(nick)
  if ((await env.SKINS.get(`uuid:${uuid}`)) !== nick) await env.SKINS.put(`uuid:${uuid}`, nick)
  return uuid
}

async function texturesProperty(env: YggEnv, origin: string, nick: string, uuid: string, signed: boolean) {
  const raw = await env.SKINS.get(`profile:${nick.toLowerCase()}`)
  const skin = raw ? (JSON.parse(raw) as Profile) : null
  const cape = await env.SKINS.get(`cape:${nick.toLowerCase()}`)
  const textures: Record<string, unknown> = {}
  if (skin) {
    textures.SKIN = {
      url: `${origin}/textures/${skin.hash}`,
      ...(skin.model === 'slim' ? { metadata: { model: 'slim' } } : {}),
    }
  }
  if (cape) textures.CAPE = { url: `${origin}/textures/${cape}` }
  const value = b64(
    new TextEncoder().encode(
      JSON.stringify({ timestamp: Date.now(), profileId: uuid, profileName: nick, signatureRequired: signed, textures }),
    ),
  )
  const prop: { name: string; value: string; signature?: string } = { name: 'textures', value }
  const k = signed ? keys(env) : null
  if (k) {
    const { sign } = await k
    prop.signature = b64(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', sign, new TextEncoder().encode(value)))
  }
  return prop
}

async function profileJson(env: YggEnv, origin: string, nick: string, uuid: string, signed: boolean) {
  return {
    id: uuid,
    name: nick,
    properties: [
      await texturesProperty(env, origin, nick, uuid, signed),
      { name: 'uploadableTextures', value: 'skin,cape' },
    ],
  }
}

// ---------- Обработчик ----------

export async function handleYggdrasil(request: Request, env: YggEnv, hub: YggHub): Promise<Response> {
  const url = new URL(request.url)
  const origin = url.origin
  const path = url.pathname.replace(/^\/yggdrasil/, '') || '/'

  if (request.method === 'GET' && path === '/') {
    const k = keys(env)
    return json({
      meta: {
        serverName: 'Hytpotchi',
        implementationName: 'hytpotchi-skins',
        implementationVersion: '1',
        'feature.non_email_login': true,
        'feature.no_mojang_namespace': true,
      },
      skinDomains: [url.hostname],
      ...(k ? { signaturePublickey: (await k).publicPem } : {}),
    })
  }

  // Игрок входит в мир: токен аккаунта Hytpotchi должен принадлежать этому профилю
  if (request.method === 'POST' && path === '/sessionserver/session/minecraft/join') {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    const token = typeof body.accessToken === 'string' ? body.accessToken : ''
    const profile = typeof body.selectedProfile === 'string' ? body.selectedProfile.replace(/-/g, '') : ''
    const serverId = typeof body.serverId === 'string' ? body.serverId : ''
    if (!token || !UUID_RE.test(profile) || !serverId || serverId.length > 64) {
      return yggError(403, 'ForbiddenOperationException', 'Invalid token.')
    }
    const user = await hub.whoami(token)
    if (!user || offlineUuid(user.nick) !== profile) {
      return yggError(403, 'ForbiddenOperationException', 'Invalid token.')
    }
    await rememberUuid(env, user.nick)
    await hub.joined(serverId, user.nick, profile)
    return noContent()
  }

  // Мир (хозяин) проверяет, что игрок действительно вошёл
  if (request.method === 'GET' && path === '/sessionserver/session/minecraft/hasJoined') {
    const username = url.searchParams.get('username') ?? ''
    const serverId = url.searchParams.get('serverId') ?? ''
    if (!NAME_RE.test(username) || !serverId) return noContent()
    if (!(await hub.hasJoined(serverId, username))) return noContent()
    return json(await profileJson(env, origin, username, offlineUuid(username), true))
  }

  const prof = /^\/sessionserver\/session\/minecraft\/profile\/([0-9a-fA-F-]{32,36})$/.exec(path)
  if (request.method === 'GET' && prof) {
    const uuid = prof[1].replace(/-/g, '').toLowerCase()
    const nick = UUID_RE.test(uuid) ? await nickOfUuid(env, uuid) : null
    if (!nick) return noContent()
    const signed = url.searchParams.get('unsigned') === 'false'
    return json(await profileJson(env, origin, nick, uuid, signed))
  }

  if (request.method === 'POST' && path === '/api/profiles/minecraft') {
    const names = (await request.json().catch(() => [])) as unknown
    if (!Array.isArray(names)) return json([])
    const out = []
    for (const n of names.slice(0, 10)) {
      if (typeof n !== 'string' || !NAME_RE.test(n)) continue
      if (await hub.registered(n)) out.push({ id: offlineUuid(n), name: n })
    }
    return json(out)
  }

  if (path === '/minecraftservices/player/attributes') {
    return json({
      privileges: {
        onlineChat: { enabled: true },
        multiplayerServer: { enabled: true },
        multiplayerRealms: { enabled: false },
        telemetry: { enabled: false },
      },
      profanityFilterPreferences: { profanityFilterOn: false },
    })
  }
  if (request.method === 'GET' && path === '/minecraftservices/privacy/blocklist') {
    return json({ blockedProfiles: [] })
  }

  return yggError(404, 'Not Found', 'Нет такого пути')
}
