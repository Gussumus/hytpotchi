import { useStore } from '../store'
import type { Instance, LaunchProgress } from '../lib/types'
import { IconPlay, IconStop } from './Icons'

const STAGES = ['loader', 'version', 'java', 'client', 'libraries', 'assets', 'natives', 'account', 'starting', 'running']
// Вес этапов: тяжёлые загрузки занимают больше полосы
const WEIGHTS = [8, 2, 18, 6, 14, 38, 3, 3, 7, 1]

export function progressPercent(p: LaunchProgress): number {
  const idx = Math.max(0, STAGES.indexOf(p.stage))
  const before = WEIGHTS.slice(0, idx).reduce((a, b) => a + b, 0)
  const total = WEIGHTS.reduce((a, b) => a + b, 0)
  const inner = p.total > 0 ? Math.min(1, p.done / p.total) : 0
  return Math.round(((before + inner * WEIGHTS[idx]) / total) * 100)
}

export function PlayButton({ inst, size = 'lg' }: { inst: Instance; size?: 'lg' | 'md' }) {
  const progress = useStore((s) => s.progress[inst.id])
  const launch = useStore((s) => s.launch)
  const stop = useStore((s) => s.stop)
  const cls = `play-btn ${size === 'md' ? 'md' : ''}`

  if (inst.running) {
    return (
      <button className={`${cls} running`} onClick={() => stop(inst.id)}>
        <IconStop size={18} /> Остановить
      </button>
    )
  }
  if (progress) {
    const pct = progressPercent(progress)
    const counter = progress.total > 1 && progress.stage !== 'java' ? ` · ${progress.done}/${progress.total}` : ''
    return (
      <div className={`${cls} loading`} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className="play-fill" style={{ width: `${pct}%` }} />
        <div className="play-label">
          <span className="spinner xs" />
          <span>
            {progress.label}
            {counter}
          </span>
          <b>{pct}%</b>
        </div>
      </div>
    )
  }
  return (
    <button className={cls} onClick={() => launch(inst.id)}>
      <IconPlay size={size === 'md' ? 17 : 20} /> Играть
    </button>
  )
}
