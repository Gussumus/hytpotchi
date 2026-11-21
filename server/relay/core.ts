/**
 * Логика релея без сети: по одному TunnelCore на открытый мир, в памяти.
 * Пересылка байтов — та же, что в Durable Object на Cloudflare (server/skins/src/tunnel.ts);
 * отличие только в проверке доступа: вместо секретов от хаба — подписанные пропуска.
 */

import { TunnelCore, TunnelError, type SocketLike } from '../skins/src/tunnel.ts'
import { sha256Hex, type StorageLike } from '../skins/src/hub.ts'
import { verifyRelay } from '../skins/src/relaytoken.ts'

export { TunnelError, type SocketLike }

const PATH_RE = /^\/api\/tunnel\/([0-9a-f]{24})\/(control|data|join)$/
/** Сколько держать пустой туннель (ни хозяина, ни гостей), прежде чем забыть */
const IDLE_MS = 10 * 60_000
const MAX_TUNNELS = 2000

function memoryStorage(): StorageLike & { map: Map<string, unknown> } {
  const map = new Map<string, unknown>()
  return {
    map,
    async get<T>(k: string) {
      return map.get(k) as T | undefined
    },
    async put(k: string, v: unknown) {
      map.set(k, v)
    },
    async delete(k: string) {
      return map.delete(k)
    },
  }
}

interface Tunnel {
  core: TunnelCore
  storage: ReturnType<typeof memoryStorage>
  idleSince: number | null
}

export type Accepted = { tunnel: TunnelCore; role: Awaited<ReturnType<TunnelCore['authorize']>> }

export class RelayHub {
  private tunnels = new Map<string, Tunnel>()
  private key: string
  private now: () => number

  constructor(key: string, now: () => number = Date.now) {
    if (key.length < 32) throw new Error('RELAY_KEY должен быть не короче 32 символов')
    this.key = key
    this.now = now
  }

  private tunnel(hostId: string): Tunnel {
    let t = this.tunnels.get(hostId)
    if (!t) {
      if (this.tunnels.size >= MAX_TUNNELS) throw new TunnelError(503, 'Релей переполнен')
      const storage = memoryStorage()
      t = { core: new TunnelCore(storage, this.now), storage, idleSince: null }
      this.tunnels.set(hostId, t)
    }
    t.idleSince = null
    return t
  }

  /** Проверить запрос на WebSocket до его принятия. Бросает TunnelError. */
  async accept(pathname: string, credential: string | null, conn: string | null): Promise<Accepted> {
    const m = PATH_RE.exec(pathname)
    if (!m) throw new TunnelError(404, 'Нет такого пути')
    const [, hostId, kind] = m
    const now = this.now()
    if (kind === 'join') {
      if (!(await verifyRelay(this.key, 'j', hostId, credential, now))) {
        throw new TunnelError(403, 'Приглашение устарело — нажмите «Присоединиться» ещё раз')
      }
      const t = this.tunnels.get(hostId)
      if (!t) throw new TunnelError(409, 'Хозяин мира не в сети')
      // Пропуск сам несёт срок: TunnelCore проверит его как обычный билет
      const exp = Number(credential!.split('.')[0])
      await t.core.allow(await sha256Hex(credential!), exp)
      return { tunnel: t.core, role: await t.core.authorize('join', credential, conn) }
    }
    if (!(await verifyRelay(this.key, 'h', hostId, credential, now))) {
      throw new TunnelError(403, 'Неверный ключ хозяина')
    }
    const t = this.tunnel(hostId)
    // Хаб продлевает пропуск хозяина при каждой синхронизации — принимаем текущий
    await t.storage.put('secret', await sha256Hex(credential!))
    return { tunnel: t.core, role: await t.core.authorize(kind, credential, conn) }
  }

  /** Забыть туннели без хозяина и гостей. Вызывать по таймеру. */
  sweep() {
    const now = this.now()
    for (const [id, t] of this.tunnels) {
      const s = t.core.stats()
      if (s.control || s.conns > 0) {
        t.idleSince = null
      } else if (t.idleSince === null) {
        t.idleSince = now
      } else if (now - t.idleSince > IDLE_MS) {
        this.tunnels.delete(id)
      }
    }
  }

  stats() {
    let hosts = 0
    let conns = 0
    for (const t of this.tunnels.values()) {
      const s = t.core.stats()
      if (s.control) hosts++
      conns += s.conns
    }
    return { tunnels: this.tunnels.size, hosts, conns }
  }
}
