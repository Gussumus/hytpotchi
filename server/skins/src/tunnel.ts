/**
 * Туннель «играть вместе без модов» — по одному Durable Object на открытый мир.
 *
 * Хозяин нажал в игре «Открыть для сети» → его лаунчер держит управляющий WebSocket
 * (control). Гость открывает WebSocket join с билетом от хаба → туннель шлёт хозяину
 * {"t":"open","c":<id>} → лаунчер хозяина открывает data-WebSocket для этого соединения
 * и подключает его к своему локальному миру. Дальше байты Minecraft идут насквозь:
 * join ⇄ data. Пока data не подключился, байты гостя копятся в буфере.
 *
 *   GET /api/tunnel/<hostId>/control            Authorization: Bearer <secret хозяина>
 *   GET /api/tunnel/<hostId>/data?c=<id>        Authorization: Bearer <secret хозяина>
 *   GET /api/tunnel/<hostId>/join               Authorization: Bearer <билет гостя>
 *
 * Секрет и билеты сюда передаёт хаб (POST /internal/init|allow|close), хранятся только хеши.
 */

import { sha256Hex, type StorageLike } from './hub.ts'

export interface SocketLike {
  send(data: string | ArrayBuffer | Uint8Array): void
  close(code?: number, reason?: string): void
}

type Role = { kind: 'control' } | { kind: 'join'; conn: string } | { kind: 'data'; conn: string }

interface Conn {
  client: SocketLike
  data: SocketLike | null
  buffer: (string | ArrayBuffer | Uint8Array)[]
  buffered: number
}

const MAX_BUFFER = 2 * 1024 * 1024
const MAX_CONNS = 16

export class TunnelError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export class TunnelCore {
  private storage: StorageLike
  private now: () => number
  private control: SocketLike | null = null
  private conns = new Map<string, Conn>()
  private roles = new Map<SocketLike, Role>()
  private seq = 0

  constructor(storage: StorageLike, now: () => number = Date.now) {
    this.storage = storage
    this.now = now
  }

  // ---------- От хаба ----------

  async init(secretHash: string) {
    await this.storage.put('secret', secretHash)
    await this.storage.put('tickets', [])
  }

  async allow(ticketHash: string, expires: number) {
    const now = this.now()
    const tickets = ((await this.storage.get<{ h: string; e: number }[]>('tickets')) ?? []).filter((t) => t.e > now)
    tickets.push({ h: ticketHash, e: expires })
    await this.storage.put('tickets', tickets.slice(-50))
  }

  async close() {
    await this.storage.delete('secret')
    await this.storage.delete('tickets')
    this.control?.close(1000, 'Мир закрыт')
    for (const c of this.conns.values()) {
      c.client.close(1000, 'Мир закрыт')
      c.data?.close(1000, 'Мир закрыт')
    }
    this.control = null
    this.conns.clear()
    this.roles.clear()
  }

  // ---------- Проверки ----------

  private async isHost(secret: string | null) {
    const stored = await this.storage.get<string>('secret')
    return !!secret && !!stored && (await sha256Hex(secret)) === stored
  }

  private async validTicket(ticket: string | null) {
    if (!ticket) return false
    const h = await sha256Hex(ticket)
    const now = this.now()
    const tickets = (await this.storage.get<{ h: string; e: number }[]>('tickets')) ?? []
    // Билет действует несколько минут: игра может открыть несколько соединений (пинг + вход)
    return tickets.some((t) => t.h === h && t.e > now)
  }

  /** Проверить подключение до того, как принимать WebSocket. Возвращает роль. */
  async authorize(kind: string, credential: string | null, conn: string | null): Promise<Role> {
    if (kind === 'control') {
      if (!(await this.isHost(credential))) throw new TunnelError(403, 'Неверный ключ хозяина')
      return { kind: 'control' }
    }
    if (kind === 'data') {
      if (!(await this.isHost(credential))) throw new TunnelError(403, 'Неверный ключ хозяина')
      if (!conn || !this.conns.has(conn)) throw new TunnelError(404, 'Соединение уже закрыто')
      return { kind: 'data', conn }
    }
    if (kind === 'join') {
      if (!(await this.validTicket(credential))) throw new TunnelError(403, 'Приглашение устарело — нажмите «Присоединиться» ещё раз')
      if (!this.control) throw new TunnelError(409, 'Хозяин мира не в сети')
      if (this.conns.size >= MAX_CONNS) throw new TunnelError(429, 'Слишком много подключений')
      return { kind: 'join', conn: String(++this.seq) }
    }
    throw new TunnelError(404, 'Нет такого пути')
  }

  // ---------- Сокеты ----------

  attach(socket: SocketLike, role: Role) {
    this.roles.set(socket, role)
    if (role.kind === 'control') {
      // Новый control (переподключение) заменяет старый
      if (this.control && this.control !== socket) this.control.close(1000, 'Переподключение')
      this.control = socket
      return
    }
    if (role.kind === 'join') {
      this.conns.set(role.conn, { client: socket, data: null, buffer: [], buffered: 0 })
      this.control?.send(JSON.stringify({ t: 'open', c: role.conn }))
      return
    }
    const c = this.conns.get(role.conn)
    if (!c || c.data) {
      socket.close(1011, 'Соединение уже занято')
      return
    }
    c.data = socket
    for (const chunk of c.buffer) socket.send(chunk)
    c.buffer = []
    c.buffered = 0
  }

  message(socket: SocketLike, data: string | ArrayBuffer | Uint8Array) {
    const role = this.roles.get(socket)
    if (!role) return
    if (role.kind === 'control') {
      // Пинг лаунчера, чтобы соединение не засыпало
      if (data === 'ping') socket.send('pong')
      return
    }
    const c = this.conns.get(role.conn)
    if (!c) return
    if (role.kind === 'data') {
      c.client.send(data)
      return
    }
    if (c.data) c.data.send(data)
    else {
      const size = typeof data === 'string' ? data.length : data.byteLength
      c.buffered += size
      if (c.buffered > MAX_BUFFER) {
        this.drop(role.conn, 1011, 'Хозяин не ответил')
        return
      }
      c.buffer.push(data)
    }
  }

  closed(socket: SocketLike) {
    const role = this.roles.get(socket)
    this.roles.delete(socket)
    if (!role) return
    if (role.kind === 'control') {
      if (this.control === socket) {
        this.control = null
        // Хозяин пропал — гостевые соединения без него бессмысленны
        for (const id of this.conns.keys()) this.drop(id, 1001, 'Хозяин мира отключился')
      }
      return
    }
    this.drop(role.conn, 1000, 'Соединение закрыто')
  }

  private drop(conn: string, code: number, reason: string) {
    const c = this.conns.get(conn)
    if (!c) return
    this.conns.delete(conn)
    for (const s of [c.client, c.data]) {
      if (!s) continue
      this.roles.delete(s)
      try {
        s.close(code, reason)
      } catch {
        /* уже закрыт */
      }
    }
    this.control?.send(JSON.stringify({ t: 'close', c: conn }))
  }

  stats() {
    return { control: !!this.control, conns: this.conns.size }
  }
}

/** Durable Object туннеля */
export class TunnelRelay {
  private core: TunnelCore

  constructor(state: { storage: StorageLike }) {
    this.core = new TunnelCore(state.storage)
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    try {
      // Команды хаба
      const internal = /^\/internal\/(init|allow|close)$/.exec(url.pathname)
      if (internal && request.method === 'POST') {
        const body = (await request.json()) as Record<string, unknown>
        if (internal[1] === 'init') await this.core.init(String(body.secretHash))
        else if (internal[1] === 'allow') await this.core.allow(String(body.ticketHash), Number(body.expires))
        else await this.core.close()
        return new Response('ok')
      }

      const m = /^\/api\/tunnel\/[0-9a-f]{24}\/(control|data|join)$/.exec(url.pathname)
      if (!m) throw new TunnelError(404, 'Нет такого пути')
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') throw new TunnelError(426, 'Нужен WebSocket')
      const auth = request.headers.get('authorization') ?? ''
      const credential = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null
      const role = await this.core.authorize(m[1], credential, url.searchParams.get('c'))

      const pair = new WebSocketPair()
      const [client, server] = Object.values(pair) as [WebSocket, WebSocket]
      server.accept()
      this.core.attach(server, role)
      server.addEventListener('message', (e: MessageEvent) => this.core.message(server, e.data as ArrayBuffer | string))
      server.addEventListener('close', () => this.core.closed(server))
      server.addEventListener('error', () => this.core.closed(server))
      return new Response(null, { status: 101, webSocket: client })
    } catch (e) {
      const status = e instanceof TunnelError ? e.status : 500
      const message = e instanceof TunnelError ? e.message : 'Ошибка туннеля'
      return new Response(JSON.stringify({ error: message }), {
        status,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      })
    }
  }
}
