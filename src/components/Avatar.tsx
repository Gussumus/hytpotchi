import { useState } from 'react'
import type { Account } from '../lib/types'
import { hashString, ACCENTS } from '../lib/format'

/** Голова скина игрока (для офлайн-аккаунтов — цветная буква) */
export function Avatar({ account, size = 32 }: { account: Account | null; size?: number }) {
  const [failed, setFailed] = useState(false)
  if (!account) {
    return (
      <div className="avatar avatar-empty" style={{ width: size, height: size }}>
        ?
      </div>
    )
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
