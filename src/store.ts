import { create } from 'zustand'
import { api, events, showWindow } from './lib/ipc'
import type {
  Account,
  CrashHint,
  FeaturesStatus,
  FriendsState,
  Instance,
  LaunchProgress,
  PackProgress,
  SystemInfo,
  VersionsList,
} from './lib/types'
import { loaderName } from './lib/format'
import {
  applyAppearance,
  loadAppearance,
  saveAppearance,
  type Appearance,
  type CustomBackground,
} from './lib/appearance'

export type Screen = 'home' | 'instance' | 'content' | 'friends' | 'skins' | 'accounts' | 'settings'

export type Modal =
  | { type: 'create' }
  | { type: 'edit'; id: string }
  | { type: 'login'; mode?: 'hytpotchi' | 'microsoft'; replace?: { id: string; nick: string } }
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
  features: FeaturesStatus | null
  installUpdate: () => Promise<void>
  progress: Record<string, LaunchProgress | undefined>
  errors: Record<string, string | undefined>
  hints: Record<string, CrashHint | undefined>
  logs: Record<string, LogLine[]>
  toasts: Toast[]
  pack: PackProgress | null
  prefs: Prefs
  appearance: Appearance
  backgrounds: CustomBackground[]
  friends: FriendsState | null
  loaded: boolean

  setScreen: (s: Screen) => void
  setInstanceTab: (t: string) => void
  setModal: (m: Modal) => void
  openInstance: (id: string, tab?: string) => void
  select: (id: string) => void
  setPrefs: (p: Partial<Prefs>) => void
  setAppearance: (a: Partial<Appearance>) => void
  loadBackgrounds: () => Promise<void>
  setBackgrounds: (list: CustomBackground[]) => void
  setFriends: (f: FriendsState) => void
  /** Зайти в мир друга: подобрать (или создать) сборку той же версии и запустить с адресом */
  joinWorld: (p: JoinTarget) => Promise<void>
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

export interface JoinTarget {
  friendName: string
  /** Адрес сервера/e4mc; без него — туннель лаунчера к миру друга friendId */
  address?: string | null
  friendId?: string
  mc?: string | null
  loader?: string | null
  /** Хеш сборки друга: если есть — лаунчер сначала поставит такую же сборку */
  pack?: string | null
}

let toastSeq = 0
/** Текущая установка сборки друга (см. joinWorld) */
let packJob: string | null = null
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
  features: null,
  progress: {},
  errors: {},
  hints: {},
  logs: {},
  toasts: [],
  pack: null,
  prefs: loadPrefs(),
  appearance: loadAppearance(),
  backgrounds: [],
  friends: null,
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
  setAppearance: (patch) => {
    const appearance = { ...get().appearance, ...patch }
    set({ appearance })
    applyAppearance(appearance)
    saveAppearance(appearance)
  },
  loadBackgrounds: async () => {
    try {
      get().setBackgrounds(await api.backgroundList())
    } catch {
      /* без своих фонов — остаются встроенные */
    }
  },
  setBackgrounds: (backgrounds) => {
    set({ backgrounds })
    // Если файл фона удалили — экраны, где он стоял, возвращаются к общему фону
    const ids = new Set(backgrounds.map((b) => `custom:${b.id}`))
    const a = get().appearance
    const alive = (ref: string) => !ref.startsWith('custom:') || ids.has(ref)
    const perScreen = Object.fromEntries(Object.entries(a.perScreen).filter(([, ref]) => ref && alive(ref)))
    const background = alive(a.background) ? a.background : 'preset:default'
    if (background !== a.background || Object.keys(perScreen).length !== Object.keys(a.perScreen).length) {
      get().setAppearance({ background, perScreen })
    }
  },
  setFriends: (friends) => set({ friends }),
  joinWorld: async ({ friendName, address, friendId, mc, loader, pack }) => {
    const { instances, selectedId, toast, launch, refreshInstances, select } = get()
    if (instances.some((i) => i.running)) {
      toast('info', 'Сначала закройте запущенную игру')
      return
    }
    let target: Instance | undefined = instances.find((i) => i.id === selectedId) ?? instances[0]
    if (friendId && pack) {
      // Та же сборка, что у друга: версия, загрузчик и моды
      const job = `friend-${Date.now()}`
      packJob = job
      set({ pack: { label: `Готовим сборку ${friendName}`, done: 0, total: 1, job } })
      try {
        target = await api.friendsSyncPack(friendId, get().system?.recommendedMemoryMb ?? 4096, job)
        await refreshInstances()
      } catch (e) {
        toast('error', `Сборку друга поставить не удалось: ${(e as Error).message}`)
        return
      } finally {
        packJob = null
        set({ pack: null })
      }
    } else if (mc) {
      const same = (i: Instance) => i.gameVersion === mc && (i.loader ?? null) === (loader ?? null)
      target = instances.find((i) => i.id === selectedId && same(i)) ?? instances.find(same)
      if (!target) {
        try {
          target = await api.instanceCreate({
            name: `С ${friendName}`.slice(0, 40),
            gameVersion: mc,
            loader: loader ?? null,
            memoryMb: get().system?.recommendedMemoryMb ?? 4096,
            accent: '#4f9cff',
          })
          await refreshInstances()
          toast('info', `Создана сборка «${target.name}»: Minecraft ${mc}${loader ? ` · ${loaderName(loader)}` : ''}`)
        } catch (e) {
          toast('error', (e as Error).message)
          return
        }
      }
    }
    if (!target) {
      toast('info', 'Создайте сборку, чтобы зайти к другу')
      return
    }
    select(target.id)
    let server = address ?? null
    if (!server) {
      if (!friendId) {
        toast('error', 'Не знаю, куда заходить')
        return
      }
      try {
        // Лаунчер открывает локальный порт и ведёт соединение игры к другу через туннель
        server = await api.friendsJoin(friendId)
      } catch (e) {
        toast('error', (e as Error).message)
        return
      }
    }
    toast('info', `Заходим к ${friendName}…`)
    await launch(target.id, server)
  },
  setPack: (pack) => set({ pack }),

  toast: (kind, text, action) => {
    const id = ++toastSeq
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, text, action }] }))
    setTimeout(() => get().dismissToast(id), kind === 'error' ? 10000 : 4500)
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  init: async () => {
    applyAppearance(get().appearance)
    get().loadBackgrounds()
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
    // Событие задачи, которая уже закончилась (пришло после ответа команды), окно не открывает
    events.pack((p) => {
      if (p.job && p.job !== packJob) return
      set({ pack: p })
    })
    events.friends((f) => set({ friends: f }))
    events.friendInvite((inv) => {
      const what = inv.instance ? ` · ${inv.instance.mc}${inv.instance.loader ? ` ${loaderName(inv.instance.loader)}` : ''}` : ''
      get().toast('info', `${inv.fromNick} зовёт играть${what}${inv.note ? `: «${inv.note}»` : ''}`, {
        label: 'Присоединиться',
        run: () => {
          api.friendsDismiss(inv.id).catch(() => {})
          get().joinWorld({
            friendName: inv.fromNick,
            address: inv.address,
            friendId: inv.from,
            mc: inv.instance?.mc,
            loader: inv.instance?.loader,
            pack: inv.pack,
          })
        },
      })
    })
    api.friendsState().then((f) => set({ friends: f })).catch(() => {})
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
    api
      .features()
      .then(async (features) => {
        set({ features })
        if (!features.updater) return
        const update = await api.updateCheck()
        if (update.version) {
          get().toast('info', `Доступна новая версия Hytpotchi ${update.version}`, {
            label: 'Обновить',
            run: () => get().installUpdate(),
          })
        }
      })
      .catch(() => {})
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

  installUpdate: async () => {
    get().toast('info', 'Скачиваем обновление — лаунчер перезапустится сам')
    try {
      await api.updateInstall()
    } catch (e) {
      get().toast('error', (e as Error).message)
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
