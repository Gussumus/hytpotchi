export type Loader = 'fabric' | 'forge' | 'neoforge' | 'quilt'

export interface Instance {
  id: string
  name: string
  gameVersion: string
  loader: Loader | null
  loaderVersion: string | null
  versionId: string | null
  memoryMb: number
  jvmArgs: string
  accent: string | null
  createdAt: string
  lastPlayed: string | null
  playtimeSecs: number
  running: boolean
  group?: string | null
  cover?: string | null
  coverPath?: string | null
}

export interface InstancePatch {
  name?: string
  memoryMb?: number
  jvmArgs?: string
  accent?: string
  /** Пустая строка — убрать из группы */
  group?: string
}

export interface UpdateInfo {
  projectId: string
  title: string
  current: string | null
  latest: string
  versionId: string
  versionType: string
}

export interface SavedServer {
  name: string
  address: string
  icon: string | null
}

export interface ServerStatus {
  online: boolean
  players: number | null
  maxPlayers: number | null
  version: string | null
  motd: string | null
  pingMs: number | null
  favicon: string | null
}

export interface CapeView {
  id: string
  name: string
  active: boolean
  image: string | null
}

export interface SkinProfile {
  username: string
  uuid: string
  skin: string | null
  variant: 'classic' | 'slim'
  capes: CapeView[]
  shared?: SharedStatus
}

export interface SharedStatus {
  state: 'published' | 'failed' | 'not_configured'
  message: string
}

export interface SharedSkins {
  enabled: boolean
  customServer: string | null
  server: string | null
}

export interface LibrarySkin {
  id: string
  name: string
  variant: 'classic' | 'slim'
  image: string
}

export interface Account {
  id: string
  username: string
  uuid: string
  kind: 'microsoft' | 'offline'
  active: boolean
  skinUrl: string | null
  offlineSkin?: string | null
}

export interface DeviceCode {
  deviceCode: string
  userCode: string
  verificationUri: string
  expiresIn: number
  interval: number
}

export interface VersionInfo {
  id: string
  type: 'release' | 'snapshot' | 'old_beta' | 'old_alpha'
  releaseTime: string
}

export interface VersionsList {
  latestRelease: string
  latestSnapshot: string
  versions: VersionInfo[]
}

export interface JavaRuntime {
  version: string
  majorVersion: number
  path: string
  executable: string
  vendor: string
  managed: boolean
}

export interface JavaList {
  managed: JavaRuntime[]
  system: JavaRuntime[]
}

export interface SystemInfo {
  totalMemoryMb: number
  recommendedMemoryMb: number
  dataDir: string
}

export type LaunchStage =
  | 'loader'
  | 'version'
  | 'java'
  | 'client'
  | 'libraries'
  | 'assets'
  | 'natives'
  | 'account'
  | 'starting'
  | 'running'

export interface LaunchProgress {
  instanceId: string
  stage: LaunchStage
  label: string
  done: number
  total: number
}

export interface GameLog {
  instanceId: string
  line: string
  stderr: boolean
}

export interface GameExit {
  instanceId: string
  exitCode: number | null
  crashed: boolean
  killed: boolean
  playedSecs: number
}

export type ProjectType = 'mod' | 'resourcepack' | 'shader' | 'modpack'

export interface SearchHit {
  project_id: string
  slug: string
  title: string
  description: string
  author: string
  downloads: number
  follows: number
  icon_url: string | null
  project_type: string
  categories: string[]
  date_modified: string
}

export interface SearchResult {
  hits: SearchHit[]
  offset: number
  limit: number
  total_hits: number
}

export interface LocalContent {
  filename: string
  title: string
  enabled: boolean
  size: number
  kind: 'mod' | 'resourcepack' | 'shader'
  projectId: string | null
  iconUrl: string | null
  versionNumber?: string | null
  versionType?: string | null
}

export interface VersionChoice {
  id: string
  name: string
  number: string
  versionType: 'release' | 'beta' | 'alpha' | string
  date: string
  current: boolean
  recommended: boolean
}

export interface CrashHint {
  title: string
  hint: string
}

export interface GameExitWithHint extends GameExit {
  hint: CrashHint | null
}

export interface WorldInfo {
  folder: string
  size: number
  lastPlayed: string | null
  icon: string | null
}

export interface Screenshot {
  name: string
  path: string
  takenAt: string | null
  size: number
}

export interface NewsItem {
  title: string
  version: string
  kind: string
  image: string
  date: string | null
  summary: string | null
  url: string
}

export interface PackProgress {
  label: string
  done: number
  total: number
}
