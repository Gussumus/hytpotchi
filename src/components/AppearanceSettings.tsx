import { useState } from 'react'
import { useStore, type Screen } from '../store'
import { api } from '../lib/ipc'
import {
  ACCENT_PRESETS,
  DEFAULT_APPEARANCE,
  PRESETS,
  SCREEN_LABELS,
  bgFor,
  type BgRef,
  type MotionLevel,
} from '../lib/appearance'
import { BackgroundView } from './AppBackground'
import { IconPlus, IconTrash } from './Icons'

type Target = 'all' | Screen

const TARGETS: Target[] = ['all', 'home', 'instance', 'content', 'skins', 'accounts', 'settings']

function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  unit,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  unit: string
  onChange: (v: number) => void
}) {
  const pct = ((value - min) / (max - min)) * 100
  return (
    <label className="ap-slider">
      <span className="ap-slider-head">
        <span>{label}</span>
        <b>
          {value}
          {unit}
        </b>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ ['--pct' as string]: `${pct}%` }}
      />
    </label>
  )
}

/** Настройки внешнего вида: фоны (общий и для каждого экрана), цвета, масштаб, анимации */
export function AppearanceSettings() {
  const a = useStore((s) => s.appearance)
  const set = useStore((s) => s.setAppearance)
  const backgrounds = useStore((s) => s.backgrounds)
  const setBackgrounds = useStore((s) => s.setBackgrounds)
  const toast = useStore((s) => s.toast)
  const [target, setTarget] = useState<Target>('all')
  const [adding, setAdding] = useState(false)

  const current: BgRef | undefined = target === 'all' ? a.background : a.perScreen[target]

  function choose(ref: BgRef | null) {
    if (target === 'all') {
      if (ref) set({ background: ref })
      return
    }
    const perScreen = { ...a.perScreen }
    if (ref) perScreen[target] = ref
    else delete perScreen[target]
    set({ perScreen })
  }

  async function add() {
    setAdding(true)
    try {
      const bg = await api.backgroundAdd()
      if (bg) {
        setBackgrounds([...backgrounds, bg])
        choose(`custom:${bg.id}`)
        toast('success', `Фон «${bg.name}» добавлен`)
      }
    } catch (e) {
      toast('error', (e as Error).message)
    } finally {
      setAdding(false)
    }
  }

  async function remove(id: string) {
    try {
      setBackgrounds(await api.backgroundRemove(id))
    } catch (e) {
      toast('error', (e as Error).message)
    }
  }

  /** На каких экранах сейчас стоит этот фон — подписываем плитку */
  function usedOn(ref: BgRef): string[] {
    return (Object.keys(SCREEN_LABELS) as Screen[]).filter((s) => bgFor(a, s) === ref).map((s) => SCREEN_LABELS[s])
  }

  const tiles: { ref: BgRef; name: string; removable?: string; video?: boolean }[] = [
    ...PRESETS.map((p) => ({ ref: `preset:${p.id}`, name: p.name })),
    ...backgrounds.map((b) => ({ ref: `custom:${b.id}`, name: b.name, removable: b.id, video: b.kind === 'video' })),
  ]

  return (
    <section className="settings-block appearance">
      <div className="settings-title">
        <span className="ap-swatch-icon" aria-hidden="true" />
        <div>
          <h3>Внешний вид</h3>
          <p className="muted">
            Свои картинки, GIF и видео на фон — на весь лаунчер или отдельно на каждый экран. Плюс цвет, масштаб и
            анимации.
          </p>
        </div>
      </div>

      <div className="ap-group">
        <div className="ap-group-head">
          <strong>Фон</strong>
          <div className="segmented ap-targets" role="tablist" aria-label="Где менять фон">
            {TARGETS.map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={target === t}
                className={`${target === t ? 'on' : ''} ${t !== 'all' && a.perScreen[t] ? 'has-own' : ''}`}
                onClick={() => setTarget(t)}
              >
                {t === 'all' ? 'Везде' : SCREEN_LABELS[t]}
              </button>
            ))}
          </div>
        </div>
        <p className="muted small">
          {target === 'all'
            ? 'Общий фон для всех экранов. Экран со своим фоном отмечен точкой.'
            : `Фон для экрана «${SCREEN_LABELS[target]}». «Как везде» — использовать общий фон.`}
        </p>

        <div className="bg-grid">
          {target !== 'all' && (
            <button className={`bg-tile inherit ${current === undefined ? 'on' : ''}`} onClick={() => choose(null)}>
              <span className="bg-tile-preview">
                <BackgroundView bgRef={a.background} backgrounds={backgrounds} paused />
                <span className="bg-tile-inherit">↺</span>
              </span>
              <span className="bg-tile-name">Как везде</span>
            </button>
          )}
          {tiles.map((t) => {
            const used = usedOn(t.ref)
            return (
              <div key={t.ref} className={`bg-tile ${current === t.ref ? 'on' : ''}`}>
                <button className="bg-tile-hit" onClick={() => choose(t.ref)} title={used.length ? `Сейчас: ${used.join(', ')}` : t.name}>
                  <span className="bg-tile-preview">
                    <BackgroundView bgRef={t.ref} backgrounds={backgrounds} paused />
                    {t.video && <span className="bg-tile-badge">видео</span>}
                  </span>
                  <span className="bg-tile-name">{t.name}</span>
                  {used.length > 0 && <span className="bg-tile-used">{used.length === 6 ? 'везде' : used.join(', ')}</span>}
                </button>
                {t.removable && (
                  <button className="icon-btn danger bg-tile-remove" onClick={() => remove(t.removable!)} aria-label={`Удалить фон ${t.name}`}>
                    <IconTrash size={13} />
                  </button>
                )}
              </div>
            )
          })}
          <button className="bg-tile add" onClick={add} disabled={adding}>
            <span className="bg-tile-preview">
              {adding ? <span className="spinner" /> : <IconPlus size={22} />}
            </span>
            <span className="bg-tile-name">Свой фон</span>
            <span className="bg-tile-used">PNG, JPG, WebP, GIF, MP4, WebM</span>
          </button>
        </div>

        <div className="ap-sliders">
          <Slider label="Затемнение" value={a.dim} min={0} max={90} unit="%" onChange={(dim) => set({ dim })} />
          <Slider label="Размытие" value={a.blur} min={0} max={30} unit=" px" onChange={(blur) => set({ blur })} />
          <Slider label="Плотность панелей" value={a.panel} min={10} max={100} unit="%" onChange={(panel) => set({ panel })} />
        </div>
        <div className="setting-row">
          <div>
            <h3>Параллакс</h3>
            <p className="muted small">Фон слегка смещается вслед за курсором.</p>
          </div>
          <label className="switch">
            <input type="checkbox" checked={a.parallax} onChange={(e) => set({ parallax: e.target.checked })} />
            <span />
          </label>
        </div>
        <div className="setting-row">
          <div>
            <h3>Пауза видеофона во время игры</h3>
            <p className="muted small">Не тратить видеокарту на фон, пока запущен Minecraft.</p>
          </div>
          <label className="switch">
            <input type="checkbox" checked={a.pauseVideoInGame} onChange={(e) => set({ pauseVideoInGame: e.target.checked })} />
            <span />
          </label>
        </div>
      </div>

      <div className="ap-group">
        <strong>Цвет акцента</strong>
        <div className="accent-row">
          {ACCENT_PRESETS.map((c) => (
            <button
              key={c}
              className={`accent-dot ${a.accent.toLowerCase() === c ? 'on' : ''}`}
              style={{ background: c }}
              onClick={() => set({ accent: c })}
              aria-label={`Акцент ${c}`}
            />
          ))}
          <label className={`accent-dot custom ${ACCENT_PRESETS.includes(a.accent.toLowerCase()) ? '' : 'on'}`} title="Свой цвет">
            <input type="color" value={a.accent} onChange={(e) => set({ accent: e.target.value })} />
          </label>
        </div>
      </div>

      <div className="ap-group">
        <strong>Интерфейс</strong>
        <div className="ap-sliders">
          <Slider label="Масштаб" value={a.scale} min={80} max={130} step={5} unit="%" onChange={(scale) => set({ scale })} />
          <Slider
            label="Скругление углов"
            value={Math.round(a.roundness * 100)}
            min={0}
            max={200}
            step={10}
            unit="%"
            onChange={(v) => set({ roundness: v / 100 })}
          />
        </div>
        <div className="setting-row">
          <div>
            <h3>Анимации</h3>
            <p className="muted small">«Меньше» убирает декоративные эффекты, «Выкл.» — всё движение.</p>
          </div>
          <div className="segmented">
            {(
              [
                ['full', 'Полные'],
                ['reduced', 'Меньше'],
                ['off', 'Выкл.'],
              ] as [MotionLevel, string][]
            ).map(([m, label]) => (
              <button key={m} className={a.motion === m ? 'on' : ''} onClick={() => set({ motion: m })}>
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="row">
        <button className="btn ghost sm" onClick={() => set({ ...DEFAULT_APPEARANCE })}>
          Сбросить внешний вид
        </button>
        <span className="muted small">Свои фоны при этом не удаляются.</span>
      </div>
    </section>
  )
}
