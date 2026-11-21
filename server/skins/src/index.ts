/**
 * Сервер Hytpotchi — Cloudflare Worker.
 *
 * Скины в формате CustomSkinLoader (CustomSkinAPI):
 *   GET  /{ник}.json           → {"username": "...", "skins": {"default"|"slim": "<hash>"}}
 *   GET  /textures/{hash}      → PNG
 * Загрузка скина владельцем ника (токен аккаунта Hytpotchi):
 *   PUT    /api/skins/{ник}?model=slim|default   (тело — PNG, Authorization: Bearer <токен>)
 *   DELETE /api/skins/{ник}
 *
 * Аккаунты и друзья — Durable Object FriendsHub (см. hub.ts):
 *   POST /api/account/*, POST /api/friends/*
 * Плащ (тот же владелец ника): PUT/DELETE /api/capes/{ник}   (PNG 64×32, 128×64, 256×128 или 512×256)
 * Косметика (мод Hytpotchi Cosmetics): GET /api/cosmetics/catalog, GET|PUT /api/cosmetics/{ник} (см. cosmetics.ts)
 * Скины и плащи на ванилле без модов — API Yggdrasil для authlib-injector: /yggdrasil/* (см. yggdrasil.ts)
 * Туннель «играть вместе без модов» — Durable Object TunnelRelay на каждый мир (см. tunnel.ts):
 *   GET  /api/tunnel/{hostId}/control|data|join   (WebSocket)
 *
 * Ник принадлежит аккаунту Hytpotchi: скин для зарегистрированного ника может загрузить только
 * его владелец, поэтому скины не путаются. Старые лаунчеры (до аккаунтов) публикуют скин по-прежнему —
 * ключом, закреплённым за ником, — но только под ником, который никто не зарегистрировал.
 */

export { FriendsHub } from './hub.ts'
export { TunnelRelay } from './tunnel.ts'
import { handleYggdrasil, rememberUuid, type YggHub } from './yggdrasil.ts'
import { CATALOG, CATALOG_VERSION, cleanSelection } from './cosmetics.ts'

interface DONamespace {
  idFromName(name: string): unknown
  get(id: unknown): { fetch(req: Request): Promise<Response> }
}

export interface Env {
  SKINS: KVNamespace
  /** Аккаунты и друзья. Может отсутствовать на старом развёртывании */
  FRIENDS?: DONamespace
  /** Туннели для совместной игры */
  TUNNEL?: DONamespace
  /** Ключ подписи текстур для authlib-injector (wrangler secret put YGG_PRIVATE_KEY) */
  YGG_PRIVATE_KEY?: string
}

interface Profile {
  username: string
  model: 'default' | 'slim'
  hash: string
  updated: string
}

const NAME_RE = /^[A-Za-z0-9_]{3,16}$/
const HASH_RE = /^[0-9a-f]{64}$/
const MAX_PNG = 64 * 1024
const MAX_CAPE = 256 * 1024

async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function json(body: unknown, status = 200, cache = 'no-store'): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': cache },
  })
}

function error(message: string, status: number): Response {
  return json({ error: message }, status)
}

/** PNG 64×64 или 64×32 */
function validPng(bytes: Uint8Array): boolean {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (bytes.length < 24 || bytes.length > MAX_PNG || !sig.every((b, i) => bytes[i] === b)) return false
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const w = view.getUint32(16)
  const h = view.getUint32(20)
  return w === 64 && (h === 64 || h === 32)
}

/** Плащ: ширина вдвое больше высоты, 64…512 */
function validCape(bytes: Uint8Array): boolean {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (bytes.length < 24 || bytes.length > MAX_CAPE || !sig.every((b, i) => bytes[i] === b)) return false
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const w = view.getUint32(16)
  const h = view.getUint32(20)
  return [64, 128, 256, 512].includes(w) && h * 2 === w
}

const hubOf = (env: Env) => env.FRIENDS!.get(env.FRIENDS!.idFromName('hub'))

/** Хаб для API Yggdrasil */
function yggHub(env: Env): YggHub {
  const call = async (path: string, body: unknown, token?: string) =>
    hubOf(env).fetch(
      new Request(`https://hub${path}`, {
        method: 'POST',
        body: JSON.stringify(body ?? {}),
        headers: token ? { authorization: `Bearer ${token}` } : {},
      }),
    )
  return {
    async whoami(token) {
      const r = await call('/internal/whoami', {}, token)
      if (!r.ok) return null
      return ((await r.json()) as { user: { nick: string } }).user
    },
    async registered(nick) {
      return ((await (await call('/internal/nick', { nick })).json()) as { registered: boolean }).registered
    },
    async joined(serverId, nick) {
      await call('/internal/ygg/join', { serverId, nick })
    },
    async hasJoined(serverId, nick) {
      return ((await (await call('/internal/ygg/hasjoined', { serverId, nick })).json()) as { ok: boolean }).ok
    },
  }
}

/** Кто может менять скин ника: владелец аккаунта, никто (ник занят) или старый ключ (ник свободен) */
async function nickAccess(request: Request, env: Env, nick: string): Promise<'owner' | 'taken' | 'free'> {
  if (!env.FRIENDS) return 'free'
  const hub = hubOf(env)
  const who = await hub.fetch(
    new Request('https://hub/internal/whoami', {
      method: 'POST',
      headers: { authorization: request.headers.get('authorization') ?? '' },
    }),
  )
  if (who.ok) {
    const { user } = (await who.json()) as { user: { nick: string } }
    if (user.nick.toLowerCase() === nick.toLowerCase()) return 'owner'
  }
  const reg = await hub.fetch(
    new Request('https://hub/internal/nick', { method: 'POST', body: JSON.stringify({ nick }) }),
  )
  const { registered } = (await reg.json()) as { registered: boolean }
  return registered ? 'taken' : 'free'
}

/** Старый способ (лаунчеры до аккаунтов): ник закрепляется за первым ключом */
async function legacyClaim(request: Request, env: Env, key: string): Promise<boolean> {
  const auth = request.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  if (token.length < 32 || token.length > 256) return false
  const tokenHash = await sha256Hex(new TextEncoder().encode(token))
  const claim = await env.SKINS.get(`claim:${key}`)
  if (claim === null) {
    await env.SKINS.put(`claim:${key}`, tokenHash)
    return true
  }
  return claim === tokenHash
}

/** Можно ли этому запросу менять скин ника */
async function mayEditSkin(request: Request, env: Env, nick: string): Promise<boolean> {
  const access = await nickAccess(request, env, nick)
  if (access === 'owner') return true
  if (access === 'taken') return false
  return legacyClaim(request, env, nick.toLowerCase())
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const path = decodeURIComponent(url.pathname)

    if (request.method === 'GET' && path === '/') {
      return json(
        { service: 'hytpotchi-skins', ok: true, friends: !!env.FRIENDS, accounts: !!env.FRIENDS, tunnel: !!env.TUNNEL },
        200,
        'public, max-age=60',
      )
    }

    if (path.startsWith('/api/friends/') || path.startsWith('/api/account/')) {
      if (!env.FRIENDS) return error('Аккаунты на этом сервере не включены — обновите его (wrangler deploy)', 501)
      const res = await hubOf(env).fetch(request)
      // Новый владелец ника — старый скин с этим ником (от прежних офлайн-игроков) убираем
      if (path === '/api/account/register' && res.ok) {
        const body = (await res.clone().json()) as { user?: { nick?: string } }
        const nick = body.user?.nick?.toLowerCase()
        if (nick) {
          await env.SKINS.delete(`profile:${nick}`)
          await env.SKINS.delete(`claim:${nick}`)
        }
      }
      return res
    }

    if (path === '/yggdrasil' || path.startsWith('/yggdrasil/')) {
      if (!env.FRIENDS) return error('Аккаунты на этом сервере не включены', 501)
      return handleYggdrasil(request, env, yggHub(env))
    }

    const tunnel = /^\/api\/tunnel\/([0-9a-f]{24})\/(control|data|join)$/.exec(path)
    if (tunnel) {
      if (!env.TUNNEL) return error('Туннель на этом сервере не включён — обновите его (wrangler deploy)', 501)
      return env.TUNNEL.get(env.TUNNEL.idFromName(tunnel[1])).fetch(request)
    }

    // Профиль для CustomSkinLoader
    const profileMatch = /^\/([^/]+)\.json$/.exec(path)
    if (request.method === 'GET' && profileMatch) {
      const name = profileMatch[1]
      if (!NAME_RE.test(name)) return error('bad name', 400)
      const raw = await env.SKINS.get(`profile:${name.toLowerCase()}`)
      if (!raw) return error('not found', 404)
      const p = JSON.parse(raw) as Profile
      const cape = await env.SKINS.get(`cape:${name.toLowerCase()}`)
      return json({ username: p.username, skins: { [p.model]: p.hash }, ...(cape ? { cape } : {}) }, 200, 'public, max-age=60')
    }

    // Текстура
    const texMatch = /^\/textures\/([0-9a-f]+)$/.exec(path)
    if (request.method === 'GET' && texMatch) {
      const hash = texMatch[1]
      if (!HASH_RE.test(hash)) return error('bad hash', 400)
      const png = await env.SKINS.get(`tex:${hash}`, 'arrayBuffer')
      if (!png) return error('not found', 404)
      return new Response(png, {
        headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=31536000, immutable' },
      })
    }

    // Загрузка / удаление скина — только владелец ника
    const apiMatch = /^\/api\/skins\/([^/]+)$/.exec(path)
    if (apiMatch) {
      const name = apiMatch[1]
      if (!NAME_RE.test(name)) return error('Ник: 3–16 символов, латиница, цифры и _', 400)
      const key = name.toLowerCase()

      if (request.method === 'PUT') {
        const bytes = new Uint8Array(await request.arrayBuffer())
        if (!validPng(bytes)) return error('Нужен PNG 64×64 или 64×32 до 64 КБ', 400)
        if (!(await mayEditSkin(request, env, name)))
          return error('Скин для этого ника может загрузить только его владелец — войдите в аккаунт Hytpotchi', 403)
        const hash = await sha256Hex(bytes)
        const model = url.searchParams.get('model') === 'slim' ? 'slim' : 'default'
        await env.SKINS.put(`tex:${hash}`, bytes)
        const profile: Profile = { username: name, model, hash, updated: new Date().toISOString() }
        await env.SKINS.put(`profile:${key}`, JSON.stringify(profile))
        await rememberUuid(env, name)
        return json({ ok: true, hash })
      }

      if (request.method === 'DELETE') {
        if (!(await mayEditSkin(request, env, name))) return error('Этот ник принадлежит другому игроку', 403)
        await env.SKINS.delete(`profile:${key}`)
        return json({ ok: true })
      }
    }

    // Косметика: каталог и что надето у игрока (менять — только владелец ника)
    if (path === '/api/cosmetics/catalog' && request.method === 'GET') {
      return json({ version: CATALOG_VERSION, items: CATALOG }, 200, 'public, max-age=300')
    }
    const cosMatch = /^\/api\/cosmetics\/([^/]+)$/.exec(path)
    if (cosMatch) {
      const name = cosMatch[1]
      if (!NAME_RE.test(name)) return error('bad name', 400)
      const key = `cos:${name.toLowerCase()}`
      if (request.method === 'GET') {
        const raw = await env.SKINS.get(key)
        return json({ items: cleanSelection(raw ? JSON.parse(raw) : []) }, 200, 'public, max-age=30')
      }
      if (request.method === 'PUT') {
        if ((await nickAccess(request, env, name)) !== 'owner') {
          return error('Косметику может менять только владелец ника — войдите в аккаунт Hytpotchi', 403)
        }
        const body = (await request.json().catch(() => ({}))) as { items?: unknown }
        const items = cleanSelection(body.items)
        await env.SKINS.put(key, JSON.stringify(items))
        return json({ items })
      }
    }

    // Плащ — только владелец аккаунта с этим ником
    const capeMatch = /^\/api\/capes\/([^/]+)$/.exec(path)
    if (capeMatch) {
      const name = capeMatch[1]
      if (!NAME_RE.test(name)) return error('Ник: 3–16 символов, латиница, цифры и _', 400)
      if ((await nickAccess(request, env, name)) !== 'owner') {
        return error('Плащ может поставить только владелец ника — войдите в аккаунт Hytpotchi', 403)
      }
      const key = name.toLowerCase()
      if (request.method === 'PUT') {
        const bytes = new Uint8Array(await request.arrayBuffer())
        if (!validCape(bytes)) return error('Нужен PNG плаща: 64×32, 128×64, 256×128 или 512×256, до 256 КБ', 400)
        const hash = await sha256Hex(bytes)
        await env.SKINS.put(`tex:${hash}`, bytes)
        await env.SKINS.put(`cape:${key}`, hash)
        await rememberUuid(env, name)
        return json({ ok: true, hash })
      }
      if (request.method === 'DELETE') {
        await env.SKINS.delete(`cape:${key}`)
        return json({ ok: true })
      }
    }

    return error('not found', 404)
  },
}
