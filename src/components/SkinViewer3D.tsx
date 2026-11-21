import { useEffect, useRef } from 'react'
import { NameTagObject, SkinViewer } from 'skinview3d'
import { emoteById, type EmoteId } from '../lib/emotes'
import { motionReduced } from '../lib/appearance'
import { attachCosmetics } from '../lib/cosmetics3d'
import type { CosmeticDef } from '../lib/types'

/** Угол, под которым персонаж стоит по умолчанию: три четверти, чтобы был виден объём */
const BASE_YAW = -0.45

const reducedMotion = motionReduced

/** Нейтральный манекен, если скин не задан (своя текстура, без ассетов Mojang) */
let mannequin: string | null = null
function mannequinSkin(): string {
  if (mannequin) return mannequin
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d')!
  g.fillStyle = '#7d838c'
  g.fillRect(0, 0, 64, 32)
  g.fillRect(16, 32, 32, 32)
  g.fillRect(0, 48, 16, 16)
  g.fillStyle = '#5f656e'
  for (const [x, y, w, h] of [
    [0, 20, 16, 12], // правая нога
    [16, 48, 16, 16], // левая нога
  ])
    g.fillRect(x, y, w, h)
  g.fillStyle = '#9aa0a8'
  g.fillRect(8, 8, 8, 8) // лицо
  g.fillStyle = '#2b2f36'
  g.fillRect(9, 12, 2, 1)
  g.fillRect(13, 12, 2, 1)
  mannequin = c.toDataURL()
  return mannequin
}

interface Props {
  src: string | null
  slim: boolean
  cape?: string | null
  /** Надетая косметика (шапки, крылья…) */
  cosmetics?: CosmeticDef[]
  emote?: EmoteId
  /** Разовая эмоция закончилась — можно вернуть «Стоять» */
  onEmoteEnd?: () => void
  /** Клик по персонажу */
  onPoke?: () => void
  nameTag?: string | null
  height?: number
}

/** 3D-предпросмотр скина: вращение мышью, позы и эмоции */
export function SkinViewer3D({ src, slim, cape, cosmetics, emote = 'idle', onEmoteEnd, onPoke, nameTag, height = 360 }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<SkinViewer | null>(null)
  const endRef = useRef(onEmoteEnd)
  endRef.current = onEmoteEnd

  // Создаём сцену один раз; свой canvas, чтобы после dispose() не переиспользовать потерянный контекст
  useEffect(() => {
    const el = host.current
    if (!el) return
    const viewer = new SkinViewer({
      width: el.clientWidth || 300,
      height,
      pixelRatio: 'match-device',
      preserveDrawingBuffer: false,
    })
    viewer.canvas.className = 'skin3d-canvas'
    viewer.background = null
    viewer.fov = 40
    viewer.zoom = 0.62
    viewer.controls.enableZoom = false
    viewer.controls.enablePan = false
    viewer.controls.rotateSpeed = 0.8
    viewer.globalLight.intensity = 3
    viewer.cameraLight.intensity = 0.6
    viewer.playerWrapper.rotation.y = BASE_YAW
    el.appendChild(viewer.canvas)
    viewerRef.current = viewer

    const ro = new ResizeObserver(() => {
      const w = el.clientWidth
      if (w > 0) viewer.setSize(w, el.clientHeight || height)
    })
    ro.observe(el)

    // Не рисуем, когда экран скрыт: WebGL не должен грузить GPU в фоне
    const onVis = () => (viewer.renderPaused = document.hidden)
    document.addEventListener('visibilitychange', onVis)

    return () => {
      document.removeEventListener('visibilitychange', onVis)
      ro.disconnect()
      viewer.dispose()
      viewer.canvas.remove()
      viewerRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- размер подхватывает ResizeObserver
  }, [])

  // Скин + эффектный разворот при смене
  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    viewer.loadSkin(src ?? mannequinSkin(), { model: slim ? 'slim' : 'default' })
    if (reducedMotion()) return
    const wrapper = viewer.playerWrapper
    const from = BASE_YAW - Math.PI * 2
    const start = performance.now()
    let raf = 0
    const tick = (now: number) => {
      const k = Math.min((now - start) / 750, 1)
      const ease = 1 - Math.pow(1 - k, 3)
      wrapper.rotation.y = from + (BASE_YAW - from) * ease
      wrapper.position.y = Math.sin(k * Math.PI) * 3
      if (k < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      wrapper.rotation.y = BASE_YAW
      wrapper.position.y = 0
    }
  }, [src, slim])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    if (cape) viewer.loadCape(cape)
    else viewer.loadCape(null)
  }, [cape])

  // Косметика: строится заново при смене набора (и после перезагрузки скина)
  const cosmeticsKey = (cosmetics ?? []).map((c) => c.id).join(',')
  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || !cosmetics?.length) return
    return attachCosmetics(viewer, cosmetics)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- набор задаёт cosmeticsKey
  }, [cosmeticsKey, src, slim])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    viewer.nameTag = nameTag
      ? new NameTagObject(nameTag, {
          font: "600 48px 'Segoe UI Variable Display', 'Segoe UI', Inter, system-ui, sans-serif",
          backgroundStyle: 'rgba(0, 0, 0, 0.35)',
          margin: [6, 14, 6, 14],
          height: 3.2,
        })
      : null
  }, [nameTag])

  // Поза / эмоция
  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    const def = emoteById(emote)
    const player = viewer.playerObject
    player.position.set(0, 0, 0)
    player.rotation.set(0, 0, 0)
    const anim = def.make()
    if (reducedMotion()) anim.speed = 0.5
    viewer.animation = anim
    if (!def.duration) return
    const timer = window.setTimeout(() => endRef.current?.(), (def.duration * 1000) / anim.speed)
    return () => window.clearTimeout(timer)
  }, [emote])

  // Клик (а не перетаскивание) по персонажу
  useEffect(() => {
    const el = host.current
    if (!el || !onPoke) return
    let x = 0
    let y = 0
    const down = (e: PointerEvent) => ((x = e.clientX), (y = e.clientY))
    const up = (e: PointerEvent) => {
      if (Math.hypot(e.clientX - x, e.clientY - y) < 4) onPoke()
    }
    el.addEventListener('pointerdown', down)
    el.addEventListener('pointerup', up)
    return () => {
      el.removeEventListener('pointerdown', down)
      el.removeEventListener('pointerup', up)
    }
  }, [onPoke])

  return <div ref={host} className="skin3d" style={{ height }} aria-label="3D-предпросмотр скина" role="img" />
}
