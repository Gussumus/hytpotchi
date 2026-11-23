import { convertFileSrc } from '@tauri-apps/api/core'
import type { Screen } from '../store'

/** Свой фон, сохранённый бэкендом в <данные>/backgrounds */
export interface CustomBackground {
  id: string
  name: string
  kind: 'image' | 'video'
  path: string
  file: string
}

/** 'preset:<id>' — встроенный градиент, 'custom:<id>' — свой файл */
export type BgRef = string

export type MotionLevel = 'full' | 'reduced' | 'off'

export interface Appearance {
  /** Фон по умолчанию для всех экранов */
  background: BgRef
  /** Свой фон для отдельных экранов; нет ключа — как везде */
  perScreen: Partial<Record<Screen, BgRef>>
  /** Затемнение фона, % */
  dim: number
  /** Размытие фона, px */
  blur: number
  /** Непрозрачность панелей поверх фона, % */
  panel: number
  /** Цвет акцента (кнопки, переключатели, подсветка) */
  accent: string
  /** Масштаб интерфейса, % */
  scale: number
  /** Скругление углов: множитель к стандартному */
  roundness: number
  motion: MotionLevel
  /** Фон слегка следует за мышью */
  parallax: boolean
  /** Ставить видеофон на паузу, пока идёт игра */
  pauseVideoInGame: boolean
}

export const SCREEN_LABELS: Record<Screen, string> = {
  home: 'Главная',
  instance: 'Сборка',
  content: 'Каталог',
  friends: 'Друзья',
  skins: 'Скины',
  cosmetics: 'Косметика',
  accounts: 'Аккаунты',
  settings: 'Настройки',
}

export interface Preset {
  id: string
  name: string
  /** CSS-фон слоя */
  css: string
  /** Медленно «дышит» */
  animated?: boolean
}

export const PRESETS: Preset[] = [
  {
    id: 'default',
    name: 'Стандартный',
    css: 'radial-gradient(900px 500px at 85% -10%, rgba(61,220,132,.09), transparent 60%), radial-gradient(700px 500px at -10% 110%, rgba(79,140,255,.07), transparent 60%), #0a0c10',
  },
  {
    id: 'accent',
    name: 'Под акцент',
    css: 'radial-gradient(1000px 600px at 80% -10%, rgba(var(--mint-rgb),.22), transparent 60%), radial-gradient(800px 600px at 0% 110%, rgba(var(--mint-rgb),.10), transparent 60%), #090b0f',
  },
  {
    id: 'night',
    name: 'Ночь',
    css: 'radial-gradient(1100px 700px at 75% 0%, #1d2a5c 0%, transparent 60%), radial-gradient(900px 700px at 10% 100%, #2a1647 0%, transparent 60%), #070812',
    animated: true,
  },
  {
    id: 'sunset',
    name: 'Закат',
    css: 'radial-gradient(1000px 650px at 85% 110%, #ff7a45cc 0%, transparent 55%), radial-gradient(900px 600px at 10% 0%, #6b2a7a 0%, transparent 60%), linear-gradient(180deg, #1b1027, #2b1420)',
    animated: true,
  },
  {
    id: 'ocean',
    name: 'Океан',
    css: 'radial-gradient(1000px 700px at 20% 0%, #0f5d78 0%, transparent 60%), radial-gradient(900px 700px at 100% 100%, #0b3b6e 0%, transparent 60%), #04121a',
    animated: true,
  },
  {
    id: 'aurora',
    name: 'Сияние',
    css: 'radial-gradient(800px 420px at 30% 10%, #1fd39a66 0%, transparent 60%), radial-gradient(700px 420px at 70% 25%, #7c4dff55 0%, transparent 60%), radial-gradient(900px 600px at 50% 120%, #0e3b4a 0%, transparent 60%), #050a10',
    animated: true,
  },
  {
    id: 'forest',
    name: 'Лес',
    css: 'radial-gradient(1000px 700px at 80% 0%, #2f5d2c 0%, transparent 60%), radial-gradient(900px 700px at 0% 100%, #18361f 0%, transparent 60%), #070d08',
  },
  {
    id: 'ember',
    name: 'Нижний мир',
    css: 'radial-gradient(1000px 650px at 50% 120%, #b3261e 0%, transparent 60%), radial-gradient(700px 500px at 90% 0%, #4a0f12 0%, transparent 60%), #120506',
    animated: true,
  },
  { id: 'plain', name: 'Однотонный', css: '#0b0d11' },
]

export const ACCENT_PRESETS = ['#3ddc84', '#4f9cff', '#8b7bff', '#c06bff', '#ff6fb1', '#ff5d6c', '#ff9f43', '#ffd23f', '#2ed3d3']

export const DEFAULT_APPEARANCE: Appearance = {
  background: 'preset:default',
  perScreen: {},
  dim: 35,
  blur: 0,
  panel: 55,
  accent: '#3ddc84',
  scale: 100,
  roundness: 1,
  motion: 'full',
  parallax: false,
  pauseVideoInGame: true,
}

const KEY = 'hyt.appearance'

const clamp = (v: unknown, lo: number, hi: number, d: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d

export function loadAppearance(): Appearance {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Appearance>
    const d = DEFAULT_APPEARANCE
    return {
      ...d,
      ...raw,
      perScreen: raw.perScreen && typeof raw.perScreen === 'object' ? raw.perScreen : {},
      dim: clamp(raw.dim, 0, 90, d.dim),
      blur: clamp(raw.blur, 0, 30, d.blur),
      panel: clamp(raw.panel, 10, 100, d.panel),
      scale: clamp(raw.scale, 80, 130, d.scale),
      roundness: clamp(raw.roundness, 0, 2, d.roundness),
      accent: /^#[0-9a-f]{6}$/i.test(raw.accent ?? '') ? raw.accent! : d.accent,
      motion: raw.motion === 'reduced' || raw.motion === 'off' ? raw.motion : 'full',
    }
  } catch {
    return DEFAULT_APPEARANCE
  }
}

export function saveAppearance(a: Appearance) {
  try {
    localStorage.setItem(KEY, JSON.stringify(a))
  } catch {
    /* хранилище недоступно — настройки просто не переживут перезапуск */
  }
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function luminance([r, g, b]: [number, number, number]) {
  const ch = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)
}

/** Применить настройки к документу: CSS-переменные, масштаб, уровень анимаций */
export function applyAppearance(a: Appearance) {
  const root = document.documentElement
  const rgb = hexToRgb(a.accent)
  const [r, g, b] = rgb
  root.style.setProperty('--mint', a.accent)
  root.style.setProperty('--mint-rgb', `${r}, ${g}, ${b}`)
  root.style.setProperty('--mint-2', `color-mix(in srgb, ${a.accent}, #000 25%)`)
  // Текст на кнопках акцентного цвета: тёмный на светлом, белый на тёмном
  root.style.setProperty('--mint-ink', luminance(rgb) > 0.32 ? '#06140d' : '#ffffff')
  root.style.setProperty('--bg-dim', String(a.dim / 100))
  root.style.setProperty('--bg-blur', `${a.blur}px`)
  root.style.setProperty('--panel-alpha', String(a.panel / 100))
  root.style.setProperty('--radius', `${Math.round(14 * a.roundness)}px`)
  root.style.setProperty('--radius-sm', `${Math.round(10 * a.roundness)}px`)
  root.style.setProperty('--round', String(a.roundness))
  root.style.zoom = a.scale === 100 ? '' : String(a.scale / 100)
  root.dataset.motion = a.motion
}

/** Анимации выключены пользователем или системой */
export function motionReduced(): boolean {
  const level = document.documentElement.dataset.motion
  if (level === 'off' || level === 'reduced') return true
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

export function bgFor(a: Appearance, screen: Screen): BgRef {
  return a.perScreen[screen] ?? a.background
}

export function customSrc(bg: CustomBackground): string {
  if (bg.path.startsWith('data:') || bg.path.startsWith('blob:')) return bg.path
  return '__TAURI_INTERNALS__' in window ? convertFileSrc(bg.path) : ''
}
