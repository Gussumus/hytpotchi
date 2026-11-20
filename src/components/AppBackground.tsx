import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { PRESETS, bgFor, customSrc, motionReduced, type BgRef, type CustomBackground } from '../lib/appearance'

interface Layer {
  key: number
  ref: BgRef
}

/** Один слой фона: встроенный градиент, картинка или видео */
export function BackgroundView({
  bgRef,
  backgrounds,
  paused = false,
  className = '',
}: {
  bgRef: BgRef
  backgrounds: CustomBackground[]
  paused?: boolean
  className?: string
}) {
  const video = useRef<HTMLVideoElement>(null)
  const [kind, id] = bgRef.split(':') as ['preset' | 'custom', string]
  const custom = kind === 'custom' ? backgrounds.find((b) => b.id === id) : undefined

  useEffect(() => {
    const v = video.current
    if (!v) return
    if (paused) v.pause()
    else v.play().catch(() => {})
  }, [paused, custom?.id])

  if (custom?.kind === 'video') {
    return (
      <video
        ref={video}
        className={`bg-media ${className}`}
        src={customSrc(custom)}
        autoPlay={!paused}
        muted
        loop
        playsInline
        disablePictureInPicture
      />
    )
  }
  if (custom) {
    return <div className={`bg-media ${className}`} style={{ backgroundImage: `url("${customSrc(custom)}")` }} />
  }
  const preset = PRESETS.find((p) => p.id === id) ?? PRESETS[0]
  return <div className={`bg-media bg-preset ${preset.animated ? 'drift' : ''} ${className}`} style={{ background: preset.css }} />
}

/**
 * Фон всего лаунчера. Свой для каждого экрана (если задан), иначе общий.
 * При смене фона старый слой плавно растворяется под новым.
 */
export function AppBackground() {
  const screen = useStore((s) => s.screen)
  const appearance = useStore((s) => s.appearance)
  const backgrounds = useStore((s) => s.backgrounds)
  const gameRunning = useStore((s) => s.instances.some((i) => i.running))
  const ref = bgFor(appearance, screen)
  const [layers, setLayers] = useState<Layer[]>([{ key: 0, ref }])
  const seq = useRef(0)
  const host = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setLayers((prev) => {
      if (prev[prev.length - 1]?.ref === ref) return prev
      return [...prev.slice(-1), { key: ++seq.current, ref }]
    })
  }, [ref])

  // Убираем растворившийся слой
  useEffect(() => {
    if (layers.length < 2) return
    const t = window.setTimeout(() => setLayers((l) => l.slice(-1)), 700)
    return () => window.clearTimeout(t)
  }, [layers])

  // Параллакс: фон чуть смещается за курсором
  useEffect(() => {
    const el = host.current
    if (!el) return
    if (!appearance.parallax || motionReduced()) {
      el.style.setProperty('--px', '0px')
      el.style.setProperty('--py', '0px')
      return
    }
    let raf = 0
    const move = (e: PointerEvent) => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const x = (e.clientX / window.innerWidth - 0.5) * -18
        const y = (e.clientY / window.innerHeight - 0.5) * -12
        el.style.setProperty('--px', `${x.toFixed(1)}px`)
        el.style.setProperty('--py', `${y.toFixed(1)}px`)
      })
    }
    window.addEventListener('pointermove', move)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('pointermove', move)
    }
  }, [appearance.parallax, appearance.motion])

  const paused = appearance.pauseVideoInGame && gameRunning

  return (
    <div ref={host} className="app-bg" aria-hidden="true">
      {layers.map((l, i) => (
        <BackgroundView
          key={l.key}
          bgRef={l.ref}
          backgrounds={backgrounds}
          paused={paused}
          className={i === layers.length - 1 && layers.length > 1 ? 'bg-enter' : ''}
        />
      ))}
      <div className="bg-dim" />
    </div>
  )
}
