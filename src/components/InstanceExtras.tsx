import { useCallback, useEffect, useState } from 'react'
import { useStore } from '../store'
import { api } from '../lib/ipc'
import type { Instance, SavedServer, ServerStatus, UpdateInfo } from '../lib/types'
import { IconCheck, IconFolder, IconPlay, IconPlus, IconRefresh, IconServer, IconTrash } from './Icons'

// ---------- Серверы ----------

function ServerRow({ inst, server, onRemove }: { inst: Instance; server: SavedServer; onRemove: () => void }) {
  const launch = useStore((s) => s.launch)
  const busy = useStore((s) => !!s.progress[inst.id] || inst.running)
  const [status, setStatus] = useState<ServerStatus | null>(null)

  const ping = useCallback(() => {
    setStatus(null)
    api.ping(server.address).then(setStatus).catch(() => setStatus(null))
  }, [server.address])
  useEffect(() => ping(), [ping])

  const icon = status?.favicon ?? (server.icon ? `data:image/png;base64,${server.icon}` : null)
  return (
    <div className="server">
      {icon ? <img className="server-icon" src={icon} alt="" /> : <div className="server-icon placeholder"><IconServer size={20} /></div>}
      <div className="project-text">
        <div className="project-title">
          <strong>{server.name}</strong>
          <span className="muted small">{server.address}</span>
        </div>
        <span className="server-motd">
          {status === null ? 'Проверяем…' : status.online ? (status.motd ?? 'Сервер онлайн') : 'Не отвечает'}
        </span>
      </div>
      <div className="server-stats">
        {status?.online ? (
          <>
            <span className="online-dot" />
            <span>
              {status.players ?? 0}/{status.maxPlayers ?? '?'}
            </span>
            <span className="muted">{status.pingMs} мс</span>
            {status.version && <span className="mini-tag">{status.version}</span>}
          </>
        ) : status ? (
          <span className="muted">офлайн</span>
        ) : (
          <span className="spinner xs" />
        )}
      </div>
      <button className="icon-btn" onClick={ping} title="Обновить">
        <IconRefresh size={15} />
      </button>
      <button className="btn primary sm" disabled={busy} onClick={() => launch(inst.id, server.address)}>
        <IconPlay size={13} /> Играть
      </button>
      <button className="icon-btn danger" onClick={onRemove} aria-label={`Удалить ${server.name}`}>
        <IconTrash size={15} />
      </button>
    </div>
  )
}

export function ServersTab({ inst }: { inst: Instance }) {
  const toast = useStore((s) => s.toast)
  const [servers, setServers] = useState<SavedServer[] | null>(null)
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')

  const reload = useCallback(() => {
    api.servers(inst.id).then(setServers).catch(() => setServers([]))
  }, [inst.id])
  useEffect(() => reload(), [reload])

  async function add() {
    try {
      await api.serverAdd(inst.id, name, address)
      setName('')
      setAddress('')
      reload()
    } catch (e) {
      toast('error', (e as Error).message)
    }
  }
  async function remove(addr: string) {
    try {
      await api.serverRemove(inst.id, addr)
      reload()
    } catch (e) {
      toast('error', (e as Error).message)
    }
  }

  return (
    <>
      <div className="add-server">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Название (необязательно)" maxLength={40} />
        <input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && address.trim() && add()}
          placeholder="Адрес: play.example.org или 1.2.3.4:25565"
        />
        <button className="btn primary" disabled={!address.trim()} onClick={add}>
          <IconPlus size={15} /> Добавить
        </button>
      </div>
      {servers?.length === 0 && (
        <div className="empty-state small">
          <IconServer size={30} />
          <p className="muted">Добавьте сервер — потом в него можно будет заходить прямо из лаунчера</p>
        </div>
      )}
      <div className="world-list">
        {servers?.map((s) => (
          <ServerRow key={s.address} inst={inst} server={s} onRemove={() => remove(s.address)} />
        ))}
      </div>
    </>
  )
}

// ---------- Обновления модов ----------

export function UpdatesPanel({ inst, onUpdated }: { inst: Instance; onUpdated: () => void }) {
  const toast = useStore((s) => s.toast)
  const [updates, setUpdates] = useState<UpdateInfo[] | null>(null)
  const [checking, setChecking] = useState(false)
  const [applying, setApplying] = useState<string | null>(null)

  async function check() {
    setChecking(true)
    try {
      const list = await api.checkUpdates(inst.id)
      setUpdates(list)
      if (list.length === 0) toast('success', 'Всё установлено в последних версиях')
      onUpdated()
    } catch (e) {
      toast('error', (e as Error).message)
    } finally {
      setChecking(false)
    }
  }

  async function apply(list: UpdateInfo[]) {
    let ok = 0
    for (const u of list) {
      setApplying(u.projectId)
      try {
        await api.installVersion(u.versionId, inst.id)
        ok++
        setUpdates((cur) => cur?.filter((x) => x.projectId !== u.projectId) ?? null)
      } catch (e) {
        toast('error', `${u.title}: ${(e as Error).message}`)
      }
    }
    setApplying(null)
    onUpdated()
    if (ok) toast('success', `Обновлено: ${ok}`)
  }

  return (
    <div className="updates">
      <div className="row">
        <button className="btn ghost sm" disabled={checking || !!applying || inst.running} onClick={check}>
          {checking ? <span className="spinner xs" /> : <IconRefresh size={14} />} Проверить обновления
        </button>
        {updates && updates.length > 0 && (
          <button className="btn primary sm" disabled={!!applying || inst.running} onClick={() => apply(updates)}>
            Обновить всё ({updates.length})
          </button>
        )}
      </div>
      {updates && updates.length > 0 && (
        <div className="update-list">
          {updates.map((u) => (
            <div key={u.projectId} className="update-row">
              <strong>{u.title}</strong>
              <span className="muted small">
                {u.current ?? '?'} → <b className="mint">{u.latest}</b>
              </span>
              {u.versionType !== 'release' && <span className={`type-badge ${u.versionType}`}>{u.versionType}</span>}
              <span className="spacer" />
              {applying === u.projectId ? (
                <span className="spinner xs" />
              ) : (
                <button className="btn ghost sm" disabled={!!applying || inst.running} onClick={() => apply([u])}>
                  <IconCheck size={13} /> Обновить
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function OpenFolderButton({ inst, sub, label }: { inst: Instance; sub: string; label: string }) {
  return (
    <button className="btn ghost sm" onClick={() => api.openSubfolder(inst.id, sub)}>
      <IconFolder size={14} /> {label}
    </button>
  )
}
