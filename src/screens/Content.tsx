import { useCallback, useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'
import { api } from '../lib/ipc'
import { ACCENTS, formatCount, formatSize, loaderName, timeAgo } from '../lib/format'
import type { Instance, LocalContent, ProjectType, SearchHit } from '../lib/types'
import { IconCheck, IconDownload, IconHeart, IconPackage, IconSearch, IconTrash } from '../components/Icons'
import { VersionPicker } from '../components/VersionPicker'

const TYPES: { id: ProjectType; label: string }[] = [
  { id: 'modpack', label: 'Модпаки' },
  { id: 'mod', label: 'Моды' },
  { id: 'resourcepack', label: 'Ресурспаки' },
  { id: 'shader', label: 'Шейдеры' },
]

const SORTS = [
  ['relevance', 'По релевантности'],
  ['downloads', 'По загрузкам'],
  ['follows', 'По популярности'],
  ['updated', 'Недавно обновлённые'],
] as const

function ProjectIcon({ url, title }: { url: string | null; title: string }) {
  const [failed, setFailed] = useState(false)
  if (url && !failed) return <img className="project-icon" src={url} alt="" onError={() => setFailed(true)} loading="lazy" />
  return <div className="project-icon placeholder">{title.slice(0, 1)}</div>
}

function useDebounced<T>(value: T, ms: number) {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

function Browse({
  inst,
  type,
  installedIds,
  onInstalled,
}: {
  inst: Instance | null
  type: ProjectType
  installedIds: Set<string>
  onInstalled: () => void
}) {
  const toast = useStore((s) => s.toast)
  const refresh = useStore((s) => s.refreshInstances)
  const openInstance = useStore((s) => s.openInstance)
  const setPack = useStore((s) => s.setPack)
  const system = useStore((s) => s.system)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<string>(type === 'modpack' ? 'downloads' : 'relevance')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [installing, setInstalling] = useState<Record<string, boolean>>({})
  const q = useDebounced(query, 300)
  const isPack = type === 'modpack'

  const search = useCallback(
    async (offset: number) => {
      setLoading(true)
      try {
        const res = await api.search({
          query: q,
          projectType: type,
          gameVersion: isPack ? undefined : inst?.gameVersion,
          loader: type === 'mod' ? (inst?.loader ?? undefined) : undefined,
          sort,
          offset,
          limit: 20,
        })
        setHits((prev) => (offset === 0 ? res.hits : [...prev, ...res.hits]))
        setTotal(res.total_hits)
      } catch (e) {
        toast('error', (e as Error).message)
      } finally {
        setLoading(false)
      }
    },
    [q, type, sort, isPack, inst?.gameVersion, inst?.loader, toast],
  )

  useEffect(() => {
    search(0)
  }, [search])

  async function install(hit: SearchHit) {
    setInstalling((s) => ({ ...s, [hit.project_id]: true }))
    try {
      if (isPack) {
        setPack({ label: `Готовим «${hit.title}»`, done: 0, total: 1 })
        const accent = ACCENTS[Math.floor(Math.random() * ACCENTS.length)]
        const created = await api.modpackInstall(hit.project_id, accent, system?.recommendedMemoryMb ?? 6144)
        await refresh()
        toast('success', `Модпак «${created.name}» установлен — можно играть`)
        openInstance(created.id, 'mods')
      } else if (inst) {
        const res = await api.install(hit.project_id, inst.id)
        const extra = res.installed.length > 1 ? ` + зависимости: ${res.installed.length - 1}` : ''
        toast('success', `${hit.title} установлен${extra}`)
        onInstalled()
      }
    } catch (e) {
      toast('error', `${hit.title}: ${(e as Error).message}`)
    } finally {
      setPack(null)
      setInstalling((s) => ({ ...s, [hit.project_id]: false }))
    }
  }

  const needsLoader = type === 'mod' && !inst?.loader

  return (
    <>
      <div className="toolbar">
        <div className="search-input grow">
          <IconSearch size={15} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={isPack ? 'Поиск модпаков на Modrinth' : `Поиск на Modrinth для ${inst?.gameVersion ?? ''}`}
          />
        </div>
        <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Сортировка">
          {SORTS.map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
      </div>

      {needsLoader && (
        <div className="info-box warn">
          <strong>Это ванильная сборка</strong>
          <span>Моды работают с Fabric, Forge, NeoForge или Quilt. Ресурспаки и шейдеры ставить можно.</span>
        </div>
      )}
      {isPack && (
        <div className="info-box">
          <strong>Модпак ставится как новая сборка</strong>
          <span>Лаунчер сам скачает версию игры, загрузчик, все моды и подходящую Java.</span>
        </div>
      )}

      <div className="project-list">
        {hits.map((hit) => {
          const installed = !isPack && (installedIds.has(hit.project_id) || installedIds.has(hit.slug))
          const busy = installing[hit.project_id]
          return (
            <div key={hit.project_id} className="project">
              <ProjectIcon url={hit.icon_url} title={hit.title} />
              <div className="project-text">
                <div className="project-title">
                  <strong>{hit.title}</strong>
                  <span className="muted">от {hit.author}</span>
                </div>
                <p>{hit.description}</p>
                <div className="project-meta">
                  <span>
                    <IconDownload size={13} /> {formatCount(hit.downloads)}
                  </span>
                  <span>
                    <IconHeart size={13} /> {formatCount(hit.follows)}
                  </span>
                  <span>обновлён {timeAgo(hit.date_modified)}</span>
                  {isPack &&
                    hit.categories
                      .filter((c) => ['fabric', 'forge', 'neoforge', 'quilt'].includes(c))
                      .map((c) => (
                        <span key={c} className="mini-tag">
                          {loaderName(c)}
                        </span>
                      ))}
                </div>
              </div>
              <button
                className={`btn ${installed ? 'ghost' : 'primary'} install-btn`}
                disabled={installed || busy || needsLoader || Object.values(installing).some(Boolean)}
                onClick={() => install(hit)}
              >
                {installed ? (
                  <>
                    <IconCheck size={15} /> Установлен
                  </>
                ) : busy ? (
                  <>
                    <span className="spinner xs dark" /> Ставим…
                  </>
                ) : (
                  <>
                    {isPack ? <IconPackage size={15} /> : <IconDownload size={15} />} {isPack ? 'Создать сборку' : 'Установить'}
                  </>
                )}
              </button>
            </div>
          )
        })}
        {loading && hits.length === 0 && (
          <div className="empty">
            <span className="spinner" />
          </div>
        )}
        {!loading && hits.length === 0 && <div className="empty muted">Ничего не нашлось</div>}
        {hits.length > 0 && hits.length < total && (
          <button className="btn ghost wide" disabled={loading} onClick={() => search(hits.length)}>
            {loading ? 'Загружаем…' : 'Показать ещё'}
          </button>
        )}
      </div>
    </>
  )
}

export function InstalledList({ inst, items, reload }: { inst: Instance; items: LocalContent[]; reload: () => void }) {
  const toast = useStore((s) => s.toast)
  const [picking, setPicking] = useState<LocalContent | null>(null)

  async function toggle(item: LocalContent) {
    try {
      await api.contentToggle(inst.id, item.kind, item.filename, !item.enabled)
      reload()
    } catch (e) {
      toast('error', (e as Error).message)
    }
  }
  async function remove(item: LocalContent) {
    try {
      await api.contentRemove(inst.id, item.kind, item.filename)
      reload()
    } catch (e) {
      toast('error', (e as Error).message)
    }
  }

  if (items.length === 0) {
    return <div className="empty muted">В этой сборке пока ничего не установлено</div>
  }
  const kindLabel = { mod: 'Мод', resourcepack: 'Ресурспак', shader: 'Шейдер' }
  return (
    <div className="project-list">
      {picking && (
        <VersionPicker instanceId={inst.id} item={picking} onClose={() => setPicking(null)} onChanged={reload} />
      )}
      {items.map((item) => (
        <div key={`${item.kind}/${item.filename}`} className={`project compact ${item.enabled ? '' : 'disabled'}`}>
          <ProjectIcon url={item.iconUrl} title={item.title} />
          <div className="project-text">
            <div className="project-title">
              <strong>{item.title}</strong>
              <span className="mini-tag">{kindLabel[item.kind]}</span>
              {item.versionType && item.versionType !== 'release' && (
                <span className={`type-badge ${item.versionType}`}>{item.versionType === 'beta' ? 'Бета' : 'Альфа'}</span>
              )}
            </div>
            <span className="muted small">
              {item.versionNumber ?? item.filename} · {formatSize(item.size)}
            </span>
          </div>
          {item.projectId && (
            <button className="btn ghost sm" onClick={() => setPicking(item)}>
              Версия
            </button>
          )}
          <label className="switch" title={item.enabled ? 'Выключить' : 'Включить'}>
            <input type="checkbox" checked={item.enabled} onChange={() => toggle(item)} />
            <span />
          </label>
          <button className="icon-btn danger" onClick={() => remove(item)} aria-label={`Удалить ${item.title}`}>
            <IconTrash size={15} />
          </button>
        </div>
      ))}
    </div>
  )
}

export function Content() {
  const instances = useStore((s) => s.instances)
  const selectedId = useStore((s) => s.selectedId)
  const select = useStore((s) => s.select)
  const inst = instances.find((i) => i.id === selectedId) ?? instances[0] ?? null
  const [type, setType] = useState<ProjectType>(inst?.loader ? 'mod' : 'modpack')
  const [items, setItems] = useState<LocalContent[]>([])

  const reload = useCallback(() => {
    if (inst) api.localContent(inst.id).then(setItems).catch(() => setItems([]))
  }, [inst])
  useEffect(() => reload(), [reload])

  const installedIds = useMemo(() => new Set(items.map((i) => i.projectId).filter(Boolean) as string[]), [items])
  const isPack = type === 'modpack'

  return (
    <div className="screen">
      <div className="page-head">
        <div>
          <h1>Каталог</h1>
          <p className="muted">
            {isPack
              ? 'Готовые модпаки ставятся в один клик'
              : 'Подбираем совместимые версии и ставим зависимости автоматически'}
          </p>
        </div>
        {!isPack && inst && (
          <label className="instance-picker">
            <span className="muted small">Ставить в</span>
            <select value={inst.id} onChange={(e) => select(e.target.value)} aria-label="Сборка">
              {instances.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name} — {loaderName(i.loader)} {i.gameVersion}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <div className="tabs">
        {TYPES.map((t) => (
          <button key={t.id} className={type === t.id ? 'on' : ''} onClick={() => setType(t.id)} disabled={!inst && t.id !== 'modpack'}>
            {t.label}
          </button>
        ))}
      </div>
      {!inst && !isPack ? null : (
        <Browse key={`${type}-${isPack ? '' : inst?.id}`} inst={inst} type={type} installedIds={installedIds} onInstalled={reload} />
      )}
    </div>
  )
}
