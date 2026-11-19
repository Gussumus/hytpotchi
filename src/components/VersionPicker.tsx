import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { api } from '../lib/ipc'
import { formatDate } from '../lib/format'
import type { LocalContent, VersionChoice } from '../lib/types'
import { Modal } from './Modal'
import { IconCheck } from './Icons'

const TYPE_LABEL: Record<string, string> = { release: 'Релиз', beta: 'Бета', alpha: 'Альфа' }

/** Выбор версии мода: откат беты, обновление, ручной подбор под другой мод */
export function VersionPicker({
  instanceId,
  item,
  onClose,
  onChanged,
}: {
  instanceId: string
  item: LocalContent
  onClose: () => void
  onChanged: () => void
}) {
  const toast = useStore((s) => s.toast)
  const [versions, setVersions] = useState<VersionChoice[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [onlyStable, setOnlyStable] = useState(false)

  useEffect(() => {
    if (!item.projectId) return
    api
      .modVersions(item.projectId, instanceId)
      .then(setVersions)
      .catch((e) => {
        toast('error', (e as Error).message)
        setVersions([])
      })
  }, [item.projectId, instanceId, toast])

  async function choose(v: VersionChoice) {
    setBusy(v.id)
    try {
      await api.installVersion(v.id, instanceId)
      toast('success', `${item.title}: установлена ${v.number}`)
      onChanged()
      onClose()
    } catch (e) {
      toast('error', (e as Error).message)
      setBusy(null)
    }
  }

  const shown = (versions ?? []).filter((v) => !onlyStable || v.versionType === 'release')

  return (
    <Modal title={`Версия: ${item.title}`} subtitle="Только версии, совместимые с этой сборкой" onClose={onClose} width={560}>
      <label className="check" style={{ marginBottom: 12 }}>
        <input type="checkbox" checked={onlyStable} onChange={(e) => setOnlyStable(e.target.checked)} />
        Только стабильные
      </label>
      <div className="version-choices">
        {!versions && (
          <div className="version-loading">
            <span className="spinner" /> Загружаем версии…
          </div>
        )}
        {versions && shown.length === 0 && <p className="muted pad">Подходящих версий нет</p>}
        {shown.map((v) => (
          <div key={v.id} className={`version-choice ${v.current ? 'current' : ''}`}>
            <div className="project-text">
              <div className="project-title">
                <strong>{v.number}</strong>
                <span className={`type-badge ${v.versionType}`}>{TYPE_LABEL[v.versionType] ?? v.versionType}</span>
                {v.recommended && <span className="type-badge rec">Рекомендуем</span>}
              </div>
              <span className="muted small">{formatDate(v.date)}</span>
            </div>
            {v.current ? (
              <span className="tag strong">
                <IconCheck size={13} /> Сейчас
              </span>
            ) : (
              <button className={`btn sm ${v.recommended ? 'primary' : 'ghost'}`} disabled={!!busy} onClick={() => choose(v)}>
                {busy === v.id ? <span className="spinner xs" /> : 'Поставить'}
              </button>
            )}
          </div>
        ))}
      </div>
    </Modal>
  )
}
