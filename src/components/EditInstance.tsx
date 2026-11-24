import { useState } from 'react'
import { useStore } from '../store'
import { api } from '../lib/ipc'
import { ACCENTS, guessJava, loaderName } from '../lib/format'
import { Modal } from './Modal'
import { MemorySlider } from './MemorySlider'
import { LoaderVersionPicker } from './LoaderVersionPicker'
import { IconImage, IconPackage, IconTrash } from './Icons'

export function EditInstance({ id }: { id: string }) {
  const inst = useStore((s) => s.instances.find((i) => i.id === id))
  const setModal = useStore((s) => s.setModal)
  const refresh = useStore((s) => s.refreshInstances)
  const toast = useStore((s) => s.toast)

  const [name, setName] = useState(inst?.name ?? '')
  const [memory, setMemory] = useState(inst?.memoryMb ?? 4096)
  const [jvmArgs, setJvmArgs] = useState(inst?.jvmArgs ?? '')
  const [accent, setAccent] = useState(inst?.accent ?? ACCENTS[0])
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [busy, setBusy] = useState(false)
  const [group, setGroup] = useState(inst?.group ?? '')
  /** "" — рекомендуемая */
  const initialLoaderVersion = inst?.loaderPinned ? inst.loaderVersion ?? '' : ''
  const [loaderVersion, setLoaderVersion] = useState(initialLoaderVersion)
  const allInstances = useStore((s) => s.instances)
  const setPack = useStore((s) => s.setPack)
  const groups = [...new Set(allInstances.map((i) => i.group).filter(Boolean) as string[])]

  if (!inst) return null
  const java = guessJava(inst.gameVersion)

  async function pickCover() {
    try {
      if (await api.setCover(id)) await refresh()
    } catch (e) {
      toast('error', (e as Error).message)
    }
  }
  async function dropCover() {
    try {
      await api.clearCover(id)
      await refresh()
    } catch (e) {
      toast('error', (e as Error).message)
    }
  }
  async function exportPack() {
    try {
      const path = await api.exportInstance(id)
      setPack(null)
      if (path) toast('success', `Модпак сохранён: ${path}`)
    } catch (e) {
      setPack(null)
      toast('error', (e as Error).message)
    }
  }

  async function save() {
    setBusy(true)
    try {
      const loaderChanged = !!inst?.loader && loaderVersion !== initialLoaderVersion
      await api.instanceUpdate(id, {
        name,
        memoryMb: memory,
        jvmArgs,
        accent,
        group,
        ...(loaderChanged ? { loaderVersion } : {}),
      })
      await refresh()
      setModal(null)
      if (loaderChanged) toast('success', 'Загрузчик переустановится при следующем запуске')
    } catch (e) {
      toast('error', (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    setBusy(true)
    try {
      await api.instanceRemove(id)
      await refresh()
      setModal(null)
      toast('success', 'Сборка удалена')
    } catch (e) {
      toast('error', (e as Error).message)
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Настройки сборки"
      subtitle={`${loaderName(inst.loader)} · Minecraft ${inst.gameVersion}${inst.loaderVersion ? ` · загрузчик ${inst.loaderVersion}` : ''}`}
      onClose={() => setModal(null)}
      footer={
        <>
          {confirmDelete ? (
            <div className="confirm-row">
              <span>Удалить сборку вместе с мирами?</span>
              <button className="btn danger" disabled={busy || inst.running} onClick={remove}>
                Да, удалить
              </button>
              <button className="btn ghost" onClick={() => setConfirmDelete(false)}>
                Нет
              </button>
            </div>
          ) : (
            <>
              <button className="btn ghost danger-text" onClick={() => setConfirmDelete(true)} disabled={inst.running}>
                <IconTrash size={15} /> Удалить
              </button>
              <button className="btn ghost" onClick={exportPack} title="Поделиться сборкой с друзьями">
                <IconPackage size={15} /> Экспорт .mrpack
              </button>
              <div className="spacer" />
              <button className="btn ghost" onClick={() => setModal(null)}>
                Отмена
              </button>
              <button className="btn primary" disabled={busy} onClick={save}>
                Сохранить
              </button>
            </>
          )}
        </>
      }
    >
      <label className="field">
        <span>Название</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={48} />
      </label>
      <div className="field">
        <span>Цвет</span>
        <div className="swatches">
          {ACCENTS.map((c) => (
            <button key={c} className={`swatch ${accent === c ? 'on' : ''}`} style={{ background: c }} onClick={() => setAccent(c)} aria-label={`Цвет ${c}`} />
          ))}
        </div>
      </div>
      <label className="field">
        <span>Группа</span>
        <input
          value={group}
          onChange={(e) => setGroup(e.target.value)}
          placeholder="Без группы"
          maxLength={32}
          list="hyt-groups"
        />
        <datalist id="hyt-groups">
          {groups.map((g) => (
            <option key={g} value={g} />
          ))}
        </datalist>
      </label>
      <div className="field">
        <span>Обложка</span>
        <div className="row">
          <button className="btn ghost sm" onClick={pickCover}>
            <IconImage size={14} /> Своя картинка
          </button>
          {inst.cover && (
            <button className="btn ghost sm" onClick={dropCover}>
              Вернуть пиксельный пейзаж
            </button>
          )}
        </div>
      </div>
      {inst.loader && (
        <LoaderVersionPicker
          loader={inst.loader}
          gameVersion={inst.gameVersion}
          value={loaderVersion}
          onChange={setLoaderVersion}
          installed={inst.versionId ? inst.loaderVersion : null}
        />
      )}
      <div className="field">
        <span>Оперативная память</span>
        <MemorySlider value={memory} onChange={setMemory} />
      </div>
      <div className="info-box">
        <strong>Java {java ?? 'авто'}</strong>
        <span>Лаунчер сам скачивает и использует нужную версию Java для этой версии Minecraft. Ничего ставить не нужно.</span>
      </div>
      <label className="field">
        <span>Дополнительные аргументы JVM</span>
        <input
          className="mono"
          value={jvmArgs}
          onChange={(e) => setJvmArgs(e.target.value)}
          placeholder="например -Dsodium.checks.issue2561=false"
        />
      </label>
    </Modal>
  )
}
