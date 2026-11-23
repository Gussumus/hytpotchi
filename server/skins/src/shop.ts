/**
 * Магазин косметики: покупка предмета навсегда через ЮKassa.
 *
 *   POST /api/shop/buy {nick, item}     → {paymentId, url}   владелец ника; url — страница оплаты ЮKassa
 *   GET  /api/shop/payment/<id>         → {status, owned}    владелец ника; заодно перепроверяет платёж
 *   POST /api/shop/yookassa             ← уведомления ЮKassa (payment.succeeded / payment.canceled)
 *   GET  /shop/return                   ← сюда ЮKassa возвращает игрока после оплаты
 *
 * Уведомлениям не верим: по id платежа сервер сам спрашивает ЮKassa и выдаёт предмет, только если
 * платёж оплачен, сумма — ровно цена предмета, а ник и предмет совпадают с тем, что мы сами создали.
 * Выдача идемпотентна: повторное уведомление ничего не меняет.
 *
 * Ключи магазина — секретами Worker'а (без них магазин выключен, бесплатные предметы работают):
 *   npx wrangler secret put YOOKASSA_SHOP_ID
 *   npx wrangler secret put YOOKASSA_SECRET_KEY
 *
 * KV: own:<ник> — купленные предметы, pay:<id платежа> — наш платёж (ник, предмет, сумма, статус).
 */
import { CATALOG } from './cosmetics.ts'

export interface ShopEnv {
  SKINS: KVNamespace
  YOOKASSA_SHOP_ID?: string
  YOOKASSA_SECRET_KEY?: string
}

export const YOOKASSA_API = 'https://api.yookassa.ru/v3'

interface Payment {
  nick: string
  item: string
  /** Сумма в рублях, строкой с копейками: «149.00» */
  amount: string
  status: 'pending' | 'succeeded' | 'canceled'
  created: string
}

/** Ответ ЮKassa о платеже (нужные нам поля) */
interface YooPayment {
  id: string
  status: 'pending' | 'waiting_for_capture' | 'succeeded' | 'canceled'
  paid: boolean
  amount: { value: string; currency: string }
  metadata?: Record<string, string>
  confirmation?: { type: string; confirmation_url?: string }
}

export class ShopError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

export const shopEnabled = (env: ShopEnv) => !!(env.YOOKASSA_SHOP_ID && env.YOOKASSA_SECRET_KEY)

/** Цена предмета в рублях (0 — бесплатный), undefined — такого нет */
export function priceOf(id: string): number | undefined {
  return CATALOG.find((c) => c.id === id)?.price
}

const rub = (price: number) => price.toFixed(2)

/** Купленные игроком предметы */
export async function owned(env: ShopEnv, nick: string): Promise<string[]> {
  const raw = await env.SKINS.get(`own:${nick.toLowerCase()}`)
  return raw ? (JSON.parse(raw) as string[]) : []
}

/** Заменить список купленного целиком (админка) */
export async function setOwned(env: ShopEnv, nick: string, list: string[]): Promise<void> {
  await env.SKINS.put(`own:${nick.toLowerCase()}`, JSON.stringify(list))
}

async function grant(env: ShopEnv, nick: string, item: string): Promise<string[]> {
  const list = await owned(env, nick)
  if (!list.includes(item)) {
    list.push(item)
    await env.SKINS.put(`own:${nick.toLowerCase()}`, JSON.stringify(list))
  }
  return list
}

async function yookassa(env: ShopEnv, path: string, init: RequestInit = {}): Promise<YooPayment> {
  const auth = btoa(`${env.YOOKASSA_SHOP_ID}:${env.YOOKASSA_SECRET_KEY}`)
  const res = await fetch(`${YOOKASSA_API}${path}`, {
    ...init,
    headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json', ...init.headers },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    console.error('ЮKassa', res.status, text.slice(0, 300))
    throw new ShopError('Платёжный сервис не ответил — попробуйте позже', 502)
  }
  return (await res.json()) as YooPayment
}

/** Создать платёж за предмет. Возвращает страницу оплаты ЮKassa */
export async function createPayment(env: ShopEnv, nick: string, item: string, returnUrl: string) {
  if (!shopEnabled(env)) throw new ShopError('Магазин пока не работает', 503)
  const price = priceOf(item)
  if (price === undefined) throw new ShopError('Такого предмета нет', 404)
  if (price <= 0) throw new ShopError('Этот предмет бесплатный', 400)
  if ((await owned(env, nick)).includes(item)) throw new ShopError('Этот предмет уже куплен', 409)
  const name = CATALOG.find((c) => c.id === item)!.name
  const amount = rub(price)
  const pay = await yookassa(env, '/payments', {
    method: 'POST',
    headers: { 'idempotence-key': crypto.randomUUID() },
    body: JSON.stringify({
      amount: { value: amount, currency: 'RUB' },
      capture: true,
      confirmation: { type: 'redirect', return_url: returnUrl },
      description: `Косметика Hytpotchi «${name}» для ${nick}`.slice(0, 128),
      metadata: { nick: nick.toLowerCase(), item },
    }),
  })
  const url = pay.confirmation?.confirmation_url
  if (!url) throw new ShopError('Платёжный сервис не дал ссылку на оплату', 502)
  const record: Payment = { nick: nick.toLowerCase(), item, amount, status: 'pending', created: new Date().toISOString() }
  await env.SKINS.put(`pay:${pay.id}`, JSON.stringify(record))
  return { paymentId: pay.id, url }
}

/** Наш платёж по id (ник владельца, предмет, статус) */
export async function paymentRecord(env: ShopEnv, id: string): Promise<Payment | null> {
  if (!/^[0-9a-f-]{20,64}$/.test(id)) return null
  const raw = await env.SKINS.get(`pay:${id}`)
  return raw ? (JSON.parse(raw) as Payment) : null
}

/**
 * Перепроверить платёж у ЮKassa и, если оплачен, выдать предмет. Вызывается из уведомления
 * и когда лаунчер спрашивает статус (если уведомление потерялось).
 */
export async function settle(env: ShopEnv, id: string): Promise<Payment['status'] | null> {
  const record = await paymentRecord(env, id)
  if (!record) return null
  if (record.status !== 'pending' || !shopEnabled(env)) return record.status
  const pay = await yookassa(env, `/payments/${encodeURIComponent(id)}`)
  if (pay.id !== id) return record.status
  if (pay.status === 'canceled') {
    record.status = 'canceled'
  } else if (
    pay.status === 'succeeded' &&
    pay.paid &&
    pay.amount.currency === 'RUB' &&
    pay.amount.value === record.amount &&
    pay.metadata?.nick === record.nick &&
    pay.metadata?.item === record.item
  ) {
    await grant(env, record.nick, record.item)
    record.status = 'succeeded'
  } else {
    return record.status
  }
  await env.SKINS.put(`pay:${id}`, JSON.stringify(record))
  return record.status
}

/** Уведомление от ЮKassa: берём из него только id платежа */
export async function handleNotification(env: ShopEnv, request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { object?: { id?: unknown } } | null
  const id = typeof body?.object?.id === 'string' ? body.object.id : ''
  try {
    await settle(env, id)
  } catch (e) {
    // 5xx — ЮKassa пришлёт уведомление ещё раз
    console.error('Уведомление ЮKassa', id, e)
    return new Response('retry', { status: 500 })
  }
  return new Response('ok')
}

/** Страница, куда ЮKassa возвращает игрока после оплаты */
export function returnPage(): Response {
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Hytpotchi — оплата</title><style>body{font:16px system-ui,sans-serif;background:#111418;color:#e8eaed;display:grid;place-items:center;min-height:100vh;margin:0}
main{max-width:420px;padding:24px;text-align:center}h1{font-size:22px;font-weight:600}p{color:#9aa0a6;line-height:1.5}</style></head>
<body><main><h1>Спасибо!</h1><p>Если оплата прошла, предмет появится в лаунчере Hytpotchi через несколько секунд — во вкладке «Косметика». Это окно можно закрыть.</p></main></body></html>`
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
}
