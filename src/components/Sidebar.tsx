import { activeAccount, useStore, type Screen } from '../store'
import { loaderName } from '../lib/format'
import { Avatar } from './Avatar'
import { InstanceArt } from './InstanceArt'
import { IconCompass, IconHome, IconPlus, IconSettings, IconShirt, IconUser, IconUsers } from './Icons'
import type { Instance } from '../lib/types'

const NAV: { id: Screen; label: string; icon: typeof IconHome }[] = [
  { id: 'home', label: 'Главная', icon: IconHome },
  { id: 'content', label: 'Каталог', icon: IconCompass },
  { id: 'friends', label: 'Друзья', icon: IconUsers },
  { id: 'skins', label: 'Скины', icon: IconShirt },
  { id: 'accounts', label: 'Аккаунты', icon: IconUser },
  { id: 'settings', label: 'Настройки', icon: IconSettings },
]

export function Sidebar() {
  const screen = useStore((s) => s.screen)
  const setScreen = useStore((s) => s.setScreen)
  const instances = useStore((s) => s.instances)
  const selectedId = useStore((s) => s.selectedId)
  const openInstance = useStore((s) => s.openInstance)
  const setModal = useStore((s) => s.setModal)
  const progress = useStore((s) => s.progress)
  const account = useStore(activeAccount)
  const snapshot = useStore((s) => s.friends?.snapshot)
  const friendsBadge = (snapshot?.requests.length ?? 0) + (snapshot?.invites.length ?? 0)
  const onlineFriends = snapshot?.friends.filter((f) => f.online).length ?? 0

  return (
    <aside className="sidebar">
      <nav className="nav">
        {NAV.map(({ id, label, icon: Icon }) => (
          <button key={id} className={`nav-item ${screen === id ? 'on' : ''}`} onClick={() => setScreen(id)}>
            <Icon size={18} />
            <span>{label}</span>
            {id === 'friends' && friendsBadge > 0 && <span className="nav-badge">{friendsBadge}</span>}
            {id === 'friends' && friendsBadge === 0 && onlineFriends > 0 && <span className="nav-online">{onlineFriends}</span>}
          </button>
        ))}
      </nav>

      <div className="side-section">
        <div className="side-heading">
          <span>Сборки</span>
          <button className="icon-btn sm" onClick={() => setModal({ type: 'create' })} aria-label="Новая сборка">
            <IconPlus size={14} />
          </button>
        </div>
        <div className="side-list">
          {groupInstances(instances).map(([group, list]) => (
            <div key={group || '_'} className="side-group">
              {group && <div className="side-group-title">{group}</div>}
              {list.map((inst) => {
            const busy = !!progress[inst.id]
            return (
              <button
                key={inst.id}
                className={`side-instance ${inst.id === selectedId && screen === 'instance' ? 'on' : ''}`}
                onClick={() => openInstance(inst.id)}
              >
                <span className="side-thumb">
                  <InstanceArt inst={inst} cols={10} rows={10} />
                  {inst.running && <span className="side-live" />}
                </span>
                <span className="side-instance-text">
                  <span className="side-instance-name">{inst.name}</span>
                  <span className="side-instance-sub">
                    {inst.running ? 'в игре' : `${loaderName(inst.loader)} ${inst.gameVersion}`}
                  </span>
                </span>
                {busy && !inst.running && <span className="spinner xs" />}
              </button>
            )
          })}
            </div>
          ))}
          {instances.length === 0 && (
            <button className="side-create" onClick={() => setModal({ type: 'create' })}>
              <IconPlus size={14} /> Создать первую сборку
            </button>
          )}
        </div>
      </div>

      <button className={`account-chip ${screen === 'accounts' ? 'on' : ''}`} onClick={() => setScreen('accounts')}>
        <Avatar account={account} size={34} />
        <div className="account-chip-text">
          <strong>{account?.username ?? 'Нет аккаунта'}</strong>
          <span>{account ? (account.kind === 'microsoft' ? 'Microsoft' : account.kind === 'hytpotchi' ? 'Hytpotchi' : 'Нужен перенос в Hytpotchi') : 'Нажмите, чтобы войти'}</span>
        </div>
      </button>
    </aside>
  )
}

/** Сборки по группам: сначала без группы, затем группы по алфавиту */
export function groupInstances(instances: Instance[]): [string, Instance[]][] {
  const map = new Map<string, Instance[]>()
  for (const inst of instances) {
    const key = inst.group ?? ''
    map.set(key, [...(map.get(key) ?? []), inst])
  }
  return [...map.entries()].sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b, 'ru')))
}
