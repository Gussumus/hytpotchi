import { memo } from 'react'
import { hashString } from '../lib/format'

function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16)
  const mix = (c: number) => Math.round(amount < 0 ? c * (1 + amount) : c + (255 - c) * amount)
  const r = mix((n >> 16) & 255)
  const g = mix((n >> 8) & 255)
  const b = mix(n & 255)
  return `rgb(${r} ${g} ${b})`
}

/** Генеративная обложка сборки: пиксельный пейзаж в цвете сборки */
export const Cover = memo(function Cover({
  seed,
  accent,
  cols = 32,
  rows = 18,
}: {
  seed: string
  accent: string
  cols?: number
  rows?: number
}) {
  let h = hashString(seed)
  const rand = () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0
    h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0
    return ((h ^= h >>> 16) >>> 0) / 4294967296
  }

  const cells: { x: number; y: number; fill: string }[] = []
  const k = rows / 18
  // Дальние горы
  let far = Math.round((7 + rand() * 3) * k)
  for (let x = 0; x < cols; x++) {
    far = Math.max(Math.round(4 * k), Math.min(Math.round(10 * k), far + Math.round((rand() - 0.5) * 2.2)))
    for (let y = far; y < rows; y++) cells.push({ x, y, fill: shade(accent, -0.55) })
  }
  // Ближние холмы с «травой»
  let near = Math.round((11 + rand() * 2) * k)
  for (let x = 0; x < cols; x++) {
    near = Math.max(Math.round(9 * k), Math.min(Math.round(14 * k), near + Math.round((rand() - 0.5) * 1.8)))
    for (let y = near; y < rows; y++) {
      const top = y === near
      const depth = (y - near) / rows
      cells.push({
        x,
        y,
        fill: top ? shade(accent, 0.15 + rand() * 0.1) : shade(accent, -0.25 - depth * 0.9 - rand() * 0.08),
      })
    }
  }
  const stars = Array.from({ length: Math.round(cols / 3) }, () => ({
    x: Math.floor(rand() * cols),
    y: Math.floor(rand() * 5 * k),
  }))

  return (
    <svg className="cover-svg" viewBox={`0 0 ${cols} ${rows}`} preserveAspectRatio="xMidYMax slice" aria-hidden="true">
      <defs>
        <linearGradient id={`sky-${seed}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={shade(accent, -0.82)} />
          <stop offset="1" stopColor={shade(accent, -0.6)} />
        </linearGradient>
      </defs>
      <rect width={cols} height={rows} fill={`url(#sky-${seed})`} />
      {stars.map((s, i) => (
        <rect key={`s${i}`} x={s.x + 0.35} y={s.y + 0.35} width={0.3} height={0.3} fill={shade(accent, 0.7)} opacity={0.6} />
      ))}
      <rect x={cols * 0.72} y={2 * k} width={3 * k} height={3 * k} fill={shade(accent, 0.55)} opacity={0.85} />
      {cells.map((c, i) => (
        <rect key={i} x={c.x} y={c.y} width={1.02} height={1.02} fill={c.fill} />
      ))}
    </svg>
  )
})
