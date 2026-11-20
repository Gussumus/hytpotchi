import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'
import { api } from '../lib/ipc'
import { hashString, ACCENTS, loaderName } from '../lib/format'
import type { Friend, FriendHost, FriendsState, FriendStatus, LocalHost } from '../lib/types'
import {
  IconCheck,
  IconCopy,
  IconGlobe,
  IconPlay,
  IconRefresh,
  IconSend,
  IconTrash,
  IconUserPlus,
  IconUsers,
  IconX,
} from '../components/Icons'

const STATUS_LABEL: Record<FriendStatus | 'offline', string> = {
  online: 'В сети',
  busy: 'Не беспокоить',
  invisible: 'Невидимка',
  offline: 'Не в сети',
}

function ago(ts: number | null): string {
  if (!ts) return 'давно'
  const min = Math.round((Date.now() - ts) / 60000)
  if (min < 2) return 'только что'
  if (min < 60) return `${min} мин назад`
  const h = Math.round(min / 60)
  if (h < 24) return `${h} ч назад`
  return `${Math.round(h / 24)} дн назад`
}

function plural(n: number, one: string, few: string, many: string) {
  const m10 = n % 10
  const m100 = n % 100
  if (m10 === 1 && m100 !== 11) return one
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few
  return many
}

const version = (mc: string, loader: string | null) => `${mc}${loader ? ` · ${loaderName(loader)}` : ''}`

function Initial({ name, size = 40, status }: { name: string; size?: number; status?: string }) {
  const color = ACCENTS[hashString(name) % ACCENTS.length]
  return (
    <span className="friend-avatar" style={{ width: size, height: size, ['--c' as string]: color }}>
      {name.slice(0, 1).toUpperCase()}
      {status && <span className={`friend-dot ${status}`} />}
    </span>
  )
}

export function Friends() {
  const state = useStore((s) => s.friends)
  const setFriends = useStore((s) => s.setFriends)
  const setScreen = useStore((s) => s.setScreen)
  const setModal = useStore((s) => s.setModal)
  const toast = useStore((s) => s.toast)
  const joinWorld = useStore((s) => s.joinWorld)
  const [nick, setNick] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)

  useEffect(() => {
    api.friendsRefresh().then(setFriends).catch(() => {})
  }, [setFriends])

  async function run(key: string, fn: () => Promise<FriendsState>, ok?: string) {
    setBusy(key)
    try {
      setFriends(await fn())
      if (ok) toast('success', ok)
      return true
    } catch (e) {
      toast('error', (e as Error).message)
      return false
    } finally {
      setBusy(null)
    }
  }

  const snap = state?.snapshot ?? null
  const online = useMemo(() => snap?.friends.filter((f) => f.online) ?? [], [snap])
  const offline = useMemo(() => snap?.friends.filter((f) => !f.online) ?? [], [snap])
  const myHost: LocalHost | null = state?.hosted[0] ?? null
  const nickOk = /^[A-Za-z0-9_]{3,16}$/.test(nick.trim())

  // ---------- Состояния без друзей ----------
  if (!state) {
    return (
      <div className="screen center-fill">
        <span className="spinner" />
      </div>
    )
  }
  if (!state.configured || !state.enabled || !state.account) {
    return (
      <div className="screen narrow">
        <Head />
        <div className="empty-state">
          <IconUsers size={38} />
          {!state.configured ? (
            <>
              <h3>Нужен сервер Hytpotchi</h3>
              <p className="muted">
                Друзья работают через тот же сервер, что и общие скины. Укажите его адрес в настройках — и сможете
                добавлять друзей по коду и звать их в свой мир.
              </p>
              <button className="btn primary" onClick={() => setScreen('settings')}>
                Открыть настройки
              </button>
            </>
          ) : !state.account ? (
            <>
              <h3>Нужен аккаунт Hytpotchi</h3>
              <p className="muted">
                Друзья, скин для всех и игра вместе работают от аккаунта Hytpotchi — ника с паролем. Зарегистрируйтесь
                или войдите, и друзья смогут найти вас по нику.
              </p>
              <button className="btn primary" onClick={() => setModal({ type: 'login', mode: 'hytpotchi' })}>
                Войти или зарегистрироваться
              </button>
            </>
          ) : (
            <>
              <h3>Друзья выключены</h3>
              <p className="muted">Включите, чтобы видеть, кто в сети, и играть вместе.</p>
              <button className="btn primary" onClick={() => run('enable', () => api.friendsSettings({ enabled: true }))}>
                Включить друзей
              </button>
            </>
          )}
        </div>
      </div>
    )
  }

  function join(f: Friend, host: FriendHost) {
    joinWorld({
      friendName: f.nick,
      friendId: f.id,
      address: host.relay ? null : host.address,
      mc: host.mc,
      loader: host.loader,
      pack: host.pack,
    })
  }

  async function invite(f: Friend) {
    if (!myHost) return
    await run(
      `inv-${f.id}`,
      () =>
        api.friendsInvite({
          to: f.id,
          address: myHost.relay ? null : myHost.address,
          instanceName: myHost.instance,
          mc: myHost.mc,
          loader: myHost.loader,
        }),
      `Приглашение отправлено: ${f.nick}`,
    )
  }

  return (
    <div className="screen friends-screen">
      <Head
        right={
          <button
            className="icon-btn"
            onClick={() => run('refresh', () => api.friendsRefresh())}
            disabled={busy !== null}
            aria-label="Обновить"
            title="Обновить"
          >
            <IconRefresh size={16} className={busy === 'refresh' || state.syncing ? 'spin' : ''} />
          </button>
        }
      />

      {state.error && (
        <div className="error-box">
          {state.error}
          {snap && <span className="muted small"> Показаны последние известные данные.</span>}
        </div>
      )}

      <div className="friends-layout">
        <div className="friends-main">
          {/* Приглашения */}
          {snap && snap.invites.length > 0 && (
            <section className="friends-section invites">
              <h3>Зовут играть</h3>
              {snap.invites.map((inv) => (
                <div key={inv.id} className="invite-card">
                  <Initial name={inv.fromNick} size={38} />
                  <div className="invite-text">
                    <strong>{inv.fromNick}</strong>
                    <span className="muted small">
                      {inv.instance ? `${inv.instance.name} · ${version(inv.instance.mc, inv.instance.loader)}` : (inv.address ?? 'свой мир')}
                      {inv.note ? ` — «${inv.note}»` : ''}
                    </span>
                  </div>
                  <button
                    className="btn primary sm"
                    onClick={() => {
                      api.friendsDismiss(inv.id).then(setFriends).catch(() => {})
                      joinWorld({
                        friendName: inv.fromNick,
                        friendId: inv.from,
                        address: inv.address,
                        mc: inv.instance?.mc,
                        loader: inv.instance?.loader,
                        pack: inv.pack,
                      })
                    }}
                  >
                    <IconPlay size={13} /> Присоединиться
                  </button>
                  <button className="icon-btn" onClick={() => run(`d-${inv.id}`, () => api.friendsDismiss(inv.id))} aria-label="Скрыть">
                    <IconX size={14} />
                  </button>
                </div>
              ))}
            </section>
          )}

          {/* Заявки */}
          {snap && snap.requests.length > 0 && (
            <section className="friends-section">
              <h3>Заявки в друзья</h3>
              {snap.requests.map((r) => (
                <div key={r.id} className="friend-row request">
                  <Initial name={r.nick} />
                  <div className="friend-text">
                    <strong>{r.nick}</strong>
                    <span className="muted small">хочет дружить · {ago(r.at)}</span>
                  </div>
                  <button
                    className="btn primary sm"
                    disabled={busy !== null}
                    onClick={() => run(`a-${r.id}`, () => api.friendsRespond(r.id, true), `${r.nick} теперь в друзьях`)}
                  >
                    <IconCheck size={13} /> Принять
                  </button>
                  <button
                    className="btn ghost sm"
                    disabled={busy !== null}
                    onClick={() => run(`r-${r.id}`, () => api.friendsRespond(r.id, false))}
                  >
                    Отклонить
                  </button>
                </div>
              ))}
            </section>
          )}

          {/* Друзья */}
          <section className="friends-section">
            <h3>
              В сети <span className="count">{online.length}</span>
            </h3>
            {!snap && <div className="skeleton friend-skeleton" />}
            {snap && snap.friends.length === 0 && (
              <div className="empty-state small">
                <IconUserPlus size={30} />
                <p className="muted">Пока никого. Добавьте друга по нику справа — или скажите ему свой ник.</p>
              </div>
            )}
            {snap && snap.friends.length > 0 && online.length === 0 && <p className="muted small">Сейчас никого нет в сети.</p>}
            {online.map((f, i) => (
              <FriendRow
                key={f.id}
                f={f}
                index={i}
                canInvite={!!myHost}
                busy={busy}
                onJoin={join}
                onInvite={invite}
                confirm={confirmRemove === f.id}
                onAskRemove={() => setConfirmRemove(confirmRemove === f.id ? null : f.id)}
                onRemove={() => run(`rm-${f.id}`, () => api.friendsRemove(f.id), `${f.nick} удалён из друзей`).then(() => setConfirmRemove(null))}
              />
            ))}
          </section>

          {offline.length > 0 && (
            <section className="friends-section">
              <h3>
                Не в сети <span className="count">{offline.length}</span>
              </h3>
              {offline.map((f, i) => (
                <FriendRow
                  key={f.id}
                  f={f}
                  index={i}
                  canInvite={false}
                  busy={busy}
                  onJoin={join}
                  onInvite={invite}
                  confirm={confirmRemove === f.id}
                  onAskRemove={() => setConfirmRemove(confirmRemove === f.id ? null : f.id)}
                  onRemove={() => run(`rm-${f.id}`, () => api.friendsRemove(f.id), `${f.nick} удалён из друзей`).then(() => setConfirmRemove(null))}
                />
              ))}
            </section>
          )}

          {snap && snap.outgoing.length > 0 && (
            <section className="friends-section">
              <h3>Ждут ответа</h3>
              {snap.outgoing.map((r) => (
                <div key={r.id} className="friend-row muted-row">
                  <Initial name={r.nick} size={32} />
                  <div className="friend-text">
                    <strong>{r.nick}</strong>
                    <span className="muted small">заявка отправлена {ago(r.at)}</span>
                  </div>
                  <button className="btn ghost sm" disabled={busy !== null} onClick={() => run(`c-${r.id}`, () => api.friendsRemove(r.id))}>
                    Отменить
                  </button>
                </div>
              ))}
            </section>
          )}
        </div>

        <aside className="friends-side">
          {/* Мой ник и статус */}
          <section className="friends-card me">
            <span className="muted small">Друзья находят вас по нику</span>
            <div className="my-code">
              <strong>{snap?.me.nick ?? state.account}</strong>
              <button
                className="icon-btn"
                onClick={() => {
                  navigator.clipboard?.writeText(snap?.me.nick ?? state.account ?? '').then(
                    () => toast('success', 'Ник скопирован — отправьте его другу'),
                    () => toast('error', 'Не удалось скопировать'),
                  )
                }}
                aria-label="Скопировать ник"
                title="Скопировать"
              >
                <IconCopy size={15} />
              </button>
            </div>
            <div className="segmented status-picker">
              {(['online', 'busy', 'invisible'] as FriendStatus[]).map((st) => (
                <button
                  key={st}
                  className={state.status === st ? 'on' : ''}
                  onClick={() => run(`st-${st}`, () => api.friendsSettings({ status: st }))}
                >
                  <span className={`friend-dot inline ${st}`} />
                  {STATUS_LABEL[st]}
                </button>
              ))}
            </div>
          </section>

          {/* Добавить друга */}
          <section className="friends-card">
            <strong>Добавить друга</strong>
            <form
              className="add-friend"
              onSubmit={async (e) => {
                e.preventDefault()
                if (!nickOk) return
                if (await run('add', () => api.friendsRequest(nick.trim()), 'Заявка отправлена')) setNick('')
              }}
            >
              <input
                value={nick}
                onChange={(e) => setNick(e.target.value)}
                placeholder="Ник друга"
                maxLength={16}
                spellCheck={false}
                aria-label="Ник друга"
              />
              <button className="btn primary" disabled={busy !== null || !nickOk}>
                {busy === 'add' ? <span className="spinner xs dark" /> : <IconUserPlus size={15} />}
              </button>
            </form>
          </section>

          {/* Мой мир */}
          <section className="friends-card host-card">
            <div className="host-head">
              <IconGlobe size={17} />
              <strong>Мой мир для друзей</strong>
            </div>
            {myHost ? (
              <>
                <div className="host-live">
                  <span className="live-dot" />
                  <div>
                    <strong>{myHost.world ?? myHost.instance}</strong>
                    <span className="muted small">
                      {myHost.relay ? 'Открыт через лаунчер — друзьям моды не нужны' : `e4mc: ${myHost.address}`}
                    </span>
                  </div>
                </div>
                {myHost.mods !== null && (
                  <p className="muted small">
                    {myHost.mods > 0
                      ? `Друзья получат вашу сборку: ${myHost.mods} ${plural(myHost.mods, 'мод', 'мода', 'модов')} — лаунчер поставит их сам.`
                      : 'Сборка без модов — друзьям ничего ставить не нужно.'}
                  </p>
                )}
                {myHost.missing.length > 0 && (
                  <p className="warn small" title={myHost.missing.join('\n')}>
                    Не с Modrinth, друзьям придётся поставить вручную: {myHost.missing.slice(0, 3).join(', ')}
                    {myHost.missing.length > 3 ? ` и ещё ${myHost.missing.length - 3}` : ''}
                  </p>
                )}
                {state.hostOnlineMode ? (
                  <p className="warn small">
                    Вы играете с аккаунтом Microsoft, поэтому мир требует лицензию: друзья с аккаунтом Hytpotchi не
                    смогут войти. Чтобы позвать их, играйте с аккаунта Hytpotchi.
                  </p>
                ) : (
                  <p className="muted small">Друзья в сети видят кнопку «Присоединиться». Можно и позвать кого-то лично.</p>
                )}
              </>
            ) : (
              <ol className="host-steps">
                <li>Запустите любую сборку — хоть ванильную.</li>
                <li>
                  Зайдите в свой мир, нажмите <b>Esc → Открыть для сети</b>.
                </li>
                <li>Лаунчер сам откроет мир друзьям: у них появится «Присоединиться».</li>
              </ol>
            )}
            <div className="setting-row compact">
              <div>
                <h3>Запасной способ: e4mc</h3>
                <p className="muted small">
                  Если через лаунчер не получается, можно ставить мод e4mc в сборки с загрузчиком — он открывает мир через
                  свой сервер.
                </p>
              </div>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={state.hosting}
                  disabled={busy !== null}
                  onChange={(e) =>
                    run(
                      'hosting',
                      () => api.friendsSettings({ hosting: e.target.checked }),
                      e.target.checked ? 'e4mc поставится при следующем запуске сборки с загрузчиком' : undefined,
                    )
                  }
                />
                <span />
              </label>
            </div>
          </section>

          <button className="btn ghost sm friends-off" onClick={() => run('disable', () => api.friendsSettings({ enabled: false }))}>
            Выключить друзей
          </button>
        </aside>
      </div>
    </div>
  )
}

function Head({ right }: { right?: React.ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>Друзья</h1>
        <p className="muted">Кто в сети, во что играет, и как зайти друг к другу в мир</p>
      </div>
      {right}
    </div>
  )
}

function FriendRow({
  f,
  index,
  canInvite,
  busy,
  onJoin,
  onInvite,
  confirm,
  onAskRemove,
  onRemove,
}: {
  f: Friend
  index: number
  canInvite: boolean
  busy: string | null
  onJoin: (f: Friend, host: FriendHost) => void
  onInvite: (f: Friend) => void
  confirm: boolean
  onAskRemove: () => void
  onRemove: () => void
}) {
  const doing = f.online
    ? f.host
      ? `Открыл мир «${f.host.world ?? f.activity?.instance ?? 'Minecraft'}» · ${version(f.host.mc, f.host.loader)}${f.host.mods ? ` · ${f.host.mods} ${plural(f.host.mods, 'мод', 'мода', 'модов')}` : ''}`
      : f.activity
        ? `Играет: ${f.activity.instance} · ${version(f.activity.mc, f.activity.loader)}`
        : STATUS_LABEL[f.status]
    : `Был(а) ${ago(f.lastSeen)}`

  return (
    <div className={`friend-row ${f.online ? 'online' : ''} ${f.host ? 'hosting' : ''}`} style={{ animationDelay: `${Math.min(index, 10) * 30}ms` }}>
      <Initial name={f.nick} status={f.status} />
      <div className="friend-text">
        <strong>{f.nick}</strong>
        <span className="muted small">{doing}</span>
      </div>
      <div className="friend-actions">
        {f.host && (
          <button className="btn primary sm" onClick={() => onJoin(f, f.host!)}>
            <IconPlay size={13} /> Присоединиться
          </button>
        )}
        {canInvite && (
          <button className="btn ghost sm" disabled={busy !== null} onClick={() => onInvite(f)} title="Позвать в мой мир">
            {busy === `inv-${f.id}` ? <span className="spinner xs" /> : <IconSend size={13} />} Позвать
          </button>
        )}
        {confirm ? (
          <>
            <button className="btn danger sm" disabled={busy !== null} onClick={onRemove}>
              Удалить
            </button>
            <button className="btn ghost sm" onClick={onAskRemove}>
              Нет
            </button>
          </>
        ) : (
          <button className="icon-btn danger friend-remove" onClick={onAskRemove} aria-label={`Удалить ${f.nick} из друзей`}>
            <IconTrash size={14} />
          </button>
        )}
      </div>
    </div>
  )
}
