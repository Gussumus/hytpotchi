/**
 * Пропуска для внешнего релея (сервер в России, см. server/relay).
 *
 * У части провайдеров долгие соединения к Cloudflare «замерзают», поэтому игровой трафик
 * без VPN через туннель на Cloudflare не идёт. Внешний релей держит те же WebSocket-туннели,
 * но не знает аккаунтов: хаб выдаёт подписанные пропуска, релей проверяет подпись общим ключом.
 *
 *   пропуск = "<срок, мс>.<hex HMAC-SHA256(ключ, "<вид>.<hostId>.<срок>")>"
 *   вид: "h" — хозяин мира (control/data), "j" — гость (join)
 */

export type RelayKind = 'h' | 'j'

const enc = new TextEncoder()
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')

async function mac(key: string, kind: RelayKind, hostId: string, exp: number): Promise<string> {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return hex(await crypto.subtle.sign('HMAC', k, enc.encode(`${kind}.${hostId}.${exp}`)))
}

export async function signRelay(key: string, kind: RelayKind, hostId: string, exp: number): Promise<string> {
  return `${exp}.${await mac(key, kind, hostId, exp)}`
}

/** Пропуск подписан этим ключом, для этого мира и вида, и ещё не истёк */
export async function verifyRelay(
  key: string,
  kind: RelayKind,
  hostId: string,
  token: string | null,
  now: number,
): Promise<boolean> {
  const m = token ? /^(\d{1,16})\.([0-9a-f]{64})$/.exec(token) : null
  if (!m) return false
  const exp = Number(m[1])
  if (!(exp > now)) return false
  const expected = await mac(key, kind, hostId, exp)
  // Сравнение без раннего выхода
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ m[2].charCodeAt(i)
  return diff === 0
}
