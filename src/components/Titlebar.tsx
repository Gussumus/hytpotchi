import { windowAction } from '../lib/ipc'
import { IconMinus, IconSquare, IconX, Logo } from './Icons'

export function Titlebar() {
  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="titlebar-brand" data-tauri-drag-region>
        <Logo size={18} />
        <span data-tauri-drag-region>Hytpotchi</span>
      </div>
      <div className="titlebar-controls">
        <button className="win-btn" onClick={() => windowAction('minimize')} aria-label="Свернуть">
          <IconMinus size={14} />
        </button>
        <button className="win-btn" onClick={() => windowAction('maximize')} aria-label="Развернуть">
          <IconSquare size={12} />
        </button>
        <button className="win-btn win-close" onClick={() => windowAction('close')} aria-label="Закрыть">
          <IconX size={14} />
        </button>
      </div>
    </header>
  )
}
