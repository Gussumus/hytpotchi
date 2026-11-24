export type Loader = 'fabric' | 'forge' | 'neoforge' | 'quilt'

export interface Instance {
  id: string
  name: string
  gameVersion: string
  loader: Loader | null
  loaderVersion: string | null
  /** Версию загрузчика выбрал игрок (иначе лаунчер ставит рекомендуемую) */
  loaderPinned?: boolean
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
  /** Версия загрузчика; пустая строка — рекомендуемая */
  loaderVersion?: string
}

/** Версия загрузчика (Forge, NeoForge, Fabric, Quilt) в списке для выбора */
export interface LoaderVersion {
  version: string
  stable: boolean
  recommended: boolean
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

/** Деталь косметики: кубы одного цвета на части тела (координаты модели Minecraft) */
export interface CosmeticPart {
  bone: 'head' | 'body' | 'left_arm' | 'right_arm'
  color: string
  pivot?: [number, number, number]
  rot?: [number, number, number]
  anim?: 'flap_left' | 'flap_right' | 'sway' | 'spin'
  cubes: [number, number, number, number, number, number][]
}

/** Что надето и что куплено (платное надевается только купленным) */
export interface CosmeticsState {
  items: string[]
  owned: string[]
}

/** Деталь-сетка (3D-модель): mesh — путь к mesh.json на сервере */
export interface CosmeticMeshPart {
  bone: CosmeticPart['bone']
  pivot?: [number, number, number]
  rot?: [number, number, number]
  anim?: CosmeticPart['anim']
  mesh: string
}

/** Файл 3D-модели: группы треугольников, у каждой своя текстура (−1 — без текстуры) */
export interface CosmeticMesh {
  format: number
  textures: string[]
  groups: { texture: number; v: number[]; i: number[] }[]
}

/** Предмет косметики из каталога сервера Hytpotchi */
export interface CosmeticDef {
  id: string
  name: string
  slot: string
  /** Место на теле: два предмета с одним местом вместе не надеть (новый снимает старый) */
  spot?: string
  /** Цена в рублях, 0 — бесплатно */
  price: number
  /** Модель из кубов (ей же пользуются старые версии мода) */
  parts: CosmeticPart[]
  /** 3D-модель: если есть, рисуется вместо parts */
  meshes?: CosmeticMeshPart[]
  /** Автор модели (лицензии CC BY требуют его указать) */
  credit?: { title?: string; author: string; url: string; license: string }
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
  /** offline — старый офлайн-аккаунт: играть им нельзя, только перенести ник в Hytpotchi */
  kind: 'microsoft' | 'hytpotchi' | 'offline'
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
  /** Метка задачи (сборка друга): события чужих и завершённых задач игнорируются */
  job?: string
}

export interface FeaturesStatus {
  version: string
  microsoft: boolean
  skinServer: boolean
  discord: boolean
  updater: boolean
}

export interface AppUpdate {
  supported: boolean
  currentVersion: string
  version: string | null
  notes: string | null
}

// ---------- Друзья ----------

export type FriendStatus = 'online' | 'busy' | 'invisible'

export interface FriendActivity {
  instance: string
  mc: string
  loader: string | null
  server?: string | null
}

/** Мир, открытый для друзей: адрес e4mc или туннель через лаунчер (relay) */
export interface FriendHost {
  address?: string | null
  relay?: boolean
  world?: string | null
  mc: string
  loader: string | null
  /** Хеш описи сборки хозяина — лаунчер поставит такую же */
  pack?: string | null
  /** Сколько модов в сборке */
  mods?: number | null
}

export interface Friend {
  id: string
  nick: string
  online: boolean
  status: FriendStatus | 'offline'
  activity: FriendActivity | null
  host: FriendHost | null
  lastSeen: number | null
}

export interface FriendPerson {
  id: string
  nick: string
  at: number
}

export interface FriendInvite {
  id: string
  from: string
  fromNick: string
  at: number
  /** Адрес сервера/e4mc; null — мир друга через туннель лаунчера */
  address: string | null
  relay: boolean
  instance: { name: string; mc: string; loader: string | null } | null
  /** Хеш сборки хозяина на момент приглашения */
  pack: string | null
  note: string | null
}

export interface FriendsSnapshot {
  me: { id: string; nick: string }
  friends: Friend[]
  requests: FriendPerson[]
  outgoing: FriendPerson[]
  invites: FriendInvite[]
}

/** Мой открытый мир */
export interface LocalHost {
  instanceId: string
  instance: string
  mc: string
  loader: string | null
  address: string
  world: string | null
  /** Открыт без e4mc — друзья заходят через туннель лаунчера */
  relay: boolean
  /** Сколько модов друзья получат вместе со сборкой */
  mods: number | null
  /** Моды не с Modrinth — их друзья не получат */
  missing: string[]
}

export interface FriendsState {
  enabled: boolean
  configured: boolean
  /** Ник аккаунта Hytpotchi, от которого работают друзья */
  account: string | null
  /** Хозяин мира вошёл через Microsoft — друзьям тоже нужна лицензия */
  hostOnlineMode: boolean
  status: FriendStatus
  hosting: boolean
  snapshot: FriendsSnapshot | null
  error: string | null
  hosted: LocalHost[]
  syncing: boolean
}

/** Результат регистрации/восстановления аккаунта Hytpotchi */
export interface HytpotchiAuth {
  account: Account
  /** Код восстановления — показывается один раз */
  recovery: string | null
}
