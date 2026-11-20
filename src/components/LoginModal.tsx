import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { api, copyText, isTauri, openExternal } from '../lib/ipc'
import type { DeviceCode } from '../lib/types'
import { Modal } from './Modal'
import { IconCheck, IconCopy, IconExternal, IconMicrosoft, IconUser } from './Icons'

type Tab = 'hytpotchi' | 'microsoft'

export function LoginModal() {
  const modal = useStore((s) => s.modal)
  const setModal = useStore((s) => s.setModal)
  const msReady = useStore((s) => s.features?.microsoft ?? true)
  const opts = modal?.type === 'login' ? modal : null
  const [tab, setTab] = useState<Tab>(opts?.mode ?? 'hytpotchi')

  return (
    <Modal title="Аккаунт" onClose={() => setModal(null)} width={480}>
      {!opts?.replace && (
        <div className="segmented login-tabs">
          <button className={tab === 'hytpotchi' ? 'on' : ''} onClick={() => setTab('hytpotchi')}>
            <IconUser size={14} /> Hytpotchi
          </button>
          <button className={tab === 'microsoft' ? 'on' : ''} onClick={() => setTab('microsoft')}>
            <IconMicrosoft size={14} /> Microsoft
          </button>
        </div>
      )}
      {tab === 'hytpotchi' ? (
        <HytpotchiAuth replace={opts?.replace} />
      ) : msReady ? (
        <MicrosoftLogin />
      ) : (
        <div className="login">
          <p className="muted center">
            Вход через Microsoft появится в одной из следующих версий — его подключение ждёт одобрения Mojang. Пока
            играйте с аккаунтом Hytpotchi.
          </p>
        </div>
      )}
    </Modal>
  )
}

// ---------- Hytpotchi ----------

type Mode = 'login' | 'register' | 'recover'

function HytpotchiAuth({ replace }: { replace?: { id: string; nick: string } }) {
  const setModal = useStore((s) => s.setModal)
  const refresh = useStore((s) => s.refreshAccounts)
  const toast = useStore((s) => s.toast)
  const setFriends = useStore((s) => s.setFriends)
  const features = useStore((s) => s.features)
  const [mode, setMode] = useState<Mode>(replace ? 'register' : 'login')
  const [nick, setNick] = useState(replace?.nick ?? '')
  const [password, setPassword] = useState('')
  const [password2, setPassword2] = useState('')
  const [recovery, setRecovery] = useState('')
  const [server, setServer] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [newCode, setNewCode] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const needServer = features ? !features.skinServer : false
  const nickOk = /^[A-Za-z0-9_]{3,16}$/.test(nick.trim())
  const passOk = password.length >= 8
  const sameOk = mode === 'login' || password === password2
  const recOk = mode !== 'recover' || recovery.replace(/[^A-Za-z0-9]/g, '').length === 16
  const canSubmit = nickOk && passOk && sameOk && recOk && (!needServer || server.trim().length > 8) && !busy

  async function done(nickName: string) {
    await refresh()
    api.friendsRefresh().then(setFriends).catch(() => {})
    toast('success', `Вы вошли как ${nickName}`)
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    try {
      if (needServer) {
        await api.sharedSkinsSet(true, server.trim())
        useStore.setState((s) => ({ features: s.features ? { ...s.features, skinServer: true } : s.features }))
      }
      if (mode === 'login') {
        const acc = await api.hytLogin(nick.trim(), password, replace?.id)
        await done(acc.username)
        setModal(null)
      } else {
        const r =
          mode === 'register'
            ? await api.hytRegister(nick.trim(), password, replace?.id)
            : await api.hytRecover(nick.trim(), recovery, password)
        await done(r.account.username)
        // Код восстановления показываем один раз — пусть сохранит
        if (r.recovery) setNewCode(r.recovery)
        else setModal(null)
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (newCode) {
    return (
      <div className="login hyt-login">
        <div className="login-logo ok">
          <IconCheck size={30} />
        </div>
        <h3 className="center">Сохраните код восстановления</h3>
        <p className="muted small center">
          Это единственный способ вернуть аккаунт, если забудете пароль. Почты у нас нет, поэтому код больше нигде не
          покажется — сохраните его в заметках или менеджере паролей.
        </p>
        <button className="user-code recovery" onClick={() => copyText(newCode).then(() => toast('success', 'Код скопирован'))}>
          <span>{newCode}</span>
          <IconCopy size={16} />
        </button>
        <label className="check-row">
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
          Я сохранил код
        </label>
        <button className="btn primary wide" disabled={!saved} onClick={() => setModal(null)}>
          Готово
        </button>
      </div>
    )
  }

  return (
    <form className="login hyt-login" onSubmit={submit}>
      {replace ? (
        <p className="muted small center">
          Офлайн-аккаунты больше не поддерживаются. Зарегистрируйте ник <b>{replace.nick}</b> в Hytpotchi — скин
          перенесётся, а ник станет только вашим. Если ник уже занят, выберите другой.
        </p>
      ) : (
        <p className="muted small center">
          Один ник — один игрок: никто не сможет играть под вашим ником, и скины не перепутаются. Друзья находят вас по
          нику.
        </p>
      )}

      {!replace && (
        <div className="segmented wide-seg">
          <button type="button" className={mode === 'login' ? 'on' : ''} onClick={() => setMode('login')}>
            Вход
          </button>
          <button type="button" className={mode === 'register' ? 'on' : ''} onClick={() => setMode('register')}>
            Регистрация
          </button>
        </div>
      )}

      {needServer && (
        <label className="field">
          <span>Адрес сервера Hytpotchi</span>
          <input value={server} onChange={(e) => setServer(e.target.value)} placeholder="https://…workers.dev" spellCheck={false} />
        </label>
      )}

      <label className="field">
        <span>Ник</span>
        <input
          value={nick}
          onChange={(e) => setNick(e.target.value)}
          placeholder="Например, Steve_2010"
          maxLength={16}
          autoFocus={!replace}
          spellCheck={false}
          autoComplete="username"
        />
        {nick && !nickOk && <span className="warn small">3–16 символов: латиница, цифры, _</span>}
      </label>

      {mode === 'recover' && (
        <label className="field">
          <span>Код восстановления</span>
          <input
            value={recovery}
            onChange={(e) => setRecovery(e.target.value.toUpperCase())}
            placeholder="XXXX-XXXX-XXXX-XXXX"
            maxLength={19}
            spellCheck={false}
          />
        </label>
      )}

      <label className="field">
        <span>{mode === 'recover' ? 'Новый пароль' : 'Пароль'}</span>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          autoFocus={!!replace}
        />
        {mode !== 'login' && password && !passOk && <span className="warn small">Минимум 8 символов</span>}
      </label>

      {mode !== 'login' && (
        <label className="field">
          <span>Пароль ещё раз</span>
          <input type="password" value={password2} onChange={(e) => setPassword2(e.target.value)} autoComplete="new-password" />
          {password2 && !sameOk && <span className="warn small">Пароли не совпадают</span>}
        </label>
      )}

      {error && <div className="error-box">{error}</div>}

      <button className="btn primary wide" disabled={!canSubmit}>
        {busy && <span className="spinner xs dark" />}
        {mode === 'login' ? 'Войти' : mode === 'register' ? 'Зарегистрироваться' : 'Сменить пароль и войти'}
      </button>

      {!replace && (
        <div className="login-links">
          {mode === 'login' ? (
            <button type="button" className="link" onClick={() => setMode('recover')}>
              Забыли пароль?
            </button>
          ) : mode === 'recover' ? (
            <button type="button" className="link" onClick={() => setMode('login')}>
              Вспомнил пароль
            </button>
          ) : null}
        </div>
      )}
    </form>
  )
}

// ---------- Microsoft ----------

function MicrosoftLogin() {
  const setModal = useStore((s) => s.setModal)
  const refresh = useStore((s) => s.refreshAccounts)
  const toast = useStore((s) => s.toast)
  const [code, setCode] = useState<DeviceCode | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    let timer: number | undefined

    async function run() {
      try {
        const dc = await api.msStart()
        if (!alive.current) return
        setCode(dc)
        const deadline = Date.now() + dc.expiresIn * 1000
        const poll = async () => {
          if (!alive.current) return
          if (Date.now() > deadline) {
            setError('Код истёк — откройте вход заново')
            return
          }
          try {
            const account = await api.msPoll(dc.deviceCode)
            if (account) {
              await refresh()
              toast('success', `Вы вошли как ${account.username}`)
              setModal(null)
              return
            }
            timer = window.setTimeout(poll, Math.max(dc.interval, 3) * 1000)
          } catch (e) {
            if (alive.current) setError((e as Error).message)
          }
        }
        timer = window.setTimeout(poll, Math.max(dc.interval, 3) * 1000)
      } catch (e) {
        if (alive.current) setError((e as Error).message)
      }
    }
    run()
    return () => {
      alive.current = false
      window.clearTimeout(timer)
    }
  }, [refresh, setModal, toast])

  async function copyAndOpen() {
    if (!code) return
    try {
      await copyText(code.userCode)
      setCopied(true)
    } catch (e) {
      console.error('Ошибка копирования:', e)
    }
    try {
      await openExternal(code.verificationUri)
    } catch (e) {
      setError(`Не удалось открыть страницу Microsoft: ${String(e)}`)
    }
  }

  return (
    <div className="login">
      <div className="login-logo">
        <IconMicrosoft size={36} />
      </div>
      {error ? (
        <div className="error-box">{error}</div>
      ) : !code ? (
        <div className="login-wait">
          <span className="spinner" /> Получаем код…
        </div>
      ) : (
        <>
          <ol className="steps">
            <li>Скопируйте код и откройте страницу Microsoft</li>
            <li>Вставьте код и войдите в аккаунт с Minecraft</li>
            <li>Вернитесь сюда — вход завершится сам</li>
          </ol>
          <button className="user-code" onClick={() => copyText(code.userCode).then(() => setCopied(true))}>
            <span>{code.userCode}</span>
            <IconCopy size={16} />
          </button>
          <button className="btn primary wide" onClick={copyAndOpen}>
            <IconExternal size={16} /> {copied ? 'Открыть страницу входа' : 'Скопировать и открыть'}
          </button>
          <div className="login-wait muted">
            <span className="spinner xs" /> Ждём подтверждения…
          </div>
          {!isTauri && <p className="muted small center">Демо-режим браузера: вход не завершится</p>}
        </>
      )}
    </div>
  )
}
