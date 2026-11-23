import { useState } from 'react'
import { useStore } from '../store'
import { api } from '../lib/ipc'
import type { CosmeticDef } from '../lib/types'

/** Админка косметики: найти игрока по нику и выдать / забрать платные предметы */
export function CosmeticsAdmin({ accountId, catalog }: { accountId: string; catalog: CosmeticDef[] }) {
  const toast = useStore((s) => s.toast)
  const [query, setQuery] = useState('')
  const [nick, setNick] = useState<string | null>(null)
  const [owned, setOwned] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const paid = catalog.filter((c) => c.price > 0)

  async function run(grant: string[] = [], revoke: string[] = [], who = nick) {
    if (!who) return
    setBusy(true)
    try {
      const r = await api.cosmeticsAdmin(accountId, who, grant, revoke)
      setNick(r.nick ?? who)
      setOwned(r.owned ?? [])
      if (grant.length || revoke.length) toast('success', `Сохранено: у ${r.nick ?? who} ${r.owned?.length ?? 0} платных вещей`)
    } catch (e) {
      toast('error', (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="admin-panel">
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault()
          const n = query.trim()
          if (n) void run([], [], n)
        }}
      >
        <input
          placeholder="Ник игрока"
          value={query}
          maxLength={16}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Ник игрока"
        />
        <button className="btn primary sm" type="submit" disabled={busy || !query.trim()}>
          Найти
        </button>
      </form>

      {nick && (
        <>
          <div className="row admin-head">
            <strong>{nick}</strong>
            <span className="muted small">
              {owned.length} из {paid.length} платных
            </span>
            <span className="spacer" />
            <button
              className="btn ghost sm"
              disabled={busy || owned.length === paid.length}
              onClick={() => run(paid.map((c) => c.id))}
            >
              Выдать всё
            </button>
            <button className="btn ghost sm" disabled={busy || owned.length === 0} onClick={() => run([], owned)}>
              Забрать всё
            </button>
          </div>
          <p className="muted small">Нажмите на предмет, чтобы выдать или забрать его</p>
          <div className="shop-grid">
            {paid.map((c) => {
              const has = owned.includes(c.id)
              return (
                <button
                  key={c.id}
                  className={`shop-card ${has ? 'on' : ''}`}
                  aria-pressed={has}
                  disabled={busy}
                  onClick={() => (has ? run([], [c.id]) : run([c.id]))}
                >
                  <span className="shop-card-name">{c.name}</span>
                  <span className={`shop-card-price ${has ? 'owned' : ''}`}>{has ? 'Выдано' : `${c.price} ₽`}</span>
                </button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
