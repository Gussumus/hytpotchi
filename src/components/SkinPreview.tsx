import { useEffect, useRef } from 'react'

type Rect = [sx: number, sy: number, w: number, h: number, dx: number, dy: number]

/** Развёртка скина: части тела спереди и сзади (координаты в текстуре 64×64) */
function parts(slim: boolean, legacy: boolean, back: boolean): Rect[] {
  const a = slim ? 3 : 4
  if (!back) {
    const base: Rect[] = [
      [8, 8, 8, 8, 4, 0], // голова
      [20, 20, 8, 12, 4, 8], // тело
      [44, 20, a, 12, 4 - a, 8], // правая рука
      [4, 20, 4, 12, 4, 20], // правая нога
      legacy ? [44, 20, a, 12, 12, 8] : [36, 52, a, 12, 12, 8], // левая рука
      legacy ? [4, 20, 4, 12, 8, 20] : [20, 52, 4, 12, 8, 20], // левая нога
    ]
    const overlay: Rect[] = legacy
      ? [[40, 8, 8, 8, 4, 0]]
      : [
          [40, 8, 8, 8, 4, 0],
          [20, 36, 8, 12, 4, 8],
          [44, 36, a, 12, 4 - a, 8],
          [52, 52, a, 12, 12, 8],
          [4, 36, 4, 12, 4, 20],
          [4, 52, 4, 12, 8, 20],
        ]
    return [...base, ...overlay]
  }
  const base: Rect[] = [
    [24, 8, 8, 8, 4, 0],
    [32, 20, 8, 12, 4, 8],
    [44 + a + 4, 20, a, 12, 12, 8],
    [12, 20, 4, 12, 8, 20],
    legacy ? [44 + a + 4, 20, a, 12, 4 - a, 8] : [36 + a + 4, 52, a, 12, 4 - a, 8],
    legacy ? [12, 20, 4, 12, 4, 20] : [28, 52, 4, 12, 4, 20],
  ]
  const overlay: Rect[] = legacy
    ? [[56, 8, 8, 8, 4, 0]]
    : [
        [56, 8, 8, 8, 4, 0],
        [32, 36, 8, 12, 4, 8],
        [44 + a + 4, 36, a, 12, 12, 8],
        [52 + a + 4, 52, a, 12, 4 - a, 8],
        [12, 36, 4, 12, 8, 20],
        [12, 52, 4, 12, 4, 20],
      ]
  return [...base, ...overlay]
}

/** Плоский предпросмотр скина (спереди и сзади) */
export function SkinPreview({ src, slim, cape, scale = 8 }: { src: string | null; slim: boolean; cape?: string | null; scale?: number }) {
  const canvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const c = canvas.current
    if (!c) return
    const ctx = c.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, c.width, c.height)
    ctx.imageSmoothingEnabled = false
    if (!src) return

    const img = new Image()
    img.onload = () => {
      const legacy = img.height === 32
      ctx.clearRect(0, 0, c.width, c.height)
      for (const [view, offsetX] of [
        [false, 0],
        [true, 24],
      ] as const) {
        for (const [sx, sy, w, h, dx, dy] of parts(slim, legacy, view)) {
          ctx.drawImage(img, sx, sy, w, h, dx + offsetX, dy, w, h)
        }
      }
      if (cape) {
        const capeImg = new Image()
        capeImg.onload = () => {
          // Плащ сзади: область 10×16 из текстуры 64×32
          const k = capeImg.width / 64
          ctx.globalAlpha = 0.95
          ctx.drawImage(capeImg, 1 * k, 1 * k, 10 * k, 16 * k, 24 + 3, 8, 10, 16)
          ctx.globalAlpha = 1
          for (const [sx, sy, w, h, dx, dy] of parts(slim, legacy, true).slice(0, 1)) {
            ctx.drawImage(img, sx, sy, w, h, dx + 24, dy, w, h)
          }
        }
        capeImg.src = cape
      }
    }
    img.src = src
  }, [src, slim, cape])

  return (
    <canvas
      ref={canvas}
      className="skin-canvas"
      width={40}
      height={32}
      style={{ width: 40 * scale, height: 32 * scale }}
      aria-label="Предпросмотр скина"
    />
  )
}
