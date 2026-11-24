import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { activeAccount, useStore } from '../store'
import { api, openExternal } from '../lib/ipc'
import type { CosmeticDef, SkinProfile } from '../lib/types'
import { SkinViewer3D } from '../components/SkinViewer3D'
import { IconCheck, IconCrown, IconExternal, IconRefresh } from '../components/Icons'
import { CosmeticsAdmin } from '../components/CosmeticsAdmin'

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
type Filter = (typeof FILTERS)[number]['id'] | 'admin'

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
  /** Вкладка «Админ» — только если сервер признал аккаунт админом (ADMIN_NICKS) */
  const [isAdmin, setIsAdmin] = useState(false)

  // Надетое: что хотим (уже на экране) и что последним подтвердил сервер.
  // Запросы на сервер идут строго по одному — иначе ответ старого запроса мог прийти последним
  // и вернуть снятую вещь (и на экране, и на сервере).
  const wornRef = useRef<string[]>([])
  const confirmedRef = useRef<string[]>([])
  const syncingRef = useRef(false)
  const setWornBoth = (items: string[]) => {
    wornRef.current = items
    setWorn(items)
  }

  const accountId = account && isHytpotchi ? account.id : null
  useEffect(() => {
    setWornBoth([])
    confirmedRef.current = []
    setOwned([])
    setError(null)
    setPaying(null)
    setIsAdmin(false)
    setFilter((f) => (f === 'admin' ? 'all' : f))
    if (!accountId) return
    let alive = true
    api
      .cosmeticsAdmin(accountId)
      .then((r) => alive && setIsAdmin(!!r.admin))
      .catch(() => alive && setIsAdmin(false))
    api
      .skinProfile(accountId)
      .then((p) => alive && setProfile(p))
      .catch(() => alive && setProfile(null))
    Promise.all([api.cosmeticsCatalog(), api.cosmeticsGet(accountId)])
      .then(([cat, state]) => {
        if (!alive) return
        setCatalog(cat.items)
        setShopOpen(!!cat.shop)
        confirmedRef.current = state.items
        // Пока грузились, игрок уже что-то надел/снял — его выбор важнее
        if (!syncingRef.current) setWornBoth(state.items)
        setOwned(state.owned ?? [])
      })
      .catch((e) => alive && setError((e as Error).message))
    return () => {
      alive = false
    }
  }, [accountId])

  const has = useCallback((c: CosmeticDef) => c.price === 0 || owned.includes(c.id), [owned])
  const current = catalog.find((c) => c.id === selected) ?? null
  /** Спорят ли два предмета за одно место на теле */
  const clashes = useCallback(
    (a: string, b: string) => {
      const sa = catalog.find((c) => c.id === a)?.spot
      return !!sa && a !== b && sa === catalog.find((c) => c.id === b)?.spot
    },
    [catalog],
  )

  const shown = useMemo(
    () =>
      catalog.filter((c) =>
        filter === 'all' ? true : filter === 'mine' ? owned.includes(c.id) || worn.includes(c.id) : c.slot === filter,
      ),
    [catalog, filter, owned, worn],
  )

  // На модели — надетое и примерка (выбранное, но ещё не купленное). Своё на модели — только если надето,
  // иначе «Снять» у выбранной вещи ничего не меняло на экране.
  const onModel = useMemo(() => {
    const ids = new Set(worn)
    if (current && !has(current)) {
      // Примерка — как будто надели: то, что на том же месте, на время убираем
      for (const id of worn) if (clashes(current.id, id)) ids.delete(id)
      ids.add(current.id)
    }
    return catalog.filter((c) => ids.has(c.id))
  }, [catalog, worn, current, has, clashes])

  /** Отправить на сервер последний выбор; пока запрос идёт, новые клики копятся и уйдут следующим */
  async function sync() {
    if (!accountId || syncingRef.current) return
    syncingRef.current = true
    try {
      for (;;) {
        const want = wornRef.current
        let state
        try {
          state = await api.cosmeticsSet(accountId, want)
        } catch (e) {
          setWornBoth(confirmedRef.current)
          toast('error', (e as Error).message)
          return
        }
        confirmedRef.current = state.items
        setOwned((prev) => state.owned ?? prev)
        if (wornRef.current === want) {
          setWornBoth(state.items)
          return
        }
      }
    } finally {
      syncingRef.current = false
    }
  }

  function wear(id: string, on: boolean) {
    const cur = wornRef.current
    // Новый предмет снимает то, что занимает то же место (шляпа — шляпу, хвост — хвост)
    const kept = on ? cur.filter((x) => x !== id && !clashes(id, x)) : cur.filter((x) => x !== id)
    const next = on ? [...kept, id] : kept
    if (next.length > 10) {
      toast('error', 'Можно надеть не больше 10 предметов')
      return
    }
    setWornBoth(next) // сразу на модели, сервер — следом
    void sync()
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
        wear(p.item, true)
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
  /** Что снимется, если надеть выбранное */
  const replaces = current ? catalog.filter((c) => worn.includes(c.id) && clashes(current.id, c.id)) : []

  return (
    <div className="screen">
      <div className="page-head">
        <div>
          <h1>Косметика</h1>
          <p className="muted">
            Видна игрокам Hytpotchi в сборках Fabric и Quilt на 1.16.5, 1.18.2, 1.19.2, 1.20.1, 1.21.1, 1.21.4 и 26.3,
            а также Forge 1.20.1 — мод лаунчер ставит сам
          </p>
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
            {current && !has(current) && <span className="try-on-badge">Примерка: {current.name}</span>}
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
              {!wearing && replaces.length > 0 && (
                <span className="muted small">Вместо: {replaces.map((c) => c.name).join(', ')} — на одном месте</span>
              )}
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
            {isAdmin && (
              <button
                role="tab"
                aria-selected={filter === 'admin'}
                className={`chip ${filter === 'admin' ? 'on' : ''}`}
                onClick={() => setFilter('admin')}
              >
                Админ
              </button>
            )}
          </div>
          {filter === 'admin' && isAdmin ? (
            <CosmeticsAdmin accountId={account.id} catalog={catalog} />
          ) : (
          <>
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
          </>
          )}
        </section>
      </div>
    </div>
  )
}
