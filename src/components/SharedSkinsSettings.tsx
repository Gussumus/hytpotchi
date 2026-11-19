import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { api } from '../lib/ipc'
import type { SharedSkins } from '../lib/types'
import { IconCheck, IconShirt } from './Icons'

/** Настройки общего сервера офлайн-скинов */
export function SharedSkinsSettings() {
  const toast = useStore((s) => s.toast)
  const [state, setState] = useState<SharedSkins | null>(null)
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api
      .sharedSkinsGet()
      .then((s) => {
        setState(s)
        setUrl(s.customServer ?? '')
      })
      .catch(() => {})
  }, [])

  async function save(enabled: boolean, server: string) {
    setBusy(true)
    try {
      const s = await api.sharedSkinsSet(enabled, server.trim() || null)
      setState(s)
      toast('success', s.server ? 'Сервер скинов подключён' : 'Настройки сохранены')
    } catch (e) {
      toast('error', (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (!state) return null
  return (
    <section className="settings-block">
      <div className="settings-title">
        <IconShirt size={18} />
        <div>
          <h3>Общие скины</h3>
          <p className="muted">
            Офлайн-скины игроков Hytpotchi хранятся на общем сервере. Когда опция включена, лаунчер ставит в сборки с
            загрузчиком мод CustomSkinLoader — и вы видите скины друг друга даже на офлайн-серверах и в LAN.
          </p>
        </div>
      </div>
      <div className="setting-row">
        <div>
          <h3>Показывать скины других игроков</h3>
          <p className="muted small">
            {state.server ? `Сервер: ${state.server}` : 'Сервер скинов не настроен — укажите адрес ниже'}
          </p>
        </div>
        <label className="switch">
          <input type="checkbox" checked={state.enabled} disabled={busy} onChange={(e) => save(e.target.checked, url)} />
          <span />
        </label>
      </div>
      <div className="inline-form">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://hytpotchi-skins.example.workers.dev (пусто — встроенный)"
        />
        <button className="btn" disabled={busy} onClick={() => save(state.enabled, url)}>
          {busy ? <span className="spinner xs" /> : <IconCheck size={15} />} Проверить и сохранить
        </button>
      </div>
    </section>
  )
}
