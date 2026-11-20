import { useState } from 'react'
import { useStore } from '../store'
import { api } from '../lib/ipc'
import type { Account } from '../lib/types'
import { Avatar } from '../components/Avatar'
import { IconAlert, IconCheck, IconMicrosoft, IconTrash, IconUser } from '../components/Icons'

const KIND_LABEL: Record<Account['kind'], string> = {
  hytpotchi: 'Аккаунт Hytpotchi · скин и друзья',
  microsoft: 'Лицензия Microsoft',
  offline: 'Старый офлайн-аккаунт — играть им больше нельзя',
}

export function Accounts() {
  const accounts = useStore((s) => s.accounts)
  const refresh = useStore((s) => s.refreshAccounts)
  const setModal = useStore((s) => s.setModal)
  const toast = useStore((s) => s.toast)
  const msReady = useStore((s) => s.features?.microsoft ?? true)
  const [pwFor, setPwFor] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)

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
          <p className="muted">Пароли не сохраняются, токены шифруются и хранятся только на этом компьютере</p>
        </div>
      </div>

      <div className="account-list">
        {accounts.map((a) => (
          <div key={a.id} className={`account-card ${a.active ? 'on' : ''} ${a.kind}`}>
            <div className="account-row">
              <Avatar account={a} size={44} />
              <div className="account-row-text">
                <strong>{a.username}</strong>
                <span className={`small ${a.kind === 'offline' ? 'warn' : 'muted'}`}>{KIND_LABEL[a.kind]}</span>
              </div>
              {a.kind === 'offline' ? (
                <button className="btn primary sm" onClick={() => setModal({ type: 'login', mode: 'hytpotchi', replace: { id: a.id, nick: a.username } })}>
                  Перенести в Hytpotchi
                </button>
              ) : a.active ? (
                <span className="tag strong">
                  <IconCheck size={13} /> Активный
                </span>
              ) : (
                <button className="btn ghost" onClick={() => act(() => api.accountSetActive(a.id))}>
                  Выбрать
                </button>
              )}
              {a.kind === 'hytpotchi' && (
                <button className="btn ghost sm" onClick={() => setPwFor(pwFor === a.id ? null : a.id)}>
                  Пароль
                </button>
              )}
              {confirmRemove === a.id ? (
                <>
                  <button className="btn danger sm" onClick={() => act(() => api.accountRemove(a.id)).then(() => setConfirmRemove(null))}>
                    Выйти
                  </button>
                  <button className="btn ghost sm" onClick={() => setConfirmRemove(null)}>
                    Нет
                  </button>
                </>
              ) : (
                <button className="icon-btn danger" onClick={() => setConfirmRemove(a.id)} aria-label={`Выйти из ${a.username}`} title="Выйти из аккаунта">
                  <IconTrash size={15} />
                </button>
              )}
            </div>
            {pwFor === a.id && <ChangePassword accountId={a.id} onDone={() => setPwFor(null)} />}
          </div>
        ))}
        {accounts.length === 0 && (
          <div className="empty-state small">
            <IconUser size={30} />
            <p className="muted">Войдите или зарегистрируйтесь, чтобы начать играть</p>
          </div>
        )}
      </div>

      {accounts.some((a) => a.kind === 'offline') && (
        <div className="info-box left">
          <strong>
            <IconAlert size={14} /> Офлайн-аккаунты отключены
          </strong>
          <span>
            Раньше любой мог взять чужой ник, и скины путались. Теперь ник принадлежит аккаунту Hytpotchi с паролем.
            Нажмите «Перенести в Hytpotchi» — ник и скин сохранятся, если ник ещё свободен.
          </span>
        </div>
      )}

      <div className="add-grid">
        <div className="panel">
          <div className="panel-icon hyt">
            <IconUser size={22} />
          </div>
          <h3>Hytpotchi</h3>
          <p className="muted">Ваш ник с паролем: скин виден всем, друзья, игра вместе без модов.</p>
          <button className="btn primary wide" onClick={() => setModal({ type: 'login', mode: 'hytpotchi' })}>
            Войти или зарегистрироваться
          </button>
        </div>
        <div className="panel">
          <div className="panel-icon ms">
            <IconMicrosoft size={24} />
          </div>
          <h3>Microsoft</h3>
          <p className="muted">Лицензионный Minecraft: онлайн-серверы, скины и плащи.</p>
          {msReady ? (
            <button className="btn wide" onClick={() => setModal({ type: 'login', mode: 'microsoft' })}>
              Войти через Microsoft
            </button>
          ) : (
            <>
              <button className="btn wide" disabled>
                Скоро
              </button>
              <span className="muted small">Вход через Microsoft ждёт одобрения Mojang.</span>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function ChangePassword({ accountId, onDone }: { accountId: string; onDone: () => void }) {
  const toast = useStore((s) => s.toast)
  const [old, setOld] = useState('')
  const [next, setNext] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <form
      className="inline-form password-form"
      onSubmit={async (e) => {
        e.preventDefault()
        setBusy(true)
        try {
          await api.hytChangePassword(accountId, old, next)
          toast('success', 'Пароль изменён. На других компьютерах нужно войти заново')
          onDone()
        } catch (err) {
          toast('error', (err as Error).message)
        } finally {
          setBusy(false)
        }
      }}
    >
      <input type="password" value={old} onChange={(e) => setOld(e.target.value)} placeholder="Текущий пароль" autoComplete="current-password" />
      <input type="password" value={next} onChange={(e) => setNext(e.target.value)} placeholder="Новый (от 8 символов)" autoComplete="new-password" />
      <button className="btn primary sm" disabled={busy || !old || next.length < 8}>
        {busy ? <span className="spinner xs dark" /> : 'Сменить'}
      </button>
    </form>
  )
}
