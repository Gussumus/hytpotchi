import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type {
  Account,
  DeviceCode,
  GameExitWithHint,
  GameLog,
  NewsItem,
  PackProgress,
  Screenshot,
  VersionChoice,
  WorldInfo,
  UpdateInfo,
  SavedServer,
  ServerStatus,
  SkinProfile,
  LibrarySkin,
  SharedSkins,
  SharedStatus,
  FeaturesStatus,
  AppUpdate,
  Instance,
  InstancePatch,
  JavaList,
  JavaRuntime,
  LaunchProgress,
  LocalContent,
  ProjectType,
  SearchResult,
  SystemInfo,
  VersionsList,
} from './types'
import { mockCall, mockListen } from './mock'
import type { CustomBackground } from './appearance'
import type { FriendInvite, FriendsState, FriendStatus, HytpotchiAuth } from './types'

/** Запущено внутри Tauri (а не в обычном браузере для предпросмотра) */
export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri) return mockCall<T>(cmd, args)
  try {
    return await invoke<T>(cmd, args)
  } catch (e) {
    throw new Error(typeof e === 'string' ? e : e instanceof Error ? e.message : String(e))
  }
}

export function on<T>(event: string, handler: (payload: T) => void): () => void {
  if (!isTauri) return mockListen(event, handler as (p: unknown) => void)
  let disposed = false
  let unlisten: (() => void) | null = null
  listen<T>(event, (e) => handler(e.payload)).then((fn) => {
    if (disposed) fn()
    else unlisten = fn
  })
  return () => {
    disposed = true
    unlisten?.()
  }
}

export const events = {
  progress: (h: (p: LaunchProgress) => void) => on<LaunchProgress>('launch-progress', h),
  log: (h: (p: GameLog) => void) => on<GameLog>('game-log', h),
  exit: (h: (p: GameExitWithHint) => void) => on<GameExitWithHint>('game-exit', h),
  pack: (h: (p: PackProgress) => void) => on<PackProgress>('modpack-progress', h),
  friends: (h: (p: FriendsState) => void) => on<FriendsState>('friends-update', h),
  friendInvite: (h: (p: FriendInvite) => void) => on<FriendInvite>('friends-invite', h),
}

/** URL локального файла (скриншоты) через asset-протокол Tauri */
export async function fileSrc(path: string): Promise<string> {
  if (!isTauri) return ''
  const { convertFileSrc } = await import('@tauri-apps/api/core')
  return convertFileSrc(path)
}

export const api = {
  // Игра
  versionList: () => call<VersionsList>('version_list'),
  systemInfo: () => call<SystemInfo>('system_info'),
  javaList: () => call<JavaList>('java_list'),
  javaInstall: (major: number) => call<JavaRuntime>('java_install', { major }),
  instanceList: () => call<Instance[]>('instance_list'),
  instanceCreate: (p: {
    name: string
    gameVersion: string
    loader: string | null
    memoryMb: number
    accent: string
  }) => call<Instance>('instance_create', p),
  instanceUpdate: (id: string, patch: InstancePatch) => call<Instance>('instance_update', { id, patch }),
  instanceRemove: (id: string) => call<void>('instance_remove', { id }),
  instanceOpenFolder: (id: string) => call<void>('instance_open_folder', { id }),
  instanceLaunch: (id: string, server?: string) => call<number>('instance_launch', { id, server: server ?? null }),
  instanceStop: (id: string) => call<boolean>('instance_stop', { id }),
  gameLogs: (id: string) => call<string[]>('game_logs', { id }),
  openDataFolder: () => call<void>('open_data_folder'),

  // Аккаунты
  msStart: () => call<DeviceCode>('microsoft_auth_start'),
  msPoll: (deviceCode: string) => call<Account | null>('microsoft_auth_poll', { deviceCode }),
  hytRegister: (nick: string, password: string, replace?: string) =>
    call<HytpotchiAuth>('hytpotchi_register', { nick, password, replace: replace ?? null }),
  hytLogin: (nick: string, password: string, replace?: string) =>
    call<Account>('hytpotchi_login', { nick, password, replace: replace ?? null }),
  hytRecover: (nick: string, recovery: string, password: string) =>
    call<HytpotchiAuth>('hytpotchi_recover', { nick, recovery, password }),
  hytChangePassword: (accountId: string, old: string, password: string) =>
    call<void>('hytpotchi_change_password', { accountId, old, password }),
  accountList: () => call<Account[]>('account_list'),
  accountRemove: (accountId: string) => call<void>('account_remove', { accountId }),
  accountSetActive: (accountId: string) => call<void>('account_set_active', { accountId }),

  // Контент
  search: (p: {
    query: string
    projectType: ProjectType
    gameVersion?: string
    loader?: string
    sort?: string
    offset?: number
    limit?: number
  }) => call<SearchResult>('modrinth_search', p),
  install: (projectId: string, instanceId: string) =>
    call<{ installed: string[] }>('modrinth_install', { projectId, instanceId }),
  modVersions: (projectId: string, instanceId: string) =>
    call<VersionChoice[]>('modrinth_versions', { projectId, instanceId }),
  installVersion: (versionId: string, instanceId: string) =>
    call<{ installed: string[] }>('modrinth_install_version', { versionId, instanceId }),
  localContent: (instanceId: string) => call<LocalContent[]>('local_mods_scan', { instanceId }),
  contentToggle: (instanceId: string, kind: string, filename: string, enabled: boolean) =>
    call<string>('mod_toggle', { instanceId, kind, filename, enabled }),
  contentRemove: (instanceId: string, kind: string, filename: string) =>
    call<void>('mod_remove', { instanceId, kind, filename }),

  // Миры, скриншоты, новости, модпаки
  worlds: (id: string) => call<WorldInfo[]>('world_list', { id }),
  worldBackup: (id: string, folder: string) => call<string>('world_backup', { id, folder }),
  worldDelete: (id: string, folder: string) => call<void>('world_delete', { id, folder }),
  openSubfolder: (id: string, sub: string) => call<void>('instance_open_subfolder', { id, sub }),
  screenshots: (id: string) => call<Screenshot[]>('screenshot_list', { id }),
  screenshotDelete: (id: string, name: string) => call<void>('screenshot_delete', { id, name }),
  openFile: (path: string) => call<void>('open_file', { path }),
  news: () => call<NewsItem[]>('mc_news'),
  modpackInstall: (projectId: string, accent: string, memoryMb: number) =>
    call<Instance>('modpack_install', { projectId, accent, memoryMb }),
  mrpackImport: (accent: string, memoryMb: number) => call<Instance | null>('mrpack_import', { accent, memoryMb }),

  // Обновления, импорт/экспорт, обложки
  checkUpdates: (instanceId: string) => call<UpdateInfo[]>('content_check_updates', { instanceId }),
  importInstance: (accent: string, memoryMb: number) => call<Instance | null>('import_instance', { accent, memoryMb }),
  exportInstance: (id: string) => call<string | null>('export_instance', { id }),
  setCover: (id: string) => call<Instance | null>('instance_set_cover', { id }),
  clearCover: (id: string) => call<Instance>('instance_clear_cover', { id }),

  // Серверы
  servers: (id: string) => call<SavedServer[]>('saved_servers', { id }),
  serverAdd: (id: string, name: string, address: string) => call<void>('saved_server_add', { id, name, address }),
  serverRemove: (id: string, address: string) => call<void>('saved_server_remove', { id, address }),
  ping: (address: string) => call<ServerStatus>('server_ping', { address }),

  // Discord
  discordStatus: () => call<{ available: boolean }>('discord_status'),
  discordSetEnabled: (enabled: boolean) => call<void>('discord_set_enabled', { enabled }),

  // Скины
  skinProfile: (accountId: string) => call<SkinProfile>('skin_profile', { accountId }),
  skinLibrary: () => call<LibrarySkin[]>('skin_library'),
  skinLibraryAdd: (variant: string) => call<LibrarySkin | null>('skin_library_add', { variant }),
  skinLibraryRemove: (id: string) => call<void>('skin_library_remove', { id }),

  // Друзья
  friendsState: () => call<FriendsState>('friends_state'),
  friendsRefresh: () => call<FriendsState>('friends_refresh'),
  friendsSettings: (p: { enabled?: boolean; status?: FriendStatus; hosting?: boolean }) =>
    call<FriendsState>('friends_settings', p),
  friendsRequest: (nick: string) => call<FriendsState>('friends_request', { nick }),
  /** Туннель в мир друга: адрес для игры (127.0.0.1:порт) */
  friendsJoin: (id: string) => call<string>('friends_join', { id }),
  /** Поставить ту же сборку, что у друга (прогресс — событием modpack-progress) */
  friendsSyncPack: (id: string, memoryMb: number, job: string) => call<Instance>('friends_sync_pack', { id, memoryMb, job }),
  friendsRespond: (id: string, accept: boolean) => call<FriendsState>('friends_respond', { id, accept }),
  friendsRemove: (id: string) => call<FriendsState>('friends_remove', { id }),
  friendsInvite: (p: { to: string; address?: string | null; instanceName?: string; mc?: string; loader?: string | null; note?: string }) =>
    call<FriendsState>('friends_invite', p),
  friendsDismiss: (id: string) => call<FriendsState>('friends_dismiss', { id }),

  // Внешний вид: свои фоны
  backgroundList: () => call<CustomBackground[]>('background_list'),
  backgroundAdd: () => call<CustomBackground | null>('background_add'),
  backgroundRename: (id: string, name: string) => call<CustomBackground[]>('background_rename', { id, name }),
  backgroundRemove: (id: string) => call<CustomBackground[]>('background_remove', { id }),
  skinApply: (accountId: string, skinId: string, variant: string) =>
    call<SkinProfile>('skin_apply', { accountId, skinId, variant }),
  skinReset: (accountId: string) => call<SkinProfile>('skin_reset', { accountId }),
  skinSaveCurrent: (accountId: string) => call<LibrarySkin>('skin_save_current', { accountId }),
  capeSet: (accountId: string, capeId: string | null) => call<SkinProfile>('cape_set', { accountId, capeId }),
  sharedSkinsGet: () => call<SharedSkins>('shared_skins_get'),
  sharedSkinsSet: (enabled: boolean, server: string | null) => call<SharedSkins>('shared_skins_set', { enabled, server }),
  skinPublish: (accountId: string) => call<SharedStatus>('skin_publish', { accountId }),

  // Обновления и статус сервисов
  features: () => call<FeaturesStatus>('features_status'),
  updateCheck: () => call<AppUpdate>('update_check'),
  updateInstall: () => call<void>('update_install'),
}

export async function showWindow(visible: boolean) {
  if (!isTauri) return
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  const w = getCurrentWindow()
  if (visible) {
    await w.show()
    await w.unminimize()
    await w.setFocus()
  } else {
    await w.hide()
  }
}

export async function openExternal(url: string) {
  if (!isTauri) {
    window.open(url, '_blank', 'noopener')
    return
  }
  const { openUrl } = await import('@tauri-apps/plugin-opener')
  await openUrl(url)
}

export async function copyText(text: string) {
  if (isTauri) {
    const { writeText } = await import('@tauri-apps/plugin-clipboard-manager')
    await writeText(text)
  } else {
    await navigator.clipboard?.writeText(text)
  }
}

export async function windowAction(action: 'minimize' | 'maximize' | 'close') {
  if (!isTauri) return
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  const w = getCurrentWindow()
  if (action === 'minimize') await w.minimize()
  else if (action === 'maximize') await w.toggleMaximize()
  else await w.close()
}
