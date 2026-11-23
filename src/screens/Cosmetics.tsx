import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { activeAccount, useStore } from '../store'
import { api, openExternal } from '../lib/ipc'
import type { CosmeticDef, SkinProfile } from '../lib/types'
import { SkinViewer3D } from '../components/SkinViewer3D'
import { IconCheck, IconCrown, IconExternal, IconRefresh } from '../components/Icons'

/** Фильтры витрины: по месту на персонаже и «моё» */
const FILTERS = [
  { id: 'all', label: 'Все' },
  { id: 'head', label: 'Голова' },
  { id: 'face', label: 'Лицо' },
  { id: 'float', label: 'Над головой' },
  { id: 'back', label: 'Спина' },
  { id: 'tail', label: 'Хвосты' },
  { id: 'mine', label: 'Моё' },
] as const
type Filter = (typeof FILTERS)[number]['id']

/** Сколько ждать оплату, опрашивая сервер (страница ЮKassa живёт около 10 минут) */
const PAY_WAIT_MS = 15 * 60_000
const PAY_POLL_MS = 3000

/** Цвета карточки — из деталей модели (у 3D-моделей — нейтральные) */
function swatch(c: CosmeticDef): string[] {
  const colors = [...new Set(c.parts.map((p) => p.color))].slice(0, 4)
  return colors.length ? colors : ['#8a8f98']
}

export function Cosmetics() {
  const account = useStore(activeAccount)
  const toast = useStore((s) => s.toast)
  const setScreen = useStore((s) => s.setScreen)
  const isHytpotchi = account?.kind === 'hytpotchi' || account?.kind === 'offline'

  const [catalog, setCatalog] = useState<CosmeticDef[]>([])
  const [shopOpen, setShopOpen] = useState(false)
  const [worn, setWorn] = useState<string[]>([])
  const [owned, setOwned] = useState<string[]>([])
  const [profile, setProfile] = useState<SkinProfile | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [selected, setSelected] = useState<string | null>(null)
  /** Платёж, который ждём: id и предмет */
  const [paying, setPaying] = useState<{ id: string; item: string; url: string; since: number } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setWorn([])
    setOwned([])
    setError(null)
    setPaying(null)
    if (!account || !isHytpotchi) return
    api.skinProfile(account.id).then(setProfile).catch(() => setProfile(null))
    Promise.all([api.cosmeticsCatalog(), api.cosmeticsGet(account.id)])
      .then(([cat, state]) => {
        setCatalog(cat.items)
        setShopOpen(!!cat.shop)
        setWorn(state.items)
        setOwned(state.owned ?? [])
      })
      .catch((e) => setError((e as Error).message))
  }, [account, isHytpotchi])

  const has = useCallback((c: CosmeticDef) => c.price === 0 || owned.includes(c.id), [owned])
  const current = catalog.find((c) => c.id === selected) ?? null

  const shown = useMemo(
    () =>
      catalog.filter((c) =>
        filter === 'all' ? true : filter === 'mine' ? owned.includes(c.id) || worn.includes(c.id) : c.slot === filter,
      ),
    [catalog, filter, owned, worn],
  )

  // На модели — надетое и примеряемое (выбранное, даже если не куплено)
  const onModel = useMemo(() => {
    const ids = new Set(worn)
    if (current) ids.add(current.id)
    return catalog.filter((c) => ids.has(c.id))
  }, [catalog, worn, current])

  async function wear(id: string, on: boolean) {
    if (!account) return
    const before = worn
    const next = on ? [...worn.filter((x) => x !== id), id] : worn.filter((x) => x !== id)
    if (next.length > 10) {
      toast('error', 'Можно надеть не больше 10 предметов')
      return
    }
    setWorn(next) // сразу на модели, сервер — следом
    try {
      const state = await api.cosmeticsSet(account.id, next)
      setWorn(state.items)
      setOwned(state.owned ?? owned)
    } catch (e) {
      setWorn(before)
      toast('error', (e as Error).message)
    }
  }

  async function buy(c: CosmeticDef) {
    if (!account) return
    setBusy(true)
    try {
      const { paymentId, url } = await api.shopBuy(account.id, c.id)
      setPaying({ id: paymentId, item: c.id, url, since: Date.now() })
      toast('info', 'Открыли оплату в браузере — после оплаты предмет появится здесь сам')
    } catch (e) {
      toast('error', (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  // Ждём оплату: спрашиваем сервер, пока платёж не завершится (или пока не надоест)
  const payingRef = useRef(paying)
  payingRef.current = paying
  const check = useCallback(async () => {
    const p = payingRef.current
    if (!p || !account) return
    try {
      const r = await api.shopPayment(account.id, p.id)
      setOwned(r.owned ?? [])
      if (r.status === 'succeeded') {
        setPaying(null)
        const name = catalog.find((c) => c.id === p.item)?.name ?? 'Предмет'
        toast('success', `${name} — теперь ваш навсегда`)
        void wear(p.item, true)
      } else if (r.status === 'canceled') {
        setPaying(null)
        toast('error', 'Оплата отменена')
      } else if (Date.now() - p.since > PAY_WAIT_MS) {
        setPaying(null)
      }
    } catch {
      // Сеть моргнула — спросим ещё раз
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- wear читает свежее состояние сам
  }, [account, catalog, toast])

  useEffect(() => {
    if (!paying) return
    const t = setInterval(check, PAY_POLL_MS)
    return () => clearInterval(t)
  }, [paying, check])

  if (!account || !isHytpotchi) {
    return (
      <div className="screen">
        <div className="page-head">
          <div>
            <h1>Косметика</h1>
            <p className="muted">Шапки, крылья, хвосты и другое — видно всем в игре</p>
          </div>
        </div>
        <div className="info-box">
          Косметика — для аккаунтов Hytpotchi.{' '}
          <button className="btn ghost sm" onClick={() => setScreen('accounts')}>
            Войти в аккаунт
          </button>
        </div>
      </div>
    )
  }

  const owns = current ? has(current) : false
  const wearing = current ? worn.includes(current.id) : false

  return (
    <div className="screen">
      <div className="page-head">
        <div>
          <h1>Косметика</h1>
          <p className="muted">Видна всем игрокам Hytpotchi в сборках Fabric 26.3 — мод лаунчер ставит сам</p>
        </div>
      </div>

      <div className="shop-layout">
        <section className="skin-stage shop-stage">
          <div className="skin-stage-preview">
            <SkinViewer3D
              src={profile?.skin ?? null}
              slim={profile?.variant === 'slim'}
              cosmetics={onModel}
              nameTag={account.username}
              height={420}
            />
            {current && !wearing && <span className="try-on-badge">Примерка: {current.name}</span>}
            <span className="skin3d-hint">Тяните, чтобы повернуть</span>
          </div>

          {current ? (
            <div className="shop-detail">
              <div className="shop-detail-head">
                <h2>{current.name}</h2>
                <span className={`shop-price ${owns ? 'owned' : ''}`}>
                  {current.price === 0 ? 'Бесплатно' : owned.includes(current.id) ? 'Куплено' : `${current.price} ₽`}
                </span>
              </div>
              {owns ? (
                <button className={`btn ${wearing ? 'ghost' : 'primary'}`} onClick={() => wear(current.id, !wearing)}>
                  {wearing ? 'Снять' : 'Надеть'}
                </button>
              ) : paying?.item === current.id ? (
                <div className="shop-paying">
                  <span className="muted small">Ждём оплату в браузере…</span>
                  <div className="row">
                    <button className="btn ghost sm" onClick={() => openExternal(paying.url)}>
                      <IconExternal size={14} /> Открыть оплату ещё раз
                    </button>
                    <button className="btn ghost sm" onClick={check}>
                      <IconRefresh size={14} /> Проверить
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  className="btn primary"
                  disabled={busy || !shopOpen || paying !== null}
                  onClick={() => buy(current)}
                  title={shopOpen ? 'Оплата картой или через СБП (ЮKassa)' : 'Магазин скоро откроется'}
                >
                  <IconCrown size={16} /> {shopOpen ? `Купить за ${current.price} ₽` : 'Скоро в продаже'}
                </button>
              )}
              {!owns && <span className="muted small">Покупка — навсегда, на аккаунт {account.username}</span>}
              {current.credit && (
                <span className="muted small shop-credit">
                  3D-модель «{current.credit.title ?? current.name}» — {current.credit.author}, {current.credit.license}
                </span>
              )}
            </div>
          ) : (
            <p className="muted small">Выберите предмет, чтобы примерить</p>
          )}
        </section>

        <section className="shop-catalog">
          <div className="chips" role="tablist" aria-label="Фильтр">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                role="tab"
                aria-selected={filter === f.id}
                className={`chip ${filter === f.id ? 'on' : ''}`}
                onClick={() => setFilter(f.id)}
              >
                {f.label}
              </button>
            ))}
          </div>
          {error && <div className="shared-status error">{error}</div>}
          {!error && shown.length === 0 && (
            <p className="muted small">{filter === 'mine' ? 'Тут появится купленное и надетое' : 'Пусто'}</p>
          )}
          <div className="shop-grid">
            {shown.map((c) => {
              const on = worn.includes(c.id)
              return (
                <button
                  key={c.id}
                  className={`shop-card ${selected === c.id ? 'selected' : ''} ${on ? 'on' : ''}`}
                  aria-pressed={selected === c.id}
                  onClick={() => setSelected(selected === c.id ? null : c.id)}
                  onDoubleClick={() => has(c) && wear(c.id, !on)}
                >
                  <span className="shop-swatch" aria-hidden>
                    {c.meshes?.length ? <span className="shop-3d">3D</span> : null}
                    {swatch(c).map((col) => (
                      <i key={col} style={{ background: col }} />
                    ))}
                  </span>
                  <span className="shop-card-name">{c.name}</span>
                  <span className={`shop-card-price ${has(c) ? 'owned' : ''}`}>
                    {c.price === 0 ? 'Бесплатно' : owned.includes(c.id) ? 'Куплено' : `${c.price} ₽`}
                  </span>
                  {on && (
                    <span className="shop-worn" title="Надето">
                      <IconCheck size={14} />
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        </section>
      </div>
    </div>
  )
}
