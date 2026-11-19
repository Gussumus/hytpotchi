import { create } from 'zustand'
import { api, events, showWindow } from './lib/ipc'
import type { Account, CrashHint, Instance, LaunchProgress, PackProgress, SystemInfo, VersionsList } from './lib/types'

export type Screen = 'home' | 'instance' | 'content' | 'skins' | 'accounts' | 'settings'

export type Modal =
  | { type: 'create' }
  | { type: 'edit'; id: string }
  | { type: 'login' }
  | null

export interface Toast {
  id: number
  kind: 'info' | 'success' | 'error'
  text: string
  action?: { label: string; run: () => void }
}

export interface LogLine {
  text: string
  stderr: boolean
}

export interface Prefs {
  hideOnLaunch: boolean
  discord: boolean
}

function loadPrefs(): Prefs {
  try {
    return { hideOnLaunch: false, discord: true, ...JSON.parse(localStorage.getItem('hyt.prefs') ?? '{}') }
  } catch {
    return { hideOnLaunch: false, discord: true }
  }
}

interface State {
  screen: Screen
  instanceTab: string
  modal: Modal
  instances: Instance[]
  selectedId: string | null
  accounts: Account[]
  versions: VersionsList | null
  system: SystemInfo | null
  progress: Record<string, LaunchProgress | undefined>
  errors: Record<string, string | undefined>
  hints: Record<string, CrashHint | undefined>
  logs: Record<string, LogLine[]>
  toasts: Toast[]
  pack: PackProgress | null
  prefs: Prefs
  loaded: boolean

  setScreen: (s: Screen) => void
  setInstanceTab: (t: string) => void
  setModal: (m: Modal) => void
  openInstance: (id: string, tab?: string) => void
  select: (id: string) => void
  setPrefs: (p: Partial<Prefs>) => void
  setPack: (p: PackProgress | null) => void
  toast: (kind: Toast['kind'], text: string, action?: Toast['action']) => void
  dismissToast: (id: number) => void

  init: () => Promise<void>
  refreshInstances: () => Promise<void>
  refreshAccounts: () => Promise<void>
  loadVersions: () => Promise<VersionsList | null>
  launch: (id: string, server?: string) => Promise<void>
  stop: (id: string) => Promise<void>
}

let toastSeq = 0
const LOG_LIMIT = 3000

export const useStore = create<State>((set, get) => ({
  screen: 'home',
  instanceTab: 'mods',
  modal: null,
  instances: [],
  selectedId: null,
  accounts: [],
  versions: null,
  system: null,
  progress: {},
  errors: {},
  hints: {},
  logs: {},
  toasts: [],
  pack: null,
  prefs: loadPrefs(),
  loaded: false,

  setScreen: (screen) => set({ screen }),
  setInstanceTab: (instanceTab) => set({ instanceTab }),
  setModal: (modal) => set({ modal }),
  openInstance: (id, tab) => {
    get().select(id)
    set((s) => ({ screen: 'instance', instanceTab: tab ?? s.instanceTab }))
  },
  select: (selectedId) => {
    set({ selectedId })
    try {
      localStorage.setItem('hyt.selected', selectedId)
    } catch {
      /* хранилище может быть недоступно */
    }
  },
  setPrefs: (p) => {
    const prefs = { ...get().prefs, ...p }
    set({ prefs })
    try {
      localStorage.setItem('hyt.prefs', JSON.stringify(prefs))
    } catch {
      /* ignore */
    }
  },
  setPack: (pack) => set({ pack }),

  toast: (kind, text, action) => {
    const id = ++toastSeq
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, text, action }] }))
    setTimeout(() => get().dismissToast(id), kind === 'error' ? 10000 : 4500)
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  init: async () => {
    events.progress((p) => {
      set((s) => ({ progress: { ...s.progress, [p.instanceId]: p } }))
      if (p.stage === 'running') {
        set((s) => ({
          instances: s.instances.map((i) => (i.id === p.instanceId ? { ...i, running: true } : i)),
        }))
        setTimeout(() => set((s) => ({ progress: { ...s.progress, [p.instanceId]: undefined } })), 1500)
      }
    })
    events.log((l) => {
      set((s) => {
        const prev = s.logs[l.instanceId] ?? []
        const next = prev.length >= LOG_LIMIT ? prev.slice(-LOG_LIMIT + 1) : prev.slice()
        next.push({ text: l.line, stderr: l.stderr })
        return { logs: { ...s.logs, [l.instanceId]: next } }
      })
    })
    events.exit((e) => {
      set((s) => ({
        instances: s.instances.map((i) =>
          i.id === e.instanceId ? { ...i, running: false, playtimeSecs: i.playtimeSecs + e.playedSecs } : i,
        ),
        progress: { ...s.progress, [e.instanceId]: undefined },
        hints: { ...s.hints, [e.instanceId]: e.hint ?? undefined },
      }))
      if (get().prefs.hideOnLaunch) showWindow(true)
      if (e.crashed) {
        const name = get().instances.find((i) => i.id === e.instanceId)?.name ?? 'Игра'
        const text = e.hint ? `${name}: ${e.hint.title}` : `${name} завершилась с ошибкой (код ${e.exitCode})`
        get().toast('error', text, {
          label: 'Подробнее',
          run: () => get().openInstance(e.instanceId, 'console'),
        })
      }
    })
    events.pack((p) => set({ pack: p }))
    api.discordSetEnabled(get().prefs.discord).catch(() => {})

    let saved: string | null = null
    try {
      saved = localStorage.getItem('hyt.selected')
    } catch {
      /* ignore */
    }
    await Promise.all([get().refreshInstances(), get().refreshAccounts()])
    const { instances } = get()
    const selectedId = instances.find((i) => i.id === saved)?.id ?? instances[0]?.id ?? null
    set({ selectedId, loaded: true })
    api.systemInfo().then((system) => set({ system })).catch(() => {})
  },

  refreshInstances: async () => {
    try {
      const instances = await api.instanceList()
      set((s) => ({
        instances,
        selectedId: instances.some((i) => i.id === s.selectedId) ? s.selectedId : (instances[0]?.id ?? null),
        screen: s.screen === 'instance' && !instances.some((i) => i.id === s.selectedId) ? 'home' : s.screen,
      }))
    } catch (e) {
      get().toast('error', (e as Error).message)
    }
  },

  refreshAccounts: async () => {
    try {
      set({ accounts: await api.accountList() })
    } catch (e) {
      get().toast('error', (e as Error).message)
    }
  },

  loadVersions: async () => {
    const cached = get().versions
    if (cached) return cached
    try {
      const versions = await api.versionList()
      set({ versions })
      return versions
    } catch (e) {
      get().toast('error', (e as Error).message)
      return null
    }
  },

  launch: async (id, server) => {
    if (!get().accounts.some((a) => a.active)) {
      get().toast('info', 'Сначала добавьте аккаунт')
      set({ screen: 'accounts' })
      return
    }
    set((s) => ({
      errors: { ...s.errors, [id]: undefined },
      hints: { ...s.hints, [id]: undefined },
      logs: { ...s.logs, [id]: [] },
      progress: {
        ...s.progress,
        [id]: { instanceId: id, stage: 'version', label: 'Подготовка', done: 0, total: 0 },
      },
    }))
    try {
      await api.instanceLaunch(id, server)
      if (get().prefs.hideOnLaunch) showWindow(false)
      await get().refreshInstances()
    } catch (e) {
      const message = (e as Error).message
      set((s) => ({
        errors: { ...s.errors, [id]: message },
        progress: { ...s.progress, [id]: undefined },
      }))
      get().toast('error', message)
    }
  },

  stop: async (id) => {
    try {
      await api.instanceStop(id)
    } catch (e) {
      get().toast('error', (e as Error).message)
    }
  },
}))

export const selectedInstance = (s: State) => s.instances.find((i) => i.id === s.selectedId) ?? null
export const activeAccount = (s: State) => s.accounts.find((a) => a.active) ?? null
