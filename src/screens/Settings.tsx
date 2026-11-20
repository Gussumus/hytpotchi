import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { api } from '../lib/ipc'
import type { JavaList } from '../lib/types'
import { formatMemory } from '../lib/format'
import { IconCoffee, IconDownload, IconFolder } from '../components/Icons'
import { SharedSkinsSettings } from '../components/SharedSkinsSettings'

const JAVA_FOR: Record<number, string> = {
  25: 'Minecraft 26.1 и новее',
  8: 'Minecraft 1.0 – 1.16.5',
  17: 'Minecraft 1.17 – 1.20.4',
  21: 'Minecraft 1.20.5 – 1.21.x',
}

export function Settings() {
  const system = useStore((s) => s.system)
  const toast = useStore((s) => s.toast)
  const prefs = useStore((s) => s.prefs)
  const setPrefs = useStore((s) => s.setPrefs)
  const [java, setJava] = useState<JavaList | null>(null)
  const [installing, setInstalling] = useState<number | null>(null)
  const [discordReady, setDiscordReady] = useState(false)
  const features = useStore((s) => s.features)
  const installUpdate = useStore((s) => s.installUpdate)
  const [checking, setChecking] = useState(false)

  async function checkUpdates() {
    setChecking(true)
    try {
      const u = await api.updateCheck()
      if (u.version) {
        toast('info', `Доступна версия ${u.version}`, { label: 'Обновить', run: installUpdate })
      } else {
        toast('success', `У вас последняя версия (${u.currentVersion})`)
      }
    } catch (e) {
      toast('error', (e as Error).message)
    } finally {
      setChecking(false)
    }
  }
  useEffect(() => {
    api.discordStatus().then((s) => setDiscordReady(s.available)).catch(() => {})
  }, [])

  const load = () => api.javaList().then(setJava).catch((e) => toast('error', (e as Error).message))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => void load(), [])

  async function install(major: number) {
    setInstalling(major)
    try {
      await api.javaInstall(major)
      toast('success', `Java ${major} готова`)
      await load()
    } catch (e) {
      toast('error', (e as Error).message)
    } finally {
      setInstalling(null)
    }
  }

  const managed = new Map((java?.managed ?? []).map((j) => [j.majorVersion, j]))

  return (
    <div className="screen narrow">
      <div className="page-head">
        <div>
          <h1>Настройки</h1>
          <p className="muted">Hytpotchi 0.1.0</p>
        </div>
      </div>

      <section className="settings-block">
        <div className="settings-title">
          <IconCoffee size={18} />
          <div>
            <h3>Java</h3>
            <p className="muted">
              Ставить Java вручную не нужно. При запуске лаунчер читает, какая версия нужна этой версии Minecraft, и сам
              скачивает Eclipse Temurin с проверкой SHA-256. Каждая Java скачивается один раз и потом используется всеми сборками.
            </p>
          </div>
        </div>
        <div className="java-grid">
          {[8, 17, 21, 25].map((major) => {
            const rt = managed.get(major)
            return (
              <div key={major} className={`java-card ${rt ? 'ready' : ''}`}>
                <div className="java-major">Java {major}</div>
                <div className="muted small">{JAVA_FOR[major]}</div>
                {rt ? (
                  <div className="java-status ok">Установлена · {rt.version}</div>
                ) : (
                  <button className="btn ghost sm" disabled={installing !== null} onClick={() => install(major)}>
                    {installing === major ? (
                      <>
                        <span className="spinner xs" /> Скачиваем…
                      </>
                    ) : (
                      <>
                        <IconDownload size={14} /> Скачать заранее
                      </>
                    )}
                  </button>
                )}
              </div>
            )
          })}
        </div>
        {java && java.system.length > 0 && (
          <p className="muted small">
            Найдено в системе: {java.system.map((j) => `Java ${j.majorVersion}`).join(', ')} — для запуска лаунчер использует свои
            проверенные сборки.
          </p>
        )}
      </section>

      <section className="settings-block">
        <div className="setting-row">
          <div>
            <h3>Скрывать лаунчер во время игры</h3>
            <p className="muted small">Окно уберётся в трей при запуске и вернётся, когда вы закроете игру.</p>
          </div>
          <label className="switch">
            <input type="checkbox" checked={prefs.hideOnLaunch} onChange={(e) => setPrefs({ hideOnLaunch: e.target.checked })} />
            <span />
          </label>
        </div>
        <div className="setting-row">
          <div>
            <h3>Статус в Discord</h3>
            <p className="muted small">
              {discordReady
                ? 'Друзья в Discord увидят, в какую сборку вы играете.'
                : 'Нужен ID приложения Discord (HYTPOTCHI_DISCORD_ID) — без него статус не отправляется.'}
            </p>
          </div>
          <label className="switch">
            <input
              type="checkbox"
              checked={prefs.discord && discordReady}
              disabled={!discordReady}
              onChange={(e) => {
                setPrefs({ discord: e.target.checked })
                api.discordSetEnabled(e.target.checked).catch(() => {})
              }}
            />
            <span />
          </label>
        </div>
      </section>

      <SharedSkinsSettings />

      <section className="settings-block">
        <div className="settings-title">
          <IconFolder size={18} />
          <div>
            <h3>Данные</h3>
            <p className="muted">Версии, библиотеки и ресурсы общие для всех сборок — место на диске не дублируется.</p>
          </div>
        </div>
        <div className="row">
          <code className="path">{system?.dataDir ?? '…'}</code>
          <button className="btn ghost" onClick={() => api.openDataFolder()}>
            Открыть папку
          </button>
        </div>
        {system && (
          <p className="muted small">
            Оперативная память: {formatMemory(system.totalMemoryMb)}, для новых сборок рекомендуем {formatMemory(system.recommendedMemoryMb)}.
          </p>
        )}
      </section>

      <section className="settings-block">
        <div className="settings-title">
          <div>
            <h3>О программе</h3>
            <p className="muted">
              Hytpotchi {features?.version ?? ''} — свободный лаунчер Minecraft (GPL-3.0). Не связан с Mojang и Microsoft.
              Моды предоставляются Modrinth.
            </p>
          </div>
        </div>
        {features && (
          <div className="service-list">
            {(
              [
                ['Обновления', features.updater],
                ['Вход через Microsoft', features.microsoft],
                ['Общие скины', features.skinServer],
                ['Статус в Discord', features.discord],
              ] as const
            ).map(([name, on]) => (
              <span key={name} className={`service ${on ? 'on' : ''}`}>
                <span className="service-dot" />
                {name}
              </span>
            ))}
          </div>
        )}
        {features?.updater && (
          <div className="row">
            <button className="btn ghost" disabled={checking} onClick={checkUpdates}>
              {checking ? <span className="spinner xs" /> : null} Проверить обновления
            </button>
          </div>
        )}
      </section>
    </div>
  )
}
