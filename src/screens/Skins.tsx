import { useCallback, useEffect, useState } from 'react'
import { activeAccount, useStore } from '../store'
import { api } from '../lib/ipc'
import type { LibrarySkin, SharedStatus, SkinProfile } from '../lib/types'
import { SkinPreview } from '../components/SkinPreview'
import { SkinViewer3D } from '../components/SkinViewer3D'
import { EMOTES, type EmoteId } from '../lib/emotes'
import { IconCheck, IconPlus, IconShirt, IconTrash, IconUpload } from '../components/Icons'

const POKES: EmoteId[] = ['wave', 'yes', 'clap', 'bow', 'cheer']

export function Skins() {
  const account = useStore(activeAccount)
  const setScreen = useStore((s) => s.setScreen)
  const toast = useStore((s) => s.toast)
  const [profile, setProfile] = useState<SkinProfile | null>(null)
  const [profileError, setProfileError] = useState<string | null>(null)
  const [library, setLibrary] = useState<LibrarySkin[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [variant, setVariant] = useState<'classic' | 'slim'>('classic')
  const [shared, setShared] = useState<SharedStatus | null>(null)
  const [emote, setEmote] = useState<EmoteId>('idle')
  const [tryOn, setTryOn] = useState<LibrarySkin | null>(null)
  const isOffline = account?.kind === 'offline'
  const backToIdle = useCallback(() => setEmote('idle'), [])
  const poke = useCallback(() => setEmote(POKES[Math.floor(Math.random() * POKES.length)]), [])

  const loadLibrary = useCallback(() => {
    api.skinLibrary().then(setLibrary).catch(() => setLibrary([]))
  }, [])

  useEffect(() => {
    loadLibrary()
    setProfile(null)
    setProfileError(null)
    if (account) {
      api
        .skinProfile(account.id)
        .then((p) => {
          setProfile(p)
          setVariant(p.variant)
        })
        .catch((e) => setProfileError((e as Error).message))
    }
  }, [account, loadLibrary])

  async function run<T>(key: string, fn: () => Promise<T>, ok?: string) {
    setBusy(key)
    try {
      const result = await fn()
      if (ok) toast('success', ok)
      useStore.getState().refreshAccounts()
      return result
    } catch (e) {
      toast('error', (e as Error).message)
      return null
    } finally {
      setBusy(null)
    }
  }

  const activeCape = profile?.capes.find((c) => c.active) ?? null

  return (
    <div className="screen">
      <div className="page-head">
        <div>
          <h1>Скины</h1>
          <p className="muted">Библиотека скинов, офлайн-скины и плащи Microsoft</p>
        </div>
        <button
          className="btn primary"
          disabled={busy !== null}
          onClick={async () => {
            const added = await run('add', () => api.skinLibraryAdd(variant))
            if (added) loadLibrary()
          }}
        >
          <IconUpload size={16} /> Добавить скин
        </button>
      </div>

      <div className="skins-layout">
        <section className="skin-stage">
          {account ? (
            profile ? (
              <>
                <div className="skin-stage-preview">
                  <SkinViewer3D
                    src={tryOn?.image ?? profile.skin}
                    slim={(tryOn?.variant ?? profile.variant) === 'slim'}
                    cape={activeCape?.image}
                    emote={emote}
                    onEmoteEnd={backToIdle}
                    onPoke={poke}
                    nameTag={profile.username}
                  />
                  {tryOn && <span className="try-on-badge">Примерка: {tryOn.name}</span>}
                  <span className="skin3d-hint">Тяните, чтобы повернуть · клик — эмоция</span>
                </div>
                <div className="emote-bar" role="group" aria-label="Позы и эмоции">
                  {(['pose', 'emote'] as const).map((group) => (
                    <div key={group} className="emote-row">
                      {EMOTES.filter((e) => e.group === group).map((e) => (
                        <button
                          key={e.id}
                          className={`emote-chip ${emote === e.id ? 'on' : ''}`}
                          onClick={() => setEmote(emote === e.id && e.id !== 'idle' ? 'idle' : e.id)}
                          title={e.label}
                        >
                          <span className="emote-emoji" aria-hidden="true">
                            {e.emoji}
                          </span>
                          {e.label}
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
                <div className="skin-stage-info">
                  <strong>{profile.username}</strong>
                  <span className="muted small">
                    {profile.skin ? (profile.variant === 'slim' ? 'Тонкие руки (Alex)' : 'Классическая модель (Steve)') : 'Стандартный скин'}
                  </span>
                </div>
                {isOffline && (
                  <div className="info-box left">
                    <strong>Офлайн-скин для всех игроков Hytpotchi</strong>
                    <span>
                      «Надеть» публикует скин на общий сервер скинов, и его видят все, кто играет через Hytpotchi. Работает
                      в сборках с Fabric, Forge, NeoForge или Quilt: нужный мод лаунчер ставит сам.
                    </span>
                    {shared && <span className={`shared-status ${shared.state}`}>{shared.message}</span>}
                    {profile.skin && (
                      <button
                        className="btn ghost sm"
                        disabled={busy !== null}
                        onClick={async () => {
                          const st = await run('publish', () => api.skinPublish(account!.id))
                          if (st) setShared(st)
                        }}
                      >
                        <IconUpload size={14} /> Опубликовать ещё раз
                      </button>
                    )}
                  </div>
                )}
                <div className="row">
                  <button
                    className="btn ghost sm"
                    disabled={busy !== null || !profile.skin || isOffline}
                    onClick={async () => {
                      const s = await run('save', () => api.skinSaveCurrent(account!.id), 'Скин сохранён в библиотеку')
                      if (s) loadLibrary()
                    }}
                  >
                    <IconPlus size={14} /> В библиотеку
                  </button>
                  <button
                    className="btn ghost sm"
                    disabled={busy !== null}
                    onClick={async () => {
                      const p = await run('reset', () => api.skinReset(account!.id), 'Скин сброшен')
                      if (p) setProfile(p)
                    }}
                  >
                    Сбросить
                  </button>
                </div>
                {profile.capes.length > 0 && (
                  <div className="capes">
                    <span className="muted small">Плащи</span>
                    <div className="cape-list">
                      <button
                        className={`cape ${!activeCape ? 'on' : ''}`}
                        disabled={busy !== null}
                        onClick={async () => {
                          const p = await run('cape', () => api.capeSet(account!.id, null))
                          if (p) setProfile(p)
                        }}
                        title="Без плаща"
                      >
                        <span className="cape-none">—</span>
                      </button>
                      {profile.capes.map((c) => (
                        <button
                          key={c.id}
                          className={`cape ${c.active ? 'on' : ''}`}
                          disabled={busy !== null}
                          title={c.name}
                          onClick={async () => {
                            const p = await run('cape', () => api.capeSet(account!.id, c.id), `Плащ «${c.name}» надет`)
                            if (p) setProfile(p)
                          }}
                        >
                          {c.image ? <span className="cape-img" style={{ backgroundImage: `url(${c.image})` }} /> : c.name}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </>
            ) : profileError ? (
              <div className="error-box">{profileError}</div>
            ) : (
              <div className="empty">
                <span className="spinner" />
              </div>
            )
          ) : (
            <div className="empty-state small">
              <IconShirt size={34} />
              <p className="muted">
                Добавьте аккаунт — Microsoft или офлайн, — чтобы надеть скин.
              </p>
              <button className="btn primary" onClick={() => setScreen('accounts')}>
                Добавить аккаунт
              </button>
            </div>
          )}
        </section>

        <section className="skin-library">
          <div className="tab-toolbar">
            <strong>Библиотека</strong>
            <div className="segmented">
              <button className={variant === 'classic' ? 'on' : ''} onClick={() => setVariant('classic')}>
                Steve
              </button>
              <button className={variant === 'slim' ? 'on' : ''} onClick={() => setVariant('slim')}>
                Alex
              </button>
            </div>
          </div>
          {library.length === 0 && (
            <div className="empty-state small">
              <p className="muted">Добавьте PNG-скин 64×64 — он сохранится здесь, и его можно будет надеть в один клик</p>
            </div>
          )}
          <div className="skin-grid">
            {library.map((s, i) => (
              <div
                key={s.id}
                className="skin-card"
                style={{ animationDelay: `${Math.min(i, 12) * 35}ms` }}
                onMouseEnter={() => setTryOn(s)}
                onMouseLeave={() => setTryOn((t) => (t?.id === s.id ? null : t))}
              >
                <SkinPreview src={s.image} slim={s.variant === 'slim'} scale={3} />
                <strong title={s.name}>{s.name}</strong>
                <div className="row">
                  <button
                    className="btn primary sm"
                    disabled={!account || busy !== null}
                    title="Надеть"
                    onClick={async () => {
                      const p = await run(s.id, () => api.skinApply(account!.id, s.id, variant))
                      if (p) {
                        setProfile(p)
                        setTryOn(null)
                        setEmote('cheer')
                        window.setTimeout(() => setEmote((e) => (e === 'cheer' ? 'idle' : e)), 2200)
                        if (p.shared) {
                          setShared(p.shared)
                          toast(p.shared.state === 'published' ? 'success' : 'info', p.shared.message)
                        } else {
                          toast('success', `Скин «${s.name}» надет`)
                        }
                      }
                    }}
                  >
                    {busy === s.id ? <span className="spinner xs dark" /> : <IconCheck size={13} />} Надеть
                  </button>
                  <button
                    className="icon-btn danger"
                    onClick={async () => {
                      await run('rm', () => api.skinLibraryRemove(s.id))
                      loadLibrary()
                    }}
                    aria-label={`Удалить ${s.name}`}
                  >
                    <IconTrash size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}
