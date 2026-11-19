import { useStore } from '../store'
import { formatMemory } from '../lib/format'

export function MemorySlider({ value, onChange }: { value: number; onChange: (mb: number) => void }) {
  const system = useStore((s) => s.system)
  const max = Math.max(4096, Math.min(32768, Math.floor(((system?.totalMemoryMb ?? 16384) * 0.85) / 512) * 512))
  const recommended = system?.recommendedMemoryMb
  const pct = ((value - 1024) / (max - 1024)) * 100
  const tooMuch = system && value > system.totalMemoryMb * 0.7

  return (
    <div className="memory">
      <div className="memory-row">
        <input
          type="range"
          min={1024}
          max={max}
          step={512}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          style={{ ['--pct' as string]: `${pct}%` }}
          aria-label="Оперативная память"
        />
        <span className="memory-value">{formatMemory(value)}</span>
      </div>
      <div className="memory-hint">
        {tooMuch ? (
          <span className="warn">Слишком много — системе может не хватить памяти</span>
        ) : recommended ? (
          <span>
            Рекомендуем {formatMemory(recommended)} из {formatMemory(system!.totalMemoryMb)}
            {value !== recommended && (
              <button className="link" onClick={() => onChange(recommended)}>
                поставить
              </button>
            )}
          </span>
        ) : null}
      </div>
    </div>
  )
}
