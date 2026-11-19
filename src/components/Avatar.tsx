import { useEffect, useRef, useState } from 'react'
import type { Account } from '../lib/types'
import { hashString, ACCENTS } from '../lib/format'

/** Голова из PNG-скина: лицо + второй слой (шлем/волосы) */
function SkinHead({ src, size }: { src: string; size: number }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const ctx = canvas.current?.getContext('2d')
    if (!ctx) return
    const img = new Image()
    img.onload = () => {
      ctx.imageSmoothingEnabled = false
      ctx.clearRect(0, 0, 8, 8)
      ctx.drawImage(img, 8, 8, 8, 8, 0, 0, 8, 8)
      ctx.drawImage(img, 40, 8, 8, 8, 0, 0, 8, 8)
    }
    img.src = src
  }, [src])
  return <canvas ref={canvas} className="avatar avatar-skin" width={8} height={8} style={{ width: size, height: size }} />
}

/** Аватар игрока: голова скина Microsoft, офлайн-скин из библиотеки или цветная буква */
export function Avatar({ account, size = 32 }: { account: Account | null; size?: number }) {
  const [failed, setFailed] = useState(false)
  if (!account) {
    return (
      <div className="avatar avatar-empty" style={{ width: size, height: size }}>
        ?
      </div>
    )
  }
  if (account.offlineSkin) {
    return <SkinHead src={account.offlineSkin} size={size} />
  }
  const color = ACCENTS[hashString(account.username) % ACCENTS.length]
  if (account.kind === 'microsoft' && !failed) {
    return (
      <img
        className="avatar"
        src={`https://mc-heads.net/avatar/${account.uuid}/${size * 2}`}
        width={size}
        height={size}
        alt=""
        onError={() => setFailed(true)}
      />
    )
  }
  return (
    <div
      className="avatar avatar-letter"
      style={{ width: size, height: size, background: color, fontSize: size * 0.45 }}
    >
      {account.username.slice(0, 1).toUpperCase()}
    </div>
  )
}
