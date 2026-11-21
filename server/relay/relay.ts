/**
 * Релей Hytpotchi для игры с друзьями без VPN — запускается на VPS в России (Bun, без зависимостей).
 *
 *   RELAY_KEY=<тот же ключ, что у воркера> PORT=8443 bun run server/relay/relay.ts
 *
 * Необязательно: TLS_CERT и TLS_KEY — пути к сертификату и ключу (тогда wss://).
 * Подробная инструкция — server/relay/README.md.
 */

import { RelayHub, TunnelError, type Accepted } from './core.ts'

declare const Bun: {
  serve<T>(options: Record<string, unknown>): { port: number; upgrade(req: Request, opts: { data: T }): boolean }
  file(path: string): unknown
  env: Record<string, string | undefined>
}

type Ws = {
  data: Accepted
  send(data: string | ArrayBuffer | Uint8Array): number
  close(code?: number, reason?: string): void
}

const env = Bun.env
const key = env.RELAY_KEY ?? ''
const hub = new RelayHub(key)
setInterval(() => hub.sweep(), 60_000)

const tls = env.TLS_CERT && env.TLS_KEY ? { cert: Bun.file(env.TLS_CERT), key: Bun.file(env.TLS_KEY) } : undefined

const jsonError = (status: number, message: string) =>
  new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })

const server = Bun.serve<Accepted>({
  port: Number(env.PORT ?? 8443),
  tls,
  async fetch(req: Request, srv: { upgrade(req: Request, opts: { data: Accepted }): boolean }) {
    const url = new URL(req.url)
    if (url.pathname === '/') {
      return Response.json({ service: 'hytpotchi-relay', ok: true, ...hub.stats() })
    }
    if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') return jsonError(426, 'Нужен WebSocket')
    try {
      const auth = req.headers.get('authorization') ?? ''
      const credential = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null
      const accepted = await hub.accept(url.pathname, credential, url.searchParams.get('c'))
      if (srv.upgrade(req, { data: accepted })) return undefined
      return jsonError(400, 'Не удалось открыть WebSocket')
    } catch (e) {
      if (e instanceof TunnelError) return jsonError(e.status, e.message)
      console.error(e)
      return jsonError(500, 'Ошибка релея')
    }
  },
  websocket: {
    // Игровой трафик — без сжатия и с запасом на рывки (загрузка чанков)
    perMessageDeflate: false,
    maxPayloadLength: 4 * 1024 * 1024,
    idleTimeout: 120,
    open(ws: Ws) {
      ws.data.tunnel.attach(ws, ws.data.role)
    },
    message(ws: Ws, msg: string | Uint8Array) {
      ws.data.tunnel.message(ws, msg)
    },
    close(ws: Ws) {
      ws.data.tunnel.closed(ws)
    },
  },
})

console.log(`Релей Hytpotchi слушает порт ${server.port}${tls ? ' (TLS)' : ''}`)
