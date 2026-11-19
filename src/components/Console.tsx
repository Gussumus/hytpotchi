import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { api, copyText } from '../lib/ipc'
import type { Instance } from '../lib/types'
import { IconCopy, IconSearch } from './Icons'

const EMPTY: never[] = []

function level(line: string): 'error' | 'warn' | 'info' | 'launcher' {
  if (line.startsWith('[installer]') || line.startsWith('Устанавливаю')) return 'launcher'
  if (/\b(ERROR|FATAL|Exception|Caused by)|^\s+at [\w.$/]+\(/.test(line)) return 'error'
  if (/\bWARN/.test(line)) return 'warn'
  return 'info'
}

export function Console({ inst }: { inst: Instance }) {
  const lines = useStore((s) => s.logs[inst.id] ?? EMPTY)
  const error = useStore((s) => s.errors[inst.id])
  const [filter, setFilter] = useState('')
  const [onlyProblems, setOnlyProblems] = useState(false)
  const [follow, setFollow] = useState(true)
  const box = useRef<HTMLDivElement>(null)

  // Подтянуть буфер логов, если открыли после запуска
  useEffect(() => {
    if (lines.length > 0) return
    api.gameLogs(inst.id).then((saved) => {
      if (saved.length) {
        useStore.setState((s) => ({
          logs: { ...s.logs, [inst.id]: saved.map((text) => ({ text, stderr: false })) },
        }))
      }
    })
  }, [inst.id, lines.length])

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return lines.filter((l) => {
      if (q && !l.text.toLowerCase().includes(q)) return false
      if (onlyProblems) {
        const lv = l.stderr ? 'error' : level(l.text)
        return lv === 'error' || lv === 'warn'
      }
      return true
    })
  }, [lines, filter, onlyProblems])

  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight
  }, [shown, follow])

  return (
    <section className="console">
      <div className="console-head">
        <div className="search-input grow">
          <IconSearch size={14} />
          <input placeholder="Фильтр логов" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <label className="check">
          <input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} />
          Только ошибки
        </label>
        <button className="btn ghost sm" onClick={() => copyText(lines.map((l) => l.text).join('\n'))}>
          <IconCopy size={14} /> Копировать
        </button>
      </div>
      <div
        className="console-body"
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget
          setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 40)
        }}
      >
        {error && <div className="log-line error">Ошибка запуска: {error}</div>}
        {shown.length === 0 && !error && <div className="log-empty">Логи появятся после запуска игры</div>}
        {shown.map((l, i) => (
          <div key={i} className={`log-line ${l.stderr ? 'error' : level(l.text)}`}>
            {l.text}
          </div>
        ))}
      </div>
    </section>
  )
}
