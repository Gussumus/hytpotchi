/**
 * Hytpotchi Skin Server — Cloudflare Worker.
 *
 * Отдаёт скины в формате CustomSkinLoader (CustomSkinAPI):
 *   GET  /{ник}.json           → {"username": "...", "skins": {"default"|"slim": "<hash>"}}
 *   GET  /textures/{hash}      → PNG
 * Принимает скины от лаунчера:
 *   PUT    /api/skins/{ник}?model=slim|default   (тело — PNG, Authorization: Bearer <ключ>)
 *   DELETE /api/skins/{ник}                       (Authorization: Bearer <ключ>)
 *
 * Ник закрепляется за первым, кто загрузил на него скин: на сервере хранится
 * SHA-256 его секретного ключа. Чужой ник перезаписать нельзя.
 */

export interface Env {
  SKINS: KVNamespace
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

async function authorize(request: Request, env: Env, key: string): Promise<'ok' | 'new' | 'denied'> {
  const auth = request.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  if (token.length < 32 || token.length > 256) return 'denied'
  const tokenHash = await sha256Hex(new TextEncoder().encode(token))
  const claim = await env.SKINS.get(`claim:${key}`)
  if (claim === null) {
    await env.SKINS.put(`claim:${key}`, tokenHash)
    return 'new'
  }
  return claim === tokenHash ? 'ok' : 'denied'
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const path = decodeURIComponent(url.pathname)

    if (request.method === 'GET' && path === '/') {
      return json({ service: 'hytpotchi-skins', ok: true }, 200, 'public, max-age=60')
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

    // Загрузка / удаление скина
    const apiMatch = /^\/api\/skins\/([^/]+)$/.exec(path)
    if (apiMatch) {
      const name = apiMatch[1]
      if (!NAME_RE.test(name)) return error('Ник: 3–16 символов, латиница, цифры и _', 400)
      const key = name.toLowerCase()

      if (request.method === 'PUT') {
        const bytes = new Uint8Array(await request.arrayBuffer())
        if (!validPng(bytes)) return error('Нужен PNG 64×64 или 64×32 до 64 КБ', 400)
        const auth = await authorize(request, env, key)
        if (auth === 'denied') return error('Этот ник уже занят другим игроком Hytpotchi', 403)
        const hash = await sha256Hex(bytes)
        const model = url.searchParams.get('model') === 'slim' ? 'slim' : 'default'
        await env.SKINS.put(`tex:${hash}`, bytes)
        const profile: Profile = { username: name, model, hash, updated: new Date().toISOString() }
        await env.SKINS.put(`profile:${key}`, JSON.stringify(profile))
        return json({ ok: true, claimed: auth === 'new', hash })
      }

      if (request.method === 'DELETE') {
        const auth = await authorize(request, env, key)
        if (auth === 'denied') return error('Этот ник принадлежит другому игроку', 403)
        await env.SKINS.delete(`profile:${key}`)
        return json({ ok: true })
      }
    }

    return error('not found', 404)
  },
}
