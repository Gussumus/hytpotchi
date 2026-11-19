import { useEffect, useState } from 'react'
import { activeAccount, useStore } from '../store'
import { api, openExternal } from '../lib/ipc'
import { formatDate, formatPlaytime, greeting, loaderName, timeAgo } from '../lib/format'
import type { Instance, NewsItem } from '../lib/types'
import { Cover } from '../components/Cover'
import { InstanceArt } from '../components/InstanceArt'
import { PlayButton } from '../components/PlayButton'
import { IconArrowRight, IconClock, IconFolder, IconPackage, IconPlay, IconPlus, IconUpload } from '../components/Icons'
import { groupInstances } from '../components/Sidebar'

function Continue({ inst }: { inst: Instance }) {
  const openInstance = useStore((s) => s.openInstance)
  const accent = inst.accent ?? '#3ddc84'
  return (
    <section className="hero continue" style={{ ['--accent' as string]: accent }}>
      <div className="hero-art">
        <InstanceArt inst={inst} cols={60} rows={22} />
      </div>
      <div className="hero-shade" />
      <div className="hero-content">
        <span className="eyebrow">{inst.lastPlayed ? 'Продолжить игру' : 'Готово к запуску'}</span>
        <h1>{inst.name}</h1>
        <div className="hero-meta">
          <span className="tag strong">{loaderName(inst.loader)}</span>
          <span>Minecraft {inst.gameVersion}</span>
          <span>
            <IconClock size={14} /> {formatPlaytime(inst.playtimeSecs)}
          </span>
        </div>
        <div className="hero-actions">
          <PlayButton inst={inst} />
          <button className="glass-btn wide" onClick={() => openInstance(inst.id)}>
            Открыть сборку <IconArrowRight size={16} />
          </button>
        </div>
      </div>
    </section>
  )
}

function InstanceCard({ inst }: { inst: Instance }) {
  const openInstance = useStore((s) => s.openInstance)
  const launch = useStore((s) => s.launch)
  const progress = useStore((s) => s.progress[inst.id])
  const accent = inst.accent ?? '#3ddc84'

  return (
    <div className="card" style={{ ['--accent' as string]: accent }}>
      <button className="card-main" onClick={() => openInstance(inst.id)}>
        <div className="card-art">
          <InstanceArt inst={inst} />
          {inst.running && <span className="card-live">в игре</span>}
        </div>
        <div className="card-text">
          <strong>{inst.name}</strong>
          <span>
            {loaderName(inst.loader)} · {inst.gameVersion}
          </span>
          <span className="card-sub">{inst.lastPlayed ? timeAgo(inst.lastPlayed) : 'ещё не запускали'}</span>
        </div>
      </button>
      <button
        className="card-play"
        disabled={!!progress || inst.running}
        onClick={() => launch(inst.id)}
        aria-label={`Играть в ${inst.name}`}
      >
        {progress ? <span className="spinner xs dark" /> : <IconPlay size={16} />}
      </button>
    </div>
  )
}

function News() {
  const [news, setNews] = useState<NewsItem[] | null>(null)
  useEffect(() => {
    api.news().then(setNews).catch(() => setNews([]))
  }, [])
  if (news && news.length === 0) return null
  return (
    <>
      <div className="section-head">
        <h2>Новое в Minecraft</h2>
      </div>
      <div className="news-row">
        {(news ?? Array.from({ length: 4 }, () => null)).slice(0, 6).map((n, i) =>
          n ? (
            <button key={n.version} className="news-card" onClick={() => openExternal(n.url)}>
              <div className="news-img">
                {n.image ? <img src={n.image} alt="" loading="lazy" /> : <Cover seed={n.version} accent="#4f8cff" />}
                <span className={`news-kind ${n.kind}`}>{n.kind === 'release' ? 'Релиз' : 'Снапшот'}</span>
              </div>
              <div className="news-text">
                <strong>{n.title}</strong>
                <span>{formatDate(n.date)}</span>
              </div>
            </button>
          ) : (
            <div key={i} className="news-card skeleton" />
          ),
        )}
      </div>
    </>
  )
}

function Welcome() {
  const setModal = useStore((s) => s.setModal)
  const setScreen = useStore((s) => s.setScreen)
  return (
    <section className="welcome">
      <div className="welcome-art">
        <Cover seed="hytpotchi-welcome" accent="#3ddc84" cols={60} rows={26} />
      </div>
      <div className="welcome-text">
        <h1>Добро пожаловать в Hytpotchi</h1>
        <p>
          Создайте сборку на Vanilla, Fabric, Forge, NeoForge или Quilt, либо поставьте готовый модпак. Игра, моды и
          нужная Java скачаются сами.
        </p>
        <div className="row">
          <button className="play-btn" onClick={() => setModal({ type: 'create' })}>
            <IconPlus size={18} /> Создать сборку
          </button>
          <button className="glass-btn wide" onClick={() => setScreen('content')}>
            <IconPackage size={17} /> Модпаки
          </button>
        </div>
      </div>
    </section>
  )
}

export function Home() {
  const instances = useStore((s) => s.instances)
  const loaded = useStore((s) => s.loaded)
  const account = useStore(activeAccount)
  const setModal = useStore((s) => s.setModal)
  const toast = useStore((s) => s.toast)
  const refresh = useStore((s) => s.refreshInstances)
  const openInstance = useStore((s) => s.openInstance)
  const setPack = useStore((s) => s.setPack)
  const system = useStore((s) => s.system)

  if (!loaded) {
    return (
      <div className="screen center-fill">
        <span className="spinner" />
      </div>
    )
  }

  const recent = [...instances].sort((a, b) => (b.lastPlayed ?? b.createdAt).localeCompare(a.lastPlayed ?? a.createdAt))[0]

  const memory = system?.recommendedMemoryMb ?? 6144

  async function runImport(action: () => Promise<Instance | null>) {
    try {
      const inst = await action()
      setPack(null)
      if (inst) {
        await refresh()
        openInstance(inst.id)
        toast('success', `Сборка «${inst.name}» импортирована`)
      }
    } catch (e) {
      setPack(null)
      toast('error', (e as Error).message)
    }
  }

  return (
    <div className="screen">
      <div className="page-head">
        <div>
          <h1>
            {greeting()}
            {account ? `, ${account.username}` : ''}
          </h1>
          <p className="muted">Во что сыграем сегодня?</p>
        </div>
        <div className="row">
          <button className="btn ghost" onClick={() => runImport(() => api.mrpackImport('#ff7a59', memory))}>
            <IconUpload size={16} /> Импорт .mrpack
          </button>
          <button className="btn ghost" onClick={() => runImport(() => api.importInstance('#4f8cff', memory))}>
            <IconFolder size={16} /> Из другого лаунчера
          </button>
          <button className="btn primary" onClick={() => setModal({ type: 'create' })}>
            <IconPlus size={16} /> Новая сборка
          </button>
        </div>
      </div>

      {recent ? <Continue inst={recent} /> : <Welcome />}

      {instances.length > 0 && (
        <>
          <div className="section-head">
            <h2>Ваши сборки</h2>
            <span className="muted">{instances.length}</span>
          </div>
          {groupInstances(instances).map(([group, list], gi, all) => (
            <div key={group || '_'} className="group-block">
              {group && <h3 className="group-title">{group}</h3>}
              <div className="grid">
                {list.map((i) => (
                  <InstanceCard key={i.id} inst={i} />
                ))}
                {gi === all.length - 1 && (
                  <button className="card card-new" onClick={() => setModal({ type: 'create' })}>
                    <span className="card-new-icon">
                      <IconPlus size={22} />
                    </span>
                    <strong>Новая сборка</strong>
                    <span>Vanilla, Fabric, Forge, NeoForge, Quilt</span>
                  </button>
                )}
              </div>
            </div>
          ))}
        </>
      )}

      <News />
    </div>
  )
}
