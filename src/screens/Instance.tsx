import { useCallback, useEffect, useState } from 'react'
import { selectedInstance, useStore } from '../store'
import { api, fileSrc, isTauri } from '../lib/ipc'
import { formatMemory, formatPlaytime, formatSize, guessJava, loaderName, timeAgo } from '../lib/format'
import type { Instance as InstanceT, LocalContent, Screenshot, WorldInfo } from '../lib/types'
import { InstanceArt } from '../components/InstanceArt'
import { PlayButton } from '../components/PlayButton'
import { Console } from '../components/Console'
import { InstalledList } from './Content'
import { ServersTab, UpdatesPanel } from '../components/InstanceExtras'
import {
  IconAlert,
  IconArchive,
  IconClock,
  IconCoffee,
  IconFolder,
  IconGlobe,
  IconImage,
  IconPuzzle,
  IconSearch,
  IconServer,
  IconSliders,
  IconTerminal,
  IconTrash,
} from '../components/Icons'

function Hero({ inst }: { inst: InstanceT }) {
  const setModal = useStore((s) => s.setModal)
  const error = useStore((s) => s.errors[inst.id])
  const hint = useStore((s) => s.hints[inst.id])
  const setTab = useStore((s) => s.setInstanceTab)
  const accent = inst.accent ?? '#3ddc84'
  const java = guessJava(inst.gameVersion)

  return (
    <section className="hero" style={{ ['--accent' as string]: accent }}>
      <div className="hero-art">
        <InstanceArt inst={inst} cols={60} rows={22} />
      </div>
      <div className="hero-shade" />
      <div className="hero-content">
        <div className="hero-tags">
          <span className="tag strong">
            {loaderName(inst.loader)}
            {inst.loaderVersion ? ` ${inst.loaderVersion}` : ''}
          </span>
          <span className="tag">Minecraft {inst.gameVersion}</span>
          <span className="tag">
            <IconCoffee size={13} /> Java {java ?? 'авто'}
          </span>
          <span className="tag">{formatMemory(inst.memoryMb)}</span>
        </div>
        <h1>{inst.name}</h1>
        <div className="hero-meta">
          <span>
            <IconClock size={14} /> {formatPlaytime(inst.playtimeSecs)}
          </span>
          <span>Последний запуск: {timeAgo(inst.lastPlayed)}</span>
        </div>
        {hint ? (
          <button className="hero-error hint" onClick={() => setTab('console')}>
            <IconAlert size={16} />
            <span>
              <strong>{hint.title}.</strong> {hint.hint}
            </span>
          </button>
        ) : (
          error && <div className="hero-error">{error}</div>
        )}
        <div className="hero-actions">
          <PlayButton inst={inst} />
          <button className="glass-btn" onClick={() => setModal({ type: 'edit', id: inst.id })} title="Настройки сборки">
            <IconSliders size={18} />
          </button>
          <button className="glass-btn" onClick={() => api.instanceOpenFolder(inst.id)} title="Открыть папку игры">
            <IconFolder size={18} />
          </button>
        </div>
      </div>
    </section>
  )
}

function ModsTab({ inst }: { inst: InstanceT }) {
  const [items, setItems] = useState<LocalContent[] | null>(null)
  const setScreen = useStore((s) => s.setScreen)
  const reload = useCallback(() => {
    api.localContent(inst.id).then(setItems).catch(() => setItems([]))
  }, [inst.id])
  useEffect(() => reload(), [reload])

  return (
    <>
      <div className="tab-toolbar">
        <span className="muted">
          {items ? `${items.filter((i) => i.enabled).length} включено из ${items.length}` : 'Загрузка…'}
        </span>
        <div className="row">
          <button className="btn ghost sm" onClick={() => api.openSubfolder(inst.id, 'mods')}>
            <IconFolder size={14} /> Папка
          </button>
          <button className="btn primary sm" onClick={() => setScreen('content')}>
            <IconSearch size={14} /> Найти моды
          </button>
        </div>
      </div>
      <UpdatesPanel inst={inst} onUpdated={reload} />
      {items && <InstalledList inst={inst} items={items} reload={reload} />}
    </>
  )
}

function WorldsTab({ inst }: { inst: InstanceT }) {
  const toast = useStore((s) => s.toast)
  const [worlds, setWorlds] = useState<WorldInfo[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<string | null>(null)
  const reload = useCallback(() => {
    api.worlds(inst.id).then(setWorlds).catch(() => setWorlds([]))
  }, [inst.id])
  useEffect(() => reload(), [reload])

  async function backup(folder: string) {
    setBusy(folder)
    try {
      await api.worldBackup(inst.id, folder)
      toast('success', `Копия мира «${folder}» сохранена`, {
        label: 'Открыть',
        run: () => api.openSubfolder(inst.id, 'backups'),
      })
    } catch (e) {
      toast('error', (e as Error).message)
    } finally {
      setBusy(null)
    }
  }
  async function remove(folder: string) {
    try {
      await api.worldDelete(inst.id, folder)
      setConfirm(null)
      reload()
    } catch (e) {
      toast('error', (e as Error).message)
    }
  }

  return (
    <>
      <div className="tab-toolbar">
        <span className="muted">{worlds ? `${worlds.length} миров` : 'Загрузка…'}</span>
        <div className="row">
          <button className="btn ghost sm" onClick={() => api.openSubfolder(inst.id, 'backups')}>
            <IconArchive size={14} /> Резервные копии
          </button>
          <button className="btn ghost sm" onClick={() => api.openSubfolder(inst.id, 'saves')}>
            <IconFolder size={14} /> Папка миров
          </button>
        </div>
      </div>
      {worlds?.length === 0 && (
        <div className="empty-state small">
          <IconGlobe size={30} />
          <p className="muted">Миров пока нет — создайте его в игре</p>
        </div>
      )}
      <div className="world-list">
        {worlds?.map((w) => (
          <div key={w.folder} className="world">
            {w.icon ? <img className="world-icon" src={w.icon} alt="" /> : <div className="world-icon placeholder"><IconGlobe size={20} /></div>}
            <div className="project-text">
              <strong>{w.folder}</strong>
              <span className="muted small">
                {timeAgo(w.lastPlayed)} · {formatSize(w.size)}
              </span>
            </div>
            {confirm === w.folder ? (
              <>
                <span className="danger-text small">Удалить навсегда?</span>
                <button className="btn danger sm" onClick={() => remove(w.folder)}>
                  Удалить
                </button>
                <button className="btn ghost sm" onClick={() => setConfirm(null)}>
                  Нет
                </button>
              </>
            ) : (
              <>
                <button className="btn ghost sm" disabled={busy === w.folder} onClick={() => backup(w.folder)}>
                  {busy === w.folder ? <span className="spinner xs" /> : <IconArchive size={14} />} Копия
                </button>
                <button
                  className="icon-btn danger"
                  disabled={inst.running}
                  onClick={() => setConfirm(w.folder)}
                  aria-label={`Удалить ${w.folder}`}
                >
                  <IconTrash size={15} />
                </button>
              </>
            )}
          </div>
        ))}
      </div>
    </>
  )
}

function Shot({ shot, onOpen }: { shot: Screenshot; onOpen: () => void }) {
  const [src, setSrc] = useState('')
  useEffect(() => {
    fileSrc(shot.path).then(setSrc)
  }, [shot.path])
  return (
    <button className="shot" onClick={onOpen} title={shot.name}>
      {src ? <img src={src} alt={shot.name} loading="lazy" /> : <div className="shot-ph" />}
    </button>
  )
}

function ScreenshotsTab({ inst }: { inst: InstanceT }) {
  const [shots, setShots] = useState<Screenshot[] | null>(null)
  useEffect(() => {
    api.screenshots(inst.id).then(setShots).catch(() => setShots([]))
  }, [inst.id])

  return (
    <>
      <div className="tab-toolbar">
        <span className="muted">{shots ? `${shots.length} скриншотов · F2 в игре` : 'Загрузка…'}</span>
        <button className="btn ghost sm" onClick={() => api.openSubfolder(inst.id, 'screenshots')}>
          <IconFolder size={14} /> Папка
        </button>
      </div>
      {shots?.length === 0 && (
        <div className="empty-state small">
          <IconImage size={30} />
          <p className="muted">Нажмите F2 в игре, чтобы сделать скриншот</p>
        </div>
      )}
      {!isTauri && shots?.length === 0 ? null : (
        <div className="shots">
          {shots?.map((s) => (
            <Shot key={s.path} shot={s} onOpen={() => api.openFile(s.path)} />
          ))}
        </div>
      )}
    </>
  )
}

const TABS = [
  { id: 'mods', label: 'Моды', icon: IconPuzzle },
  { id: 'worlds', label: 'Миры', icon: IconGlobe },
  { id: 'servers', label: 'Серверы', icon: IconServer },
  { id: 'screenshots', label: 'Скриншоты', icon: IconImage },
  { id: 'console', label: 'Консоль', icon: IconTerminal },
]

export function InstanceScreen() {
  const inst = useStore(selectedInstance)
  const tab = useStore((s) => s.instanceTab)
  const setTab = useStore((s) => s.setInstanceTab)
  const hasLogs = useStore((s) => (inst ? (s.logs[inst.id]?.length ?? 0) > 0 : false))

  if (!inst) return null
  return (
    <div className="screen">
      <Hero inst={inst} />
      <div className="tabs sticky">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button key={id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
            <Icon size={15} /> {label}
            {id === 'console' && hasLogs && inst.running && <span className="live-dot" />}
          </button>
        ))}
      </div>
      <div className="tab-body" key={`${inst.id}-${tab}`}>
        {tab === 'mods' && <ModsTab inst={inst} />}
        {tab === 'worlds' && <WorldsTab inst={inst} />}
        {tab === 'servers' && <ServersTab inst={inst} />}
        {tab === 'screenshots' && <ScreenshotsTab inst={inst} />}
        {tab === 'console' && <Console inst={inst} />}
      </div>
    </div>
  )
}
