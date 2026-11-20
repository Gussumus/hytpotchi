import { useEffect } from 'react'
import { useStore } from './store'
import { Titlebar } from './components/Titlebar'
import { Sidebar } from './components/Sidebar'
import { Toasts } from './components/Toasts'
import { CreateInstance } from './components/CreateInstance'
import { EditInstance } from './components/EditInstance'
import { LoginModal } from './components/LoginModal'
import { PackProgress } from './components/PackProgress'
import { AppBackground } from './components/AppBackground'
import { Home } from './screens/Home'
import { InstanceScreen } from './screens/Instance'
import { Content } from './screens/Content'
import { Accounts } from './screens/Accounts'
import { Settings } from './screens/Settings'
import { Skins } from './screens/Skins'

export default function App() {
  const screen = useStore((s) => s.screen)
  const modal = useStore((s) => s.modal)
  const init = useStore((s) => s.init)

  useEffect(() => {
    init()
  }, [init])

  return (
    <div className="app">
      <AppBackground />
      <Titlebar />
      <div className="body">
        <Sidebar />
        <main className="main">
          {screen === 'home' && <Home />}
          {screen === 'instance' && <InstanceScreen />}
          {screen === 'content' && <Content />}
          {screen === 'skins' && <Skins />}
          {screen === 'accounts' && <Accounts />}
          {screen === 'settings' && <Settings />}
        </main>
      </div>
      {modal?.type === 'create' && <CreateInstance />}
      {modal?.type === 'edit' && <EditInstance id={modal.id} />}
      {modal?.type === 'login' && <LoginModal />}
      <PackProgress />
      <Toasts />
    </div>
  )
}
