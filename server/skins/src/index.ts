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
 * Туннель «играть вместе без модов» — Durable Object TunnelRelay на каждый мир (см. tunnel.ts):
 *   GET  /api/tunnel/{hostId}/control|data|join   (WebSocket)
 *
 * Ник принадлежит аккаунту Hytpotchi: скин для зарегистрированного ника может загрузить только
 * его владелец, поэтому скины не путаются. Старые лаунчеры (до аккаунтов) публикуют скин по-прежнему —
 * ключом, закреплённым за ником, — но только под ником, который никто не зарегистрировал.
 */

export { FriendsHub } from './hub.ts'
export { TunnelRelay } from './tunnel.ts'

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

const hubOf = (env: Env) => env.FRIENDS!.get(env.FRIENDS!.idFromName('hub'))

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
      return json({ username: p.username, skins: { [p.model]: p.hash } }, 200, 'public, max-age=60')
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
        return json({ ok: true, hash })
      }

      if (request.method === 'DELETE') {
        if (!(await mayEditSkin(request, env, name))) return error('Этот ник принадлежит другому игроку', 403)
        await env.SKINS.delete(`profile:${key}`)
        return json({ ok: true })
      }
    }

    return error('not found', 404)
  },
}
