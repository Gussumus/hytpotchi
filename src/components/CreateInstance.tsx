import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'
import { api } from '../lib/ipc'
import { ACCENTS, guessJava } from '../lib/format'
import type { VersionInfo } from '../lib/types'
import { Modal } from './Modal'
import { MemorySlider } from './MemorySlider'
import { IconCoffee, IconSearch } from './Icons'
import { Cover } from './Cover'

type Filter = 'release' | 'snapshot' | 'old'
type LoaderChoice = 'vanilla' | 'fabric' | 'forge' | 'neoforge' | 'quilt'

const LOADERS: { id: LoaderChoice; name: string; hint: string }[] = [
  { id: 'vanilla', name: 'Vanilla', hint: 'Чистая игра' },
  { id: 'fabric', name: 'Fabric', hint: 'Лёгкий, быстрый' },
  { id: 'forge', name: 'Forge', hint: 'Классика, 1.1+' },
  { id: 'neoforge', name: 'NeoForge', hint: 'Новый Forge, 1.20.1+' },
  { id: 'quilt', name: 'Quilt', hint: 'Как Fabric' },
]

export function CreateInstance() {
  const setModal = useStore((s) => s.setModal)
  const loadVersions = useStore((s) => s.loadVersions)
  const versions = useStore((s) => s.versions)
  const system = useStore((s) => s.system)
  const refresh = useStore((s) => s.refreshInstances)
  const select = useStore((s) => s.select)
  const toast = useStore((s) => s.toast)

  const [name, setName] = useState('')
  const [version, setVersion] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('release')
  const [query, setQuery] = useState('')
  const [loader, setLoader] = useState<LoaderChoice>('fabric')
  const [memory, setMemory] = useState(system?.recommendedMemoryMb ?? 4096)
  const [accent, setAccent] = useState(() => ACCENTS[Math.floor(Math.random() * ACCENTS.length)])
  const [busy, setBusy] = useState(false)
  const [seed] = useState(() => Math.random().toString(36).slice(2))

  useEffect(() => {
    loadVersions().then((v) => v && setVersion((cur) => cur ?? v.latestRelease))
  }, [loadVersions])

  const list = useMemo(() => {
    const all = versions?.versions ?? []
    const byType = (v: VersionInfo) =>
      filter === 'release' ? v.type === 'release' : filter === 'snapshot' ? v.type === 'snapshot' : v.type.startsWith('old')
    const q = query.trim().toLowerCase()
    return all.filter((v) => byType(v) && (!q || v.id.toLowerCase().includes(q)))
  }, [versions, filter, query])

  const java = version ? guessJava(version) : null
  const finalName = name.trim() || (version ? `${loader === 'vanilla' ? 'Minecraft' : LOADERS.find((l) => l.id === loader)!.name} ${version}` : '')

  async function submit() {
    if (!version) return
    setBusy(true)
    try {
      const inst = await api.instanceCreate({
        name: finalName,
        gameVersion: version,
        loader: loader === 'vanilla' ? null : loader,
        memoryMb: memory,
        accent,
      })
      await refresh()
      select(inst.id)
      setModal(null)
      toast('success', `Сборка «${inst.name}» создана — жмите «Играть»`)
    } catch (e) {
      toast('error', (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Новая сборка"
      subtitle="Игра, загрузчик и Java скачаются автоматически при первом запуске"
      onClose={() => setModal(null)}
      width={760}
      footer={
        <>
          <div className="foot-note">
            <IconCoffee size={16} />
            {java ? `Java ${java} скачается автоматически` : 'Нужная Java подберётся автоматически'}
            {(loader === 'forge' || loader === 'neoforge') && ' · первая установка займёт пару минут'}
          </div>
          <button className="btn ghost" onClick={() => setModal(null)}>
            Отмена
          </button>
          <button className="btn primary" disabled={!version || busy} onClick={submit}>
            {busy ? 'Создаём…' : 'Создать сборку'}
          </button>
        </>
      }
    >
      <div className="create-grid">
        <div className="create-left">
          <div className="create-preview" style={{ ['--accent' as string]: accent }}>
            <Cover seed={seed} accent={accent} />
            <div className="create-preview-text">
              <strong>{finalName || 'Новая сборка'}</strong>
              <span>
                {LOADERS.find((l) => l.id === loader)!.name} · {version ?? '—'}
              </span>
            </div>
          </div>

          <label className="field">
            <span>Название</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder={finalName || 'Моя сборка'} maxLength={48} />
          </label>

          <div className="field">
            <span>Загрузчик</span>
            <div className="loader-pick">
              {LOADERS.map((l) => (
                <button key={l.id} className={`loader-card ${loader === l.id ? 'on' : ''}`} onClick={() => setLoader(l.id)}>
                  <strong>{l.name}</strong>
                  <span>{l.hint}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <span>Цвет</span>
            <div className="swatches">
              {ACCENTS.map((c) => (
                <button
                  key={c}
                  className={`swatch ${accent === c ? 'on' : ''}`}
                  style={{ background: c }}
                  onClick={() => setAccent(c)}
                  aria-label={`Цвет ${c}`}
                />
              ))}
            </div>
          </div>

          <div className="field">
            <span>Оперативная память</span>
            <MemorySlider value={memory} onChange={setMemory} />
          </div>
        </div>

        <div className="create-right">
          <div className="field">
            <span>Версия Minecraft</span>
            <div className="segmented">
              {(
                [
                  ['release', 'Релизы'],
                  ['snapshot', 'Снапшоты'],
                  ['old', 'Старые'],
                ] as const
              ).map(([id, label]) => (
                <button key={id} className={filter === id ? 'on' : ''} onClick={() => setFilter(id)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="search-input">
            <IconSearch size={15} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Найти версию" />
          </div>
          <div className="version-list">
            {!versions && <div className="version-loading"><span className="spinner" /> Загружаем список версий…</div>}
            {list.map((v) => (
              <button key={v.id} className={`version-item ${version === v.id ? 'on' : ''}`} onClick={() => setVersion(v.id)}>
                <span>{v.id}</span>
                {v.id === versions?.latestRelease && <em>новая</em>}
                <small>{new Date(v.releaseTime).toLocaleDateString('ru-RU', { month: 'short', year: 'numeric' })}</small>
              </button>
            ))}
            {versions && list.length === 0 && <p className="muted pad">Ничего не нашлось</p>}
          </div>
        </div>
      </div>
    </Modal>
  )
}
