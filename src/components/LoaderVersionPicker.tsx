import { useEffect, useState } from 'react'
import { api } from '../lib/ipc'
import type { LoaderVersion } from '../lib/types'

const TITLES: Record<string, string> = { forge: 'Forge', neoforge: 'NeoForge', fabric: 'Fabric', quilt: 'Quilt' }

/**
 * Версия загрузчика: «Рекомендуемая» (лаунчер подберёт сам при запуске) или конкретная сборка.
 * onAvailable(false) — у загрузчика нет ни одной версии под эту версию игры.
 */
export function LoaderVersionPicker({
  loader,
  gameVersion,
  value,
  onChange,
  onAvailable,
  installed,
}: {
  loader: string
  gameVersion: string
  /** "" — рекомендуемая */
  value: string
  onChange: (v: string) => void
  onAvailable?: (ok: boolean) => void
  /** Какая версия стоит сейчас (в настройках сборки) */
  installed?: string | null
}) {
  const [list, setList] = useState<LoaderVersion[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [betas, setBetas] = useState(false)

  useEffect(() => {
    let alive = true
    setList(null)
    setFailed(false)
    api
      .loaderVersions(loader, gameVersion)
      .then((l) => {
        if (!alive) return
        setList(l)
        onAvailable?.(l.length > 0)
      })
      .catch(() => {
        if (!alive) return
        // Нет сети — не мешаем: при запуске поставится рекомендуемая
        setFailed(true)
        setList([])
        onAvailable?.(true)
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onAvailable от родителя, его смена не повод перезапрашивать
  }, [loader, gameVersion])

  const title = TITLES[loader] ?? loader
  const recommended = list?.find((v) => v.recommended)
  const hasBetas = !!list?.some((v) => !v.stable)
  const shown = (list ?? []).filter((v) => betas || v.stable || v.version === value)

  return (
    <div className="field">
      <span>Версия {title}</span>
      <select
        value={value}
        disabled={list === null || (!failed && list.length === 0)}
        onChange={(e) => onChange(e.target.value)}
        aria-label={`Версия ${title}`}
      >
        {list === null ? (
          <option value={value}>Загружаем версии…</option>
        ) : (
          <>
            <option value="">Рекомендуемая{recommended ? ` (${recommended.version})` : ''}</option>
            {shown.map((v) => (
              <option key={v.version} value={v.version}>
                {v.version}
                {v.recommended ? ' — рекомендуемая' : ''}
                {v.stable ? '' : ' · бета'}
              </option>
            ))}
          </>
        )}
      </select>
      {list !== null && !failed && list.length === 0 && (
        <small className="warn small">
          {title} не поддерживает Minecraft {gameVersion} — выберите другую версию игры или загрузчик
        </small>
      )}
      {failed && <small className="muted small">Список версий недоступен — при запуске поставится рекомендуемая</small>}
      {list !== null && list.length > 0 && (
        <small className="muted small">
          {installed ? `Сейчас установлена ${installed}. ` : ''}
          {value ? 'Эта версия останется, пока вы её не смените.' : 'Лаунчер сам выберет рекомендуемую версию.'}
          {hasBetas && (
            <>
              {' '}
              <label className="inline-check">
                <input type="checkbox" checked={betas} onChange={(e) => setBetas(e.target.checked)} /> показать бета-версии
              </label>
            </>
          )}
        </small>
      )}
    </div>
  )
}
