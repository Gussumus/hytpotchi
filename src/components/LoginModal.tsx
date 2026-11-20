import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { api, copyText, isTauri, openExternal } from '../lib/ipc'
import type { DeviceCode } from '../lib/types'
import { Modal } from './Modal'
import { IconCopy, IconExternal, IconMicrosoft } from './Icons'

export function LoginModal() {
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
    console.error('Ошибка открытия браузера:', e)
    setError(`Не удалось открыть страницу Microsoft: ${String(e)}`)
  }
}


  return (
    <Modal title="Вход через Microsoft" onClose={() => setModal(null)} width={480}>
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
    </Modal>
  )
}
