import { useState } from 'react'
import { useStore } from '../store'
import { api } from '../lib/ipc'
import { Avatar } from '../components/Avatar'
import { IconCheck, IconMicrosoft, IconTrash, IconUser } from '../components/Icons'

export function Accounts() {
  const accounts = useStore((s) => s.accounts)
  const refresh = useStore((s) => s.refreshAccounts)
  const setModal = useStore((s) => s.setModal)
  const toast = useStore((s) => s.toast)
  const msReady = useStore((s) => s.features?.microsoft ?? true)
  const [nick, setNick] = useState('')
  const [busy, setBusy] = useState(false)

  const nickValid = /^[A-Za-z0-9_]{3,16}$/.test(nick)

  async function addOffline() {
    setBusy(true)
    try {
      const acc = await api.addOffline(nick)
      await refresh()
      setNick('')
      toast('success', `Аккаунт ${acc.username} добавлен`)
    } catch (e) {
      toast('error', (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function act(fn: () => Promise<void>) {
    try {
      await fn()
      await refresh()
    } catch (e) {
      toast('error', (e as Error).message)
    }
  }

  return (
    <div className="screen narrow">
      <div className="page-head">
        <div>
          <h1>Аккаунты</h1>
          <p className="muted">Токены шифруются и хранятся только на этом компьютере</p>
        </div>
      </div>

      <div className="account-list">
        {accounts.map((a) => (
          <div key={a.id} className={`account-row ${a.active ? 'on' : ''}`}>
            <Avatar account={a} size={44} />
            <div className="account-row-text">
              <strong>{a.username}</strong>
              <span className="muted small">{a.kind === 'microsoft' ? 'Лицензия Microsoft' : 'Офлайн-аккаунт · одиночная игра и LAN'}</span>
            </div>
            {a.active ? (
              <span className="tag strong">
                <IconCheck size={13} /> Активный
              </span>
            ) : (
              <button className="btn ghost" onClick={() => act(() => api.accountSetActive(a.id))}>
                Выбрать
              </button>
            )}
            <button className="icon-btn danger" onClick={() => act(() => api.accountRemove(a.id))} aria-label={`Удалить ${a.username}`}>
              <IconTrash size={15} />
            </button>
          </div>
        ))}
        {accounts.length === 0 && (
          <div className="empty-state small">
            <IconUser size={30} />
            <p className="muted">Добавьте аккаунт, чтобы начать играть</p>
          </div>
        )}
      </div>

      <div className="add-grid">
        <div className="panel">
          <div className="panel-icon ms">
            <IconMicrosoft size={24} />
          </div>
          <h3>Microsoft</h3>
          <p className="muted">Лицензионный Minecraft: онлайн-серверы, скины и плащи.</p>
          {msReady ? (
            <button className="btn primary wide" onClick={() => setModal({ type: 'login' })}>
              Войти через Microsoft
            </button>
          ) : (
            <>
              <button className="btn wide" disabled>
                Скоро
              </button>
              <span className="muted small">
                Вход через Microsoft появится в одной из следующих версий — сейчас его подключение ждёт одобрения Mojang.
                Пока можно играть с офлайн-аккаунтом.
              </span>
            </>
          )}
        </div>
        <div className="panel">
          <div className="panel-icon">
            <IconUser size={22} />
          </div>
          <h3>Офлайн</h3>
          <p className="muted">Любой ник без входа — для одиночной игры и LAN.</p>
          <div className="inline-form">
            <input
              value={nick}
              onChange={(e) => setNick(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && nickValid && addOffline()}
              placeholder="Ник"
              maxLength={16}
            />
            <button className="btn" disabled={!nickValid || busy} onClick={addOffline}>
              Добавить
            </button>
          </div>
          {nick && !nickValid && <span className="warn small">3–16 символов: латиница, цифры, _</span>}
        </div>
      </div>
    </div>
  )
}
