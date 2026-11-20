import { useStore } from '../store'
import { IconPackage } from './Icons'

/** Модальный прогресс установки модпака */
export function PackProgress() {
  const pack = useStore((s) => s.pack)
  if (!pack) return null
  const pct = pack.total > 0 ? Math.round((pack.done / pack.total) * 100) : 0
  return (
    <div className="modal-backdrop">
      <div className="modal pack-modal" role="dialog" aria-label="Установка модпака">
        <div className="pack-icon">
          <IconPackage size={28} />
        </div>
        <h2>{pack.label.startsWith('Готовим сборку') || pack.label.includes('друга') ? 'Ставим сборку друга' : 'Устанавливаем модпак'}</h2>
        <p className="muted">{pack.label}</p>
        <div className="bar">
          <div style={{ width: `${pct}%` }} />
        </div>
        <span className="muted small">
          {pack.total > 1 ? `${pack.done} из ${pack.total}` : 'Подождите…'}
        </span>
      </div>
    </div>
  )
}
