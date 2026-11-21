/**
 * Хаб Hytpotchi — один Durable Object на весь сервер: аккаунты, друзья, статусы,
 * приглашения и выдача доступа к туннелю «играть вместе».
 *
 * Аккаунты (POST /api/account/<действие>):
 *   register {nick, password}            → {token, recovery, user}
 *   login    {nick, password}            → {token, user}
 *   recover  {nick, recovery, password}  → {token, recovery, user}   (новый код восстановления)
 *   password {old, password}        [🔑] → {ok}   (остальные сеансы выходят)
 *   logout                          [🔑] → {ok}
 *   me                              [🔑] → {user}
 *
 * Друзья (POST /api/friends/<действие>, все с токеном 🔑):
 *   sync     {status, activity, host}    → {me, friends, requests, outgoing, invites}
 *   offline                              → {ok}
 *   request  {nick}                      → {ok, accepted}
 *   respond  {id, accept}                → {ok}
 *   remove   {id}                        → {ok}
 *   invite   {to, address?, instance, note} → {ok}
 *   dismiss  {id}                        → {ok}
 *   join     {id}                        → {hostId, ticket, direct?, via?}   (вход в мир друга)
 *            direct — адрес хозяина из интернета (проброс UPnP), via — релей в России {url, ticket}
 *   punch        {id, addr}              → {nonce, key}    гость: «пробить NAT» к миру друга, addr — свой UDP-адрес (STUN)
 *   punch/poll                          → {punches: [{nonce, addr, key}]}   хозяин: кто хочет войти
 *   punch/answer {nonce, addr, cert}    → {ok}            хозяин: свой UDP-адрес и отпечаток сертификата QUIC
 *   punch/wait   {nonce}                → {answer: {addr, cert} | null}     гость: ответ хозяина
 *   pack     {pack}                      → {hash}   (опись модов сборки хозяина, до 1 МБ)
 *   pack/get {id}                        → {pack, hash}   (опись сборки друга — только друзьям)
 *
 * Ник уникален без учёта регистра и совпадает с ником в игре — поэтому скины
 * других игроков не путаются. Пароль хранится как PBKDF2-SHA256 (100 000 итераций, соль),
 * токены и код восстановления — только как SHA-256.
 */

import { signRelay } from './relaytoken.ts'

export interface StorageLike {
  get<T = unknown>(key: string): Promise<T | undefined>
  put(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<boolean>
}

/** Доступ к туннелям: хаб сообщает им секреты хозяина и билеты гостей */
export interface TunnelControl {
  init(hostId: string, secretHash: string): Promise<void>
  allow(hostId: string, ticketHash: string, expires: number): Promise<void>
  close(hostId: string): Promise<void>
}

export interface User {
  id: string
  nick: string
  passHash: string
  salt: string
  recoveryHash: string
  created: number
}

export type Status = 'online' | 'busy' | 'invisible'

export interface Activity {
  instance: string
  mc: string
  loader: string | null
  server?: string | null
}

/** Мир, открытый для друзей: адрес (e4mc) или туннель через лаунчер (relay) */
export interface Host {
  address?: string | null
  relay?: boolean
  world?: string | null
  mc: string
  loader: string | null
  /** Хеш описи сборки (загружена через pack) — друг поставит ту же сборку */
  pack?: string | null
  /** Сколько модов в сборке хозяина */
  mods?: number | null
  /** Прямой адрес мира из интернета (ip:порт, проброшен UPnP) — отдаётся только в join */
  direct?: string | null
}

interface Presence {
  status: Status
  activity: Activity | null
  host: Host | null
  /** Туннель хозяина (только для владельца — друзьям не отдаётся) */
  relay?: { hostId: string; secret: string } | null
  lastSeen: number
}

/** Заявка гостя на прямое соединение с хозяином мира */
interface Punch {
  nonce: string
  /** Ключ, которым гость подтверждает каждое соединение хозяину */
  key: string
  guest: string
  host: string
  addr: string
  at: number
  answer: { addr: string; cert: string } | null
}

/** Во входящих from — кто прислал; в исходящих from — кому отправлена */
interface FriendRequest {
  from: string
  at: number
}

export interface Invite {
  id: string
  from: string
  at: number
  address: string | null
  relay: boolean
  instance: { name: string; mc: string; loader: string | null } | null
  /** Хеш описи сборки хозяина на момент приглашения */
  pack: string | null
  note: string | null
}

const ONLINE_MS = 150_000
const PERSIST_MS = 120_000
const INVITE_TTL = 15 * 60_000
const TICKET_TTL = 5 * 60_000
/** Сколько мир ждёт проверки вошедшего игрока (join → hasJoined) */
const JOIN_TTL = 30_000
/** Сколько ждать хозяина при пробитии NAT */
const PUNCH_TTL = 30_000
const MAX_PUNCHES = 200
/** Пропуск хозяина на релее; хаб продлевает его при каждой синхронизации */
const HOST_PASS_TTL = 12 * 60 * 60_000
const MAX_FRIENDS = 200
const MAX_REQUESTS = 50
const MAX_INVITES = 20
const MAX_SESSIONS = 10
const MAX_PACK = 1024 * 1024
const MAX_BODY = 8192
const LOCK_AFTER = 5
const LOCK_MS = 5 * 60_000
const PBKDF2_ITERATIONS = 100_000
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const NICK_RE = /^[A-Za-z0-9_]{3,16}$/

export class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

function randomHex(bytes: number): string {
  const b = new Uint8Array(bytes)
  crypto.getRandomValues(b)
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
}

function recoveryCode(): string {
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  const s = [...b].map((x) => CODE_ALPHABET[x % CODE_ALPHABET.length]).join('')
  return s.match(/.{4}/g)!.join('-')
}

const normRecovery = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '')

const toHex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')

export async function sha256Hex(text: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
}

async function hashPassword(password: string, saltHex: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
  const salt = new Uint8Array(saltHex.match(/../g)!.map((h) => parseInt(h, 16)))
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS }, key, 256)
  return toHex(bits)
}

/** Сравнение без утечки по времени */
function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function cleanNick(raw: unknown): string {
  const nick = String(raw ?? '').trim()
  if (!NICK_RE.test(nick)) throw new HttpError(400, 'Ник: 3–16 символов — латиница, цифры и _ (как в Minecraft)')
  return nick
}

function cleanPassword(raw: unknown): string {
  const p = String(raw ?? '')
  if (p.length < 8) throw new HttpError(400, 'Пароль — минимум 8 символов')
  if (p.length > 128) throw new HttpError(400, 'Пароль слишком длинный')
  return p
}

function str(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  return s ? s.slice(0, max) : null
}

/** Адрес сервера: host или host:port, без схемы и пробелов */
function cleanAddress(raw: unknown): string {
  const a = str(raw, 255)
  if (!a || !/^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(a)) throw new HttpError(400, 'Некорректный адрес мира')
  return a
}

function cleanActivity(raw: unknown): Activity | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const mc = str(r.mc, 32)
  if (!mc) return null
  return { instance: str(r.instance, 64) ?? 'Minecraft', mc, loader: str(r.loader, 16), server: str(r.server, 255) }
}

/** Публичный IPv4 и порт: друг будет подключаться к нему напрямую, поэтому никаких локальных адресов */
export function cleanDirect(raw: unknown, minPort = 1024): string | null {
  const a = str(raw, 32)
  const m = a ? /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3}):(\d{1,5})$/.exec(a) : null
  if (!m) return null
  const [o1, o2, o3, o4, port] = m.slice(1).map(Number)
  if ([o1, o2, o3, o4].some((o) => o > 255) || port < minPort || port > 65535) return null
  const local =
    o1 === 0 || o1 === 10 || o1 === 127 || o1 >= 224 ||
    (o1 === 100 && o2 >= 64 && o2 < 128) || // CGNAT
    (o1 === 169 && o2 === 254) ||
    (o1 === 172 && o2 >= 16 && o2 < 32) ||
    (o1 === 192 && o2 === 168) ||
    (o1 === 192 && o2 === 0 && o3 === 0) ||
    (o1 === 198 && (o2 === 18 || o2 === 19))
  return local ? null : `${o1}.${o2}.${o3}.${o4}:${port}`
}

/** Внешний релей (сервер в России): адрес для лаунчеров и ключ подписи пропусков */
export interface RelayVia {
  url: string
  key: string
}

function cleanHost(raw: unknown): Host | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const mc = str(r.mc, 32)
  if (!mc) return null
  const pack = typeof r.pack === 'string' && /^[0-9a-f]{64}$/.test(r.pack) ? r.pack : null
  const mods = typeof r.mods === 'number' && r.mods >= 0 && r.mods < 10_000 ? Math.floor(r.mods) : null
  const base = { world: str(r.world, 64), mc, loader: str(r.loader, 16), pack, mods }
  if (r.relay === true) return { ...base, relay: true, address: null, direct: cleanDirect(r.direct) }
  try {
    return { ...base, relay: false, address: cleanAddress(r.address) }
  } catch {
    return null
  }
}

export class Hub {
  /** Свежие статусы в памяти (между записями в хранилище) */
  private presence = new Map<string, Presence>()
  /** Входы в миры через authlib-injector (serverId → ник): живут секунды, только в памяти */
  private joins = new Map<string, { nick: string; at: number }>()
  /** Пробитие NAT: заявки гостей живут секунды, поэтому только в памяти */
  private punches = new Map<string, Punch>()
  private storage: StorageLike
  private tunnels: TunnelControl | null
  private now: () => number
  private via: RelayVia | null

  constructor(storage: StorageLike, tunnels: TunnelControl | null, now: () => number = Date.now, via: RelayVia | null = null) {
    this.storage = storage
    this.tunnels = tunnels
    this.now = now
    this.via = via
  }

  // ---------- Хранилище ----------

  private user(id: string) {
    return this.storage.get<User>(`acc:${id}`)
  }
  private async userByNick(nick: string) {
    const id = await this.storage.get<string>(`nick:${nick.toLowerCase()}`)
    return id ? this.user(id) : undefined
  }
  private async list<T>(key: string): Promise<T[]> {
    return (await this.storage.get<T[]>(key)) ?? []
  }
  private async presenceOf(id: string): Promise<Presence | null> {
    return this.presence.get(id) ?? (await this.storage.get<Presence>(`p:${id}`)) ?? null
  }
  private publicUser(u: User) {
    return { id: u.id, nick: u.nick }
  }

  // ---------- Сеансы ----------

  private async newSession(userId: string): Promise<string> {
    const token = randomHex(32)
    const hash = await sha256Hex(token)
    await this.storage.put(`tok:${hash}`, userId)
    const sessions = await this.list<string>(`sess:${userId}`)
    const keep = [...sessions, hash]
    // Старые сеансы сверх лимита выходят
    for (const old of keep.slice(0, Math.max(0, keep.length - MAX_SESSIONS))) await this.storage.delete(`tok:${old}`)
    await this.storage.put(`sess:${userId}`, keep.slice(-MAX_SESSIONS))
    return token
  }

  private async revokeSessions(userId: string, exceptHash?: string) {
    const sessions = await this.list<string>(`sess:${userId}`)
    for (const h of sessions) if (h !== exceptHash) await this.storage.delete(`tok:${h}`)
    await this.storage.put(`sess:${userId}`, exceptHash ? [exceptHash] : [])
  }

  async auth(token: string | null): Promise<{ user: User; tokenHash: string }> {
    if (!token || token.length < 32 || token.length > 256) throw new HttpError(401, 'Нужно войти в аккаунт Hytpotchi')
    const tokenHash = await sha256Hex(token)
    const id = await this.storage.get<string>(`tok:${tokenHash}`)
    const user = id ? await this.user(id) : undefined
    if (!user) throw new HttpError(401, 'Сеанс истёк — войдите в аккаунт Hytpotchi заново')
    return { user, tokenHash }
  }

  // ---------- Аккаунты ----------

  async register(body: Record<string, unknown>) {
    const nick = cleanNick(body.nick)
    const password = cleanPassword(body.password)
    if (await this.storage.get(`nick:${nick.toLowerCase()}`)) throw new HttpError(409, 'Этот ник уже занят')
    const id = randomHex(8)
    const salt = randomHex(16)
    const recovery = recoveryCode()
    const user: User = {
      id,
      nick,
      salt,
      passHash: await hashPassword(password, salt),
      recoveryHash: await sha256Hex(normRecovery(recovery)),
      created: this.now(),
    }
    // Ник занимаем первым: при гонке второй получит «занят»
    if (await this.storage.get(`nick:${nick.toLowerCase()}`)) throw new HttpError(409, 'Этот ник уже занят')
    await this.storage.put(`nick:${nick.toLowerCase()}`, id)
    await this.storage.put(`acc:${id}`, user)
    return { token: await this.newSession(id), recovery, user: this.publicUser(user) }
  }

  /** Ключ блокировки: ник + адрес. Подбор с одного адреса блокируется, а владелец с другого входит */
  private lockKey(nick: string, ip: string) {
    return `fail:${nick.toLowerCase()}:${ip}`
  }

  private async checkLock(nick: string, ip: string) {
    const lock = await this.storage.get<{ fails: number; until: number }>(this.lockKey(nick, ip))
    if (lock && lock.until > this.now()) {
      const min = Math.ceil((lock.until - this.now()) / 60_000)
      throw new HttpError(429, `Слишком много неверных попыток — подождите ${min} мин`)
    }
    return lock
  }

  private async failed(nick: string, ip: string, prev: { fails: number } | undefined) {
    const fails = (prev?.fails ?? 0) + 1
    await this.storage.put(this.lockKey(nick, ip), {
      fails: fails >= LOCK_AFTER ? 0 : fails,
      until: fails >= LOCK_AFTER ? this.now() + LOCK_MS : 0,
    })
  }

  async login(body: Record<string, unknown>, ip = 'local') {
    const nick = cleanNick(body.nick)
    const password = String(body.password ?? '')
    const lock = await this.checkLock(nick, ip)
    const user = await this.userByNick(nick)
    // Хешируем даже для несуществующего ника — время ответа не выдаёт, есть ли аккаунт
    const hash = await hashPassword(password, user?.salt ?? '00'.repeat(16))
    if (!user || !sameHex(hash, user.passHash)) {
      await this.failed(nick, ip, lock)
      throw new HttpError(401, 'Неверный ник или пароль')
    }
    await this.storage.delete(this.lockKey(nick, ip))
    return { token: await this.newSession(user.id), user: this.publicUser(user) }
  }

  async recover(body: Record<string, unknown>, ip = 'local') {
    const nick = cleanNick(body.nick)
    const password = cleanPassword(body.password)
    const lock = await this.checkLock(nick, ip)
    const user = await this.userByNick(nick)
    const given = await sha256Hex(normRecovery(String(body.recovery ?? '')))
    if (!user || !sameHex(given, user.recoveryHash)) {
      await this.failed(nick, ip, lock)
      throw new HttpError(401, 'Неверный ник или код восстановления')
    }
    const recovery = recoveryCode()
    user.salt = randomHex(16)
    user.passHash = await hashPassword(password, user.salt)
    user.recoveryHash = await sha256Hex(normRecovery(recovery))
    await this.storage.put(`acc:${user.id}`, user)
    await this.storage.delete(this.lockKey(nick, ip))
    await this.revokeSessions(user.id)
    return { token: await this.newSession(user.id), recovery, user: this.publicUser(user) }
  }

  async changePassword(me: User, tokenHash: string, body: Record<string, unknown>) {
    const old = await hashPassword(String(body.old ?? ''), me.salt)
    if (!sameHex(old, me.passHash)) throw new HttpError(403, 'Текущий пароль неверный')
    const password = cleanPassword(body.password)
    me.salt = randomHex(16)
    me.passHash = await hashPassword(password, me.salt)
    await this.storage.put(`acc:${me.id}`, me)
    await this.revokeSessions(me.id, tokenHash)
    return { ok: true }
  }

  async logout(me: User, tokenHash: string) {
    await this.storage.delete(`tok:${tokenHash}`)
    const sessions = await this.list<string>(`sess:${me.id}`)
    await this.storage.put(
      `sess:${me.id}`,
      sessions.filter((h) => h !== tokenHash),
    )
    return { ok: true }
  }

  /** Для воркера: чей это токен (проверка владельца ника при загрузке скина) */
  async whoami(token: string | null) {
    const { user } = await this.auth(token)
    return { user: this.publicUser(user) }
  }

  // ---------- Статусы ----------

  async sync(me: User, body: Record<string, unknown>) {
    const status: Status = body.status === 'busy' || body.status === 'invisible' ? body.status : 'online'
    const prev = await this.presenceOf(me.id)
    const host = cleanHost(body.host)
    let relay = prev?.relay ?? null

    // Туннель живёт, пока открыт мир через relay; новый — при каждом новом открытии
    if (host?.relay) {
      if (!relay && this.tunnels) {
        relay = { hostId: randomHex(12), secret: randomHex(32) }
        await this.tunnels.init(relay.hostId, await sha256Hex(relay.secret))
      }
    } else if (relay) {
      await this.tunnels?.close(relay.hostId)
      relay = null
    }

    const next: Presence = { status, activity: cleanActivity(body.activity), host, relay, lastSeen: this.now() }
    this.presence.set(me.id, next)
    const changed =
      !prev ||
      prev.status !== next.status ||
      JSON.stringify(prev.activity) !== JSON.stringify(next.activity) ||
      JSON.stringify(prev.host) !== JSON.stringify(next.host) ||
      prev.relay?.hostId !== next.relay?.hostId
    const stored = await this.storage.get<Presence>(`p:${me.id}`)
    if (changed || !stored || next.lastSeen - stored.lastSeen > PERSIST_MS) {
      await this.storage.put(`p:${me.id}`, next)
    }
    // Пропуск хозяина на внешний релей — продлевается каждой синхронизацией
    const mine =
      relay && this.via
        ? { ...relay, via: { url: this.via.url, token: await signRelay(this.via.key, 'h', relay.hostId, this.now() + HOST_PASS_TTL) } }
        : relay
    return this.snapshot(me, mine)
  }

  async offline(me: User) {
    const p = await this.presenceOf(me.id)
    if (p?.relay) await this.tunnels?.close(p.relay.hostId)
    this.presence.delete(me.id)
    await this.storage.delete(`p:${me.id}`)
    return { ok: true }
  }

  private visible(p: Presence | null): p is Presence {
    return !!p && p.status !== 'invisible' && this.now() - p.lastSeen < ONLINE_MS
  }

  async snapshot(me: User, relay?: (NonNullable<Presence['relay']> & { via?: { url: string; token: string } }) | null) {
    const friendIds = await this.list<string>(`f:${me.id}`)
    const friends = []
    for (const id of friendIds) {
      const u = await this.user(id)
      if (!u) continue
      const p = await this.presenceOf(id)
      const online = this.visible(p)
      friends.push({
        id,
        nick: u.nick,
        online,
        status: online ? p.status : 'offline',
        activity: online ? p.activity : null,
        // Прямой адрес (IP хозяина) — не всем друзьям в списке, а только тому, кто заходит (join)
        host: online && p.host ? { ...p.host, direct: undefined } : null,
        lastSeen: p && p.status !== 'invisible' ? p.lastSeen : null,
      })
    }
    friends.sort((a, b) => Number(b.online) - Number(a.online) || a.nick.localeCompare(b.nick))

    const people = async (reqs: FriendRequest[]) =>
      (
        await Promise.all(
          reqs.map(async (r) => {
            const u = await this.user(r.from)
            return u ? { id: u.id, nick: u.nick, at: r.at } : null
          }),
        )
      ).filter(Boolean)

    const now = this.now()
    const invitesRaw = (await this.list<Invite>(`inv:${me.id}`)).filter((i) => now - i.at < INVITE_TTL)
    const invites = (
      await Promise.all(
        invitesRaw.map(async (i) => {
          const u = await this.user(i.from)
          return u ? { ...i, fromNick: u.nick } : null
        }),
      )
    ).filter(Boolean)

    return {
      me: { id: me.id, nick: me.nick, relay: relay ?? null },
      friends,
      requests: await people(await this.list<FriendRequest>(`req:${me.id}`)),
      outgoing: await people(await this.list<FriendRequest>(`out:${me.id}`)),
      invites,
    }
  }

  // ---------- Друзья ----------

  private async isFriend(a: string, b: string) {
    return (await this.list<string>(`f:${a}`)).includes(b)
  }

  private async link(a: string, b: string) {
    for (const [x, y] of [
      [a, b],
      [b, a],
    ]) {
      const list = await this.list<string>(`f:${x}`)
      if (!list.includes(y)) await this.storage.put(`f:${x}`, [...list, y])
    }
  }

  private async dropRequest(to: string, from: string) {
    const incoming = await this.list<FriendRequest>(`req:${to}`)
    await this.storage.put(
      `req:${to}`,
      incoming.filter((r) => r.from !== from),
    )
    const outgoing = await this.list<FriendRequest>(`out:${from}`)
    await this.storage.put(
      `out:${from}`,
      outgoing.filter((r) => r.from !== to),
    )
  }

  async request(me: User, body: Record<string, unknown>) {
    const nick = cleanNick(body.nick)
    const target = await this.userByNick(nick)
    if (!target) throw new HttpError(404, `Игрок ${nick} не зарегистрирован в Hytpotchi`)
    if (target.id === me.id) throw new HttpError(400, 'Это вы :)')
    const friends = await this.list<string>(`f:${me.id}`)
    if (friends.includes(target.id)) throw new HttpError(409, 'Вы уже друзья')
    if (friends.length >= MAX_FRIENDS) throw new HttpError(409, `Не больше ${MAX_FRIENDS} друзей`)

    // Встречная заявка — сразу дружим
    const mine = await this.list<FriendRequest>(`req:${me.id}`)
    if (mine.some((r) => r.from === target.id)) {
      await this.dropRequest(me.id, target.id)
      await this.link(me.id, target.id)
      return { ok: true, accepted: true }
    }
    const theirs = await this.list<FriendRequest>(`req:${target.id}`)
    if (theirs.some((r) => r.from === me.id)) return { ok: true, accepted: false }
    if (theirs.length >= MAX_REQUESTS) throw new HttpError(429, 'У игрока слишком много заявок')
    const at = this.now()
    await this.storage.put(`req:${target.id}`, [...theirs, { from: me.id, at }])
    const out = await this.list<FriendRequest>(`out:${me.id}`)
    await this.storage.put(`out:${me.id}`, [...out, { from: target.id, at }])
    return { ok: true, accepted: false }
  }

  async respond(me: User, body: Record<string, unknown>) {
    const from = String(body.id ?? '')
    const incoming = await this.list<FriendRequest>(`req:${me.id}`)
    if (!incoming.some((r) => r.from === from)) throw new HttpError(404, 'Заявка не найдена')
    await this.dropRequest(me.id, from)
    if (body.accept === true) await this.link(me.id, from)
    return { ok: true }
  }

  async remove(me: User, body: Record<string, unknown>) {
    const other = String(body.id ?? '')
    for (const [x, y] of [
      [me.id, other],
      [other, me.id],
    ]) {
      const list = await this.list<string>(`f:${x}`)
      if (list.includes(y))
        await this.storage.put(
          `f:${x}`,
          list.filter((f) => f !== y),
        )
    }
    await this.dropRequest(other, me.id)
    await this.dropRequest(me.id, other)
    return { ok: true }
  }

  async invite(me: User, body: Record<string, unknown>) {
    const to = String(body.to ?? '')
    if (!(await this.isFriend(me.id, to))) throw new HttpError(403, 'Приглашать можно только друзей')
    // Без адреса — зовём в свой мир через туннель (он должен быть открыт)
    let address: string | null = null
    let relay = false
    if (body.address) address = cleanAddress(body.address)
    else {
      const p = await this.presenceOf(me.id)
      if (!p?.relay) throw new HttpError(409, 'Сначала откройте мир: Esc → «Открыть для сети»')
      relay = true
    }
    const inst = body.instance && typeof body.instance === 'object' ? (body.instance as Record<string, unknown>) : null
    const instance =
      inst && str(inst.mc, 32) ? { name: str(inst.name, 64) ?? 'Minecraft', mc: str(inst.mc, 32)!, loader: str(inst.loader, 16) } : null
    const now = this.now()
    const list = (await this.list<Invite>(`inv:${to}`)).filter((i) => now - i.at < INVITE_TTL && i.from !== me.id)
    const pack = (await this.presenceOf(me.id))?.host?.pack ?? null
    const invite: Invite = { id: randomHex(6), from: me.id, at: now, address, relay, instance, pack, note: str(body.note, 140) }
    await this.storage.put(`inv:${to}`, [...list, invite].slice(-MAX_INVITES))
    return { ok: true, id: invite.id }
  }

  async dismiss(me: User, body: Record<string, unknown>) {
    const id = String(body.id ?? '')
    const list = await this.list<Invite>(`inv:${me.id}`)
    await this.storage.put(
      `inv:${me.id}`,
      list.filter((i) => i.id !== id),
    )
    return { ok: true }
  }

  /** Билет для входа в мир друга через туннель */
  async join(me: User, body: Record<string, unknown>) {
    const hostUser = String(body.id ?? '')
    if (!(await this.isFriend(me.id, hostUser))) throw new HttpError(403, 'Заходить можно только к друзьям')
    const p = await this.presenceOf(hostUser)
    // Статус «невидимка» не мешает: друг мог позвать по приглашению. Важно лишь, что хозяин в сети.
    const alive = !!p && this.now() - p.lastSeen < ONLINE_MS
    if (!alive || !p.relay || !this.tunnels) throw new HttpError(409, 'Мир друга сейчас закрыт')
    const ticket = randomHex(24)
    const expires = this.now() + TICKET_TTL
    await this.tunnels.allow(p.relay.hostId, await sha256Hex(ticket), expires)
    const via = this.via ? { url: this.via.url, ticket: await signRelay(this.via.key, 'j', p.relay.hostId, expires) } : null
    return { hostId: p.relay.hostId, ticket, direct: p.host?.direct ?? null, via }
  }

  // ---------- Прямое соединение (пробитие NAT) ----------

  private dropOldJoins() {
    const now = this.now()
    for (const [id, j] of this.joins) if (now - j.at > JOIN_TTL) this.joins.delete(id)
  }

  private dropOldPunches() {
    const now = this.now()
    for (const [nonce, p] of this.punches) if (now - p.at > PUNCH_TTL * 2) this.punches.delete(nonce)
  }

  /** Гость хочет войти в мир друга напрямую: его UDP-адрес уходит хозяину */
  async punch(me: User, body: Record<string, unknown>) {
    const hostUser = String(body.id ?? '')
    if (!(await this.isFriend(me.id, hostUser))) throw new HttpError(403, 'Заходить можно только к друзьям')
    const p = await this.presenceOf(hostUser)
    const alive = !!p && this.now() - p.lastSeen < ONLINE_MS
    if (!alive || !p.relay) throw new HttpError(409, 'Мир друга сейчас закрыт')
    const addr = cleanDirect(body.addr, 1)
    if (!addr) throw new HttpError(400, 'Некорректный адрес')
    this.dropOldPunches()
    if (this.punches.size >= MAX_PUNCHES || [...this.punches.values()].filter((x) => x.guest === me.id).length >= 5) {
      throw new HttpError(429, 'Слишком много попыток — подождите немного')
    }
    const punch: Punch = { nonce: randomHex(12), key: randomHex(16), guest: me.id, host: hostUser, addr, at: this.now(), answer: null }
    this.punches.set(punch.nonce, punch)
    return { nonce: punch.nonce, key: punch.key }
  }

  /** Хозяин: заявки на прямое соединение, на которые он ещё не ответил */
  async punchPoll(me: User) {
    this.dropOldPunches()
    const now = this.now()
    const punches = [...this.punches.values()]
      .filter((p) => p.host === me.id && !p.answer && now - p.at < PUNCH_TTL)
      .map((p) => ({ nonce: p.nonce, addr: p.addr, key: p.key }))
    return { punches }
  }

  /** Хозяин: свой UDP-адрес и отпечаток сертификата для гостя */
  async punchAnswer(me: User, body: Record<string, unknown>) {
    const p = this.punches.get(String(body.nonce ?? ''))
    if (!p || p.host !== me.id) throw new HttpError(404, 'Заявка устарела')
    const addr = cleanDirect(body.addr, 1)
    const cert = typeof body.cert === 'string' && /^[0-9a-f]{64}$/.test(body.cert) ? body.cert : null
    if (!addr || !cert) throw new HttpError(400, 'Некорректный ответ')
    p.answer = { addr, cert }
    return { ok: true }
  }

  /** Гость: ответ хозяина (null — ещё ждём) */
  async punchWait(me: User, body: Record<string, unknown>) {
    const p = this.punches.get(String(body.nonce ?? ''))
    if (!p || p.guest !== me.id) throw new HttpError(404, 'Заявка устарела')
    return { answer: p.answer }
  }

  // ---------- Сборки ----------

  /** Хозяин мира кладёт опись своей сборки (моды с Modrinth): друг поставит такую же */
  async putPack(me: User, raw: string) {
    if (raw.length > MAX_PACK) throw new HttpError(413, 'Сборка слишком большая для передачи')
    let pack: Record<string, unknown>
    try {
      pack = (JSON.parse(raw) as { pack: Record<string, unknown> }).pack
    } catch {
      throw new HttpError(400, 'Некорректная опись сборки')
    }
    if (!pack || typeof pack !== 'object' || !str(pack.mc, 32) || !Array.isArray(pack.files)) {
      throw new HttpError(400, 'Некорректная опись сборки')
    }
    const data = JSON.stringify(pack)
    const hash = await sha256Hex(data)
    const prev = await this.storage.get<{ hash: string }>(`pack:${me.id}`)
    if (prev?.hash !== hash) await this.storage.put(`pack:${me.id}`, { hash, data, at: this.now() })
    return { hash }
  }

  async getPack(me: User, body: Record<string, unknown>) {
    const id = String(body.id ?? '')
    if (!(await this.isFriend(me.id, id))) throw new HttpError(403, 'Сборку можно получить только у друга')
    const stored = await this.storage.get<{ hash: string; data: string }>(`pack:${id}`)
    if (!stored) throw new HttpError(404, 'Друг ещё не поделился сборкой')
    return { hash: stored.hash, pack: JSON.parse(stored.data) }
  }

  // ---------- HTTP ----------

  async handle(request: Request): Promise<Response> {
    try {
      const path = new URL(request.url).pathname
      if (request.method !== 'POST') throw new HttpError(405, 'Только POST')
      const text = await request.text()
      // Опись сборки бывает большой; остальные запросы — маленькие
      if (text.length > (path === '/api/friends/pack' ? MAX_PACK : MAX_BODY)) throw new HttpError(413, 'Слишком большой запрос')
      let body: Record<string, unknown> = {}
      if (text) {
        try {
          body = JSON.parse(text)
        } catch {
          throw new HttpError(400, 'Некорректный JSON')
        }
      }
      const authHeader = request.headers.get('authorization') ?? ''
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null
      const ip = request.headers.get('cf-connecting-ip') ?? 'local'

      switch (path) {
        case '/api/account/register':
          return json(await this.register(body))
        case '/api/account/login':
          return json(await this.login(body, ip))
        case '/api/account/recover':
          return json(await this.recover(body, ip))
        case '/internal/whoami':
          return json(await this.whoami(token))
        case '/internal/nick':
          // Для воркера: зарегистрирован ли ник (старые лаунчеры могут публиковать скин только под свободным)
          return json({ registered: !!(await this.storage.get(`nick:${cleanNick(body.nick).toLowerCase()}`)) })
        case '/internal/ygg/join': {
          // authlib-injector: игрок входит в мир (токен уже проверен воркером)
          const serverId = String(body.serverId ?? '').slice(0, 64)
          this.dropOldJoins()
          if (serverId && this.joins.size < 10_000) this.joins.set(serverId, { nick: String(body.nick ?? ''), at: this.now() })
          return json({ ok: true })
        }
        case '/internal/ygg/hasjoined': {
          this.dropOldJoins()
          const j = this.joins.get(String(body.serverId ?? ''))
          return json({ ok: !!j && j.nick.toLowerCase() === String(body.nick ?? '').toLowerCase() })
        }
      }

      const { user: me, tokenHash } = await this.auth(token)
      switch (path) {
        case '/api/account/me':
          return json({ user: this.publicUser(me) })
        case '/api/account/password':
          return json(await this.changePassword(me, tokenHash, body))
        case '/api/account/logout':
          return json(await this.logout(me, tokenHash))
        case '/api/friends/sync':
          return json(await this.sync(me, body))
        case '/api/friends/offline':
          return json(await this.offline(me))
        case '/api/friends/request':
          return json(await this.request(me, body))
        case '/api/friends/respond':
          return json(await this.respond(me, body))
        case '/api/friends/remove':
          return json(await this.remove(me, body))
        case '/api/friends/invite':
          return json(await this.invite(me, body))
        case '/api/friends/dismiss':
          return json(await this.dismiss(me, body))
        case '/api/friends/join':
          return json(await this.join(me, body))
        case '/api/friends/punch':
          return json(await this.punch(me, body))
        case '/api/friends/punch/poll':
          return json(await this.punchPoll(me))
        case '/api/friends/punch/answer':
          return json(await this.punchAnswer(me, body))
        case '/api/friends/punch/wait':
          return json(await this.punchWait(me, body))
        case '/api/friends/pack':
          return json(await this.putPack(me, text))
        case '/api/friends/pack/get':
          return json(await this.getPack(me, body))
        default:
          throw new HttpError(404, 'Нет такого действия')
      }
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status)
      return json({ error: 'Внутренняя ошибка сервера' }, 500)
    }
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

interface DONamespace {
  idFromName(name: string): unknown
  get(id: unknown): { fetch(req: Request): Promise<Response> }
}

/** Управление туннелями через их Durable Object */
export function tunnelControl(ns: DONamespace | undefined): TunnelControl | null {
  if (!ns) return null
  const call = async (hostId: string, action: string, body: unknown) => {
    const res = await ns.get(ns.idFromName(hostId)).fetch(
      new Request(`https://tunnel/internal/${action}`, { method: 'POST', body: JSON.stringify(body) }),
    )
    if (!res.ok) throw new HttpError(502, 'Туннель недоступен')
  }
  return {
    init: (hostId, secretHash) => call(hostId, 'init', { secretHash }),
    allow: (hostId, ticketHash, expires) => call(hostId, 'allow', { ticketHash, expires }),
    close: (hostId) => call(hostId, 'close', {}),
  }
}

/** Внешний релей включён, если заданы адрес (wrangler.toml [vars]) и ключ (wrangler secret) */
export function relayVia(env: { RELAY_URL?: string; RELAY_KEY?: string } | undefined): RelayVia | null {
  const url = env?.RELAY_URL?.trim().replace(/\/+$/, '')
  const key = env?.RELAY_KEY?.trim()
  if (!url || !key || !/^wss?:\/\/[^\s/]+$/.test(url) || key.length < 32) return null
  return { url, key }
}

/**
 * Durable Object хаба. Один экземпляр на весь сервер (idFromName('hub')): единая точка
 * избавляет от гонок при регистрации ников и заявках.
 * Имя класса осталось FriendsHub — так оно привязано в wrangler.toml с первой версии.
 */
export class FriendsHub {
  private hub: Hub

  constructor(state: { storage: StorageLike }, env: { TUNNEL?: DONamespace; RELAY_URL?: string; RELAY_KEY?: string }) {
    this.hub = new Hub(state.storage, tunnelControl(env?.TUNNEL), Date.now, relayVia(env))
  }

  fetch(request: Request): Promise<Response> {
    return this.hub.handle(request)
  }
}
