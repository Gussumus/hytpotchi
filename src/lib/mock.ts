// Демо-бэкенд для предпросмотра интерфейса в обычном браузере (без Tauri).
import type { Friend, FriendInvite, FriendPerson, FriendsState, FriendStatus } from './types'
import type { Account, Instance, LaunchStage, LocalContent, SearchHit } from './types'

type Handler = (payload: unknown) => void
const listeners = new Map<string, Set<Handler>>()

export function mockListen(event: string, handler: Handler) {
  if (!listeners.has(event)) listeners.set(event, new Set())
  listeners.get(event)!.add(handler)
  return () => listeners.get(event)?.delete(handler)
}

function emit(event: string, payload: unknown) {
  listeners.get(event)?.forEach((h) => h(payload))
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const now = Date.now()
let instances: Instance[] = [
  {
    id: 'demo-1',
    name: 'Выживание с друзьями',
    gameVersion: '1.21.4',
    loader: 'fabric',
    loaderVersion: '0.16.9',
    versionId: 'fabric-loader-0.16.9-1.21.4',
    memoryMb: 4096,
    jvmArgs: '',
    accent: '#3ddc84',
    createdAt: new Date(now - 864e5 * 9).toISOString(),
    lastPlayed: new Date(now - 36e5 * 3).toISOString(),
    playtimeSecs: 3600 * 27 + 1200,
    running: false,
    group: 'С друзьями',
  },
  {
    id: 'demo-2',
    name: 'Ванилла 1.20.1',
    gameVersion: '1.20.1',
    loader: null,
    loaderVersion: null,
    versionId: null,
    memoryMb: 3072,
    jvmArgs: '',
    accent: '#4f8cff',
    createdAt: new Date(now - 864e5 * 30).toISOString(),
    lastPlayed: new Date(now - 864e5 * 4).toISOString(),
    playtimeSecs: 3600 * 5,
    running: false,
  },
  {
    id: 'demo-3',
    name: 'Техно-сборка',
    gameVersion: '1.12.2',
    loader: null,
    loaderVersion: null,
    versionId: null,
    memoryMb: 6144,
    jvmArgs: '',
    accent: '#b06cff',
    createdAt: new Date(now - 864e5 * 60).toISOString(),
    lastPlayed: null,
    playtimeSecs: 0,
    running: false,
    group: 'Эксперименты',
  },
]

let sharedServer: string | null = null
let sharedEnabled = true

let accounts: Account[] = [
  { id: 'acc-1', username: 'Hytpotchi', uuid: 'b50ad385829d3141a2167e7d7539ba7f', kind: 'hytpotchi', active: true, skinUrl: null },
  { id: 'acc-old', username: 'OldNick', uuid: '0f0f0f0f0f0f30008000000000000000', kind: 'offline', active: false, skinUrl: null },
]

const hits: SearchHit[] = [
  ['sodium', 'Sodium', 'Современный движок отрисовки, заметно поднимает FPS', 'jellysquid3', 72_000_000],
  ['fabric-api', 'Fabric API', 'Базовая библиотека для модов Fabric', 'modmuss50', 95_000_000],
  ['iris', 'Iris Shaders', 'Шейдеры, совместимые с Sodium', 'coderbot', 41_000_000],
  ['modmenu', 'Mod Menu', 'Меню списка модов в игре', 'Prospector', 38_000_000],
  ['lithium', 'Lithium', 'Оптимизация игровой логики без изменения механик', 'jellysquid3', 30_000_000],
  ['xaeros-minimap', "Xaero's Minimap", 'Мини-карта с путевыми точками', 'thexaero', 22_000_000],
].map(([slug, title, description, author, downloads]) => ({
  project_id: String(slug),
  slug: String(slug),
  title: String(title),
  description: String(description),
  author: String(author),
  downloads: Number(downloads),
  follows: Math.round(Number(downloads) / 400),
  icon_url: null,
  project_type: 'mod',
  categories: ['fabric', 'optimization'],
  date_modified: new Date(now - 864e5 * 3).toISOString(),
}))

const local: LocalContent[] = [
  { filename: 'sodium-fabric-0.9.3-beta.5.jar', title: 'Sodium', enabled: true, size: 1_200_000, kind: 'mod', projectId: 'sodium', iconUrl: null, versionNumber: '0.9.3-beta.5+mc26.3', versionType: 'beta' },
  { filename: 'fabric-api-0.110.jar', title: 'Fabric API', enabled: true, size: 2_300_000, kind: 'mod', projectId: 'fabric-api', iconUrl: null },
  { filename: 'journeymap.jar.disabled', title: 'journeymap', enabled: false, size: 4_100_000, kind: 'mod', projectId: null, iconUrl: null },
]

async function fakeLaunch(id: string) {
  const javaMajor = 21
  const stages: [LaunchStage, string, number][] = [
    ['version', 'Получение версии', 1],
    ['java', `Загрузка Java ${javaMajor}`, 48_000_000],
    ['client', 'Загрузка клиента', 1],
    ['libraries', 'Загрузка библиотек', 62],
    ['assets', 'Загрузка ресурсов', 3800],
    ['natives', 'Распаковка нативов', 1],
    ['account', 'Проверка аккаунта', 1],
    ['starting', 'Запуск игры', 1],
  ]
  for (const [stage, label, total] of stages) {
    const steps = total > 1 ? 14 : 1
    for (let i = 1; i <= steps; i++) {
      await sleep(stage === 'java' || stage === 'assets' ? 110 : 160)
      const done = Math.round((total * i) / steps)
      emit('launch-progress', {
        instanceId: id,
        stage,
        label: stage === 'java' ? `${label} · ${(done / 1e6).toFixed(0)} / ${(total / 1e6).toFixed(0)} МБ` : label,
        done,
        total,
      })
    }
  }
  instances = instances.map((i) => (i.id === id ? { ...i, running: true, lastPlayed: new Date().toISOString() } : i))
  emit('launch-progress', { instanceId: id, stage: 'running', label: 'Игра запущена', done: 1, total: 1 })
  const lines = [
    '[Render thread/INFO]: Setting user: Hytpotchi',
    '[Render thread/INFO]: Backend library: LWJGL version 3.3.3',
    '[Render thread/WARN]: Missing sound for event: minecraft:item.goat_horn.play',
    '[Render thread/INFO]: Loaded 1290 recipes',
    '[Server thread/INFO]: Starting integrated minecraft server version 1.21.4',
    '[Render thread/INFO]: Connecting to local server',
  ]
  for (const line of lines) {
    await sleep(350)
    emit('game-log', { instanceId: id, line: `[${new Date().toLocaleTimeString()}] ${line}`, stderr: false })
  }
}

const mockFriends: {
  account: string | null
  enabled: boolean
  status: FriendStatus
  hosting: boolean
  friends: Friend[]
  requests: FriendPerson[]
  outgoing: FriendPerson[]
  invites: FriendInvite[]
} = {
  account: 'Hytpotchi',
  enabled: true,
  status: 'online',
  hosting: true,
  friends: [
    {
      id: 'f1',
      nick: 'Liza',
      online: true,
      status: 'online',
      activity: { instance: 'Выживание', mc: '1.21.4', loader: 'fabric' },
      host: { relay: true, world: 'Остров', mc: '1.21.4', loader: 'fabric', pack: 'f'.repeat(64), mods: 12 },
      lastSeen: Date.now(),
    },
    {
      id: 'f2',
      nick: 'Maks_Q',
      online: true,
      status: 'busy',
      activity: { instance: 'Техно-сборка', mc: '1.12.2', loader: null },
      host: null,
      lastSeen: Date.now(),
    },
    { id: 'f3', nick: 'Timur', online: false, status: 'offline', activity: null, host: null, lastSeen: Date.now() - 3 * 3600e3 },
  ],
  requests: [{ id: 'r1', nick: 'Danya', at: Date.now() - 600e3 }],
  outgoing: [],
  invites: [
    {
      id: 'i1',
      from: 'f1',
      fromNick: 'Liza',
      at: Date.now(),
      address: null,
      relay: true,
      pack: 'f'.repeat(64),
      instance: { name: 'Выживание', mc: '1.21.4', loader: 'fabric' },
      note: 'Заходи, строим базу!',
    },
  ],
}

function mockFriendsState(): FriendsState {
  const f = mockFriends
  return structuredClone({
    enabled: f.enabled,
    configured: true,
    account: f.account,
    hostOnlineMode: false,
    status: f.status,
    hosting: f.hosting,
    error: null,
    syncing: false,
    hosted: [],
    snapshot: {
      me: { id: 'me', nick: f.account ?? 'Hytpotchi' },
      friends: f.friends,
      requests: f.requests,
      outgoing: f.outgoing,
      invites: f.invites,
    },
  })
}

const mockBackgrounds:{ id: string; name: string; kind: string; path: string; file: string }[] = []

function pickBrowserFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.onchange = () => resolve(input.files?.[0] ?? null)
    input.oncancel = () => resolve(null)
    input.click()
  })
}

export async function mockCall<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  await sleep(120)
  const r = (v: unknown) => v as T
  switch (cmd) {
    case 'version_list': {
      const ids = ['24w45a', '1.21.4', '1.21.3', '1.21.1', '1.20.6', '1.20.4', '1.20.1', '1.19.4', '1.18.2', '1.16.5', '1.12.2', '1.8.9', '1.7.10']
      return r({
        latestRelease: '1.21.4',
        latestSnapshot: '24w45a',
        versions: ids.map((id, n) => ({ id, type: id.includes('w') ? 'snapshot' : 'release', releaseTime: new Date(now - n * 864e5 * 40).toISOString() })),
      })
    }
    case 'system_info':
      return r({ totalMemoryMb: 16384, recommendedMemoryMb: 6144, dataDir: 'C:\\Users\\you\\AppData\\Roaming\\.hytpotchi' })
    case 'java_list':
      return r({
        managed: [
          { version: '21.0.5+11', majorVersion: 21, path: '…/java/temurin-21', executable: '', vendor: 'Eclipse Temurin', managed: true },
          { version: '17.0.13+11', majorVersion: 17, path: '…/java/temurin-17', executable: '', vendor: 'Eclipse Temurin', managed: true },
        ],
        system: [],
      })
    case 'java_install':
      await sleep(1200)
      return r({ version: `${args.major}`, majorVersion: args.major, path: '', executable: '', vendor: 'Eclipse Temurin', managed: true })
    case 'instance_list':
      return r(instances)
    case 'instance_create': {
      const inst: Instance = {
        id: `demo-${Math.random().toString(36).slice(2, 8)}`,
        name: String(args.name),
        gameVersion: String(args.gameVersion),
        loader: (args.loader as Instance['loader']) ?? null,
        loaderVersion: null,
        versionId: null,
        memoryMb: Number(args.memoryMb),
        jvmArgs: '',
        accent: String(args.accent),
        createdAt: new Date().toISOString(),
        lastPlayed: null,
        playtimeSecs: 0,
        running: false,
      }
      instances = [inst, ...instances]
      return r(inst)
    }
    case 'instance_update':
      instances = instances.map((i) => (i.id === args.id ? { ...i, ...(args.patch as object) } : i))
      return r(instances.find((i) => i.id === args.id))
    case 'instance_remove':
      instances = instances.filter((i) => i.id !== args.id)
      return r(undefined)
    case 'instance_launch':
      await fakeLaunch(String(args.id))
      return r(4242)
    case 'instance_stop':
      instances = instances.map((i) => (i.id === args.id ? { ...i, running: false } : i))
      emit('game-exit', { instanceId: args.id, exitCode: 0, crashed: false, killed: true, playedSecs: 60 })
      return r(true)
    case 'game_logs':
      return r([])
    case 'account_list':
      return r(accounts.map((a) => ({ ...a })))
    case 'hytpotchi_register':
    case 'hytpotchi_login':
    case 'hytpotchi_recover': {
      const nick = String(args.nick)
      if (cmd === 'hytpotchi_register' && ['Notch', 'Steve'].includes(nick)) throw new Error('Этот ник уже занят')
      if (cmd === 'hytpotchi_login' && String(args.password).length < 8) throw new Error('Неверный ник или пароль')
      const acc: Account = { id: `acc-${Date.now()}`, username: nick, uuid: '00000000000030008000000000000000', kind: 'hytpotchi', active: true, skinUrl: null }
      const old = accounts.find((a) => a.id === args.replace)
      if (old) acc.offlineSkin = old.offlineSkin
      accounts = [...accounts.filter((a) => a.id !== args.replace).map((a) => ({ ...a, active: false })), acc]
      mockFriends.account = nick
      if (cmd === 'hytpotchi_login') return r(acc)
      return r({ account: acc, recovery: 'K7QP-2WXM-9FHT-4NCD' })
    }
    case 'hytpotchi_change_password':
      return r(undefined)
    case 'friends_join':
      return r('127.0.0.1:52811')
    case 'friends_sync_pack': {
      const total = 12
      for (let i = 0; i <= total; i++) {
        emit('modpack-progress', { label: 'Скачиваем моды друга', done: i, total, job: args.job })
        await sleep(120)
      }
      let inst = instances.find((x) => x.name === 'Сборка Liza')
      if (!inst) {
        inst = { ...instances[0], id: `inst-friend-${Date.now()}`, name: 'Сборка Liza', gameVersion: '1.21.4', loader: 'fabric', running: false }
        instances = [...instances, inst]
      }
      return r(inst)
    }
    case 'account_set_active':
      accounts = accounts.map((a) => ({ ...a, active: a.id === args.accountId }))
      return r(undefined)
    case 'account_remove':
      accounts = accounts.filter((a) => a.id !== args.accountId)
      if (accounts.length && !accounts.some((a) => a.active)) accounts[0] = { ...accounts[0], active: true }
      return r(undefined)
    case 'microsoft_auth_start':
      return r({ deviceCode: 'demo', userCode: 'HYT-P0TC', verificationUri: 'https://www.microsoft.com/link', expiresIn: 900, interval: 5 })
    case 'microsoft_auth_poll':
      return r(null)
    case 'modrinth_search': {
      const q = String(args.query ?? '').toLowerCase()
      const filtered = hits.filter((h) => !q || h.title.toLowerCase().includes(q))
      return r({ hits: filtered, offset: 0, limit: 20, total_hits: filtered.length })
    }
    case 'modrinth_install':
      await sleep(900)
      return r({ installed: [hits.find((h) => h.project_id === args.projectId)?.title ?? 'Мод'] })
    case 'local_mods_scan':
      return r(local)
    case 'world_list':
      return r([
        { folder: 'Новый мир', size: 48_000_000, lastPlayed: new Date(now - 36e5 * 3).toISOString(), icon: null },
        { folder: 'Креатив — замок', size: 12_500_000, lastPlayed: new Date(now - 864e5 * 6).toISOString(), icon: null },
      ])
    case 'screenshot_list':
      return r([])
    case 'mc_news':
      return r(
        [
          ['Minecraft Java Edition 26.3', '26.3', 'release'],
          ['Снапшот 26w45a', '26w45a', 'snapshot'],
          ['Minecraft Java Edition 26.2', '26.2', 'release'],
          ['Пре-релиз 26.2-pre1', '26.2-pre1', 'snapshot'],
        ].map(([title, version, kind], n) => ({
          title,
          version,
          kind,
          image: '',
          date: new Date(now - n * 864e5 * 9).toISOString(),
          summary: 'Новые блоки, улучшения производительности и исправления ошибок.',
          url: 'https://www.minecraft.net',
        })),
      )
    case 'modpack_install':
    case 'mrpack_import': {
      for (const [label, total] of [['Скачиваем модпак', 1], ['Скачиваем моды', 40], ['Распаковываем настройки', 1]] as const) {
        for (let i = 1; i <= Math.min(total, 10); i++) {
          await sleep(120)
          emit('modpack-progress', { label, done: Math.round((total * i) / Math.min(total, 10)), total })
        }
      }
      return mockCall<T>('instance_create', { name: 'Модпак', gameVersion: '1.20.1', loader: 'forge', memoryMb: 6144, accent: '#ff7a59' })
    }
    case 'content_check_updates':
      await sleep(600)
      return r([
        { projectId: 'sodium', title: 'Sodium', current: '0.9.3-beta.5+mc26.3', latest: '0.9.2+mc26.3', versionId: 'v3', versionType: 'release' },
        { projectId: 'fabric-api', title: 'Fabric API', current: '0.110.0', latest: '0.112.1', versionId: 'fa2', versionType: 'release' },
      ])
    case 'saved_servers':
      return r([
        { name: 'Сервер с друзьями', address: 'play.example.org', icon: null },
        { name: 'Локальный', address: 'localhost:25565', icon: null },
      ])
    case 'server_ping': {
      await sleep(300)
      const online = String(args.address).startsWith('play')
      return r(
        online
          ? { online, players: 12, maxPlayers: 100, version: '26.3', motd: 'Добро пожаловать!', pingMs: 38, favicon: null }
          : { online: false, players: null, maxPlayers: null, version: null, motd: null, pingMs: null, favicon: null },
      )
    }
    case 'saved_server_add':
    case 'saved_server_remove':
    case 'discord_set_enabled':
      return r(undefined)
    case 'discord_status':
      return r({ available: false })
    case 'import_instance':
      return mockCall<T>('mrpack_import', args)
    case 'export_instance':
      await sleep(800)
      return r('C:\\Users\\you\\Desktop\\pack.mrpack')
    case 'instance_set_cover':
    case 'instance_clear_cover':
      return r(instances.find((i) => i.id === args.id) ?? null)
    case 'skin_profile':
    case 'skin_reset': {
      const acc = accounts.find((a) => a.id === args.accountId)
      if (cmd === 'skin_reset' && acc) acc.offlineSkin = null
      return r({ username: acc?.username ?? 'Игрок', uuid: acc?.uuid ?? '', skin: acc?.offlineSkin ?? null, variant: 'classic', capes: [] })
    }
    case 'features_status':
      return r({ version: '0.1.0', microsoft: false, skinServer: sharedServer !== null, discord: false, updater: false })
    case 'update_check':
      return r({ supported: false, currentVersion: '0.1.0', version: null, notes: null })
    case 'shared_skins_get':
      return r({ enabled: sharedEnabled, customServer: sharedServer, server: sharedServer })
    case 'shared_skins_set': {
      await sleep(500)
      const url = args.server ? String(args.server).replace(/\/+$/, '') : null
      if (url && !url.startsWith('https://')) throw new Error('Адрес сервера скинов должен начинаться с https://')
      sharedServer = url
      sharedEnabled = Boolean(args.enabled)
      return mockCall<T>('shared_skins_get')
    }
    case 'skin_publish':
      await sleep(400)
      return r(
        sharedServer
          ? { state: 'published', message: 'Скин опубликован — его видят другие игроки Hytpotchi' }
          : { state: 'not_configured', message: 'Скин надет только у вас: сервер скинов не настроен (Настройки → Общие скины)' },
      )
    case 'skin_apply': {
      const lib = await mockCall<{ id: string; image: string }[]>('skin_library')
      const acc = accounts.find((a) => a.id === args.accountId)
      if (acc) acc.offlineSkin = lib.find((s) => s.id === args.skinId)?.image ?? null
      const profile = await mockCall<object>('skin_profile', { accountId: args.accountId })
      const shared = await mockCall<object>('skin_publish', {})
      return r({ ...profile, shared })
    }
    case 'skin_library': {
      // Простой тестовый скин 64×64, нарисованный на лету
      const c = document.createElement('canvas')
      c.width = 64
      c.height = 64
      const g = c.getContext('2d')!
      const fill = (x: number, y: number, w: number, h: number, col: string) => {
        g.fillStyle = col
        g.fillRect(x, y, w, h)
      }
      fill(8, 8, 8, 8, '#c99a72')
      fill(8, 8, 8, 2, '#4a2f1a')
      fill(9, 12, 2, 1, '#2b2b8f')
      fill(13, 12, 2, 1, '#2b2b8f')
      fill(24, 8, 8, 8, '#4a2f1a')
      fill(20, 20, 8, 12, '#2fb4a8')
      fill(32, 20, 8, 12, '#279a90')
      fill(44, 20, 4, 12, '#c99a72')
      fill(52, 20, 4, 12, '#b3865f')
      fill(36, 52, 4, 12, '#c99a72')
      fill(44, 52, 4, 12, '#b3865f')
      fill(4, 20, 4, 12, '#3b3fa8')
      fill(12, 20, 4, 12, '#33378f')
      fill(20, 52, 4, 12, '#3b3fa8')
      fill(28, 52, 4, 12, '#33378f')
      return r([{ id: 'demo', name: 'Стив', variant: 'classic', image: c.toDataURL() }])
    }
    case 'modrinth_versions':
      return r(
        [
          ['v4', '0.9.3-beta.5+mc26.3', 'beta', true, false],
          ['v3', '0.9.2+mc26.3', 'release', false, true],
          ['v2', '0.9.1+mc26.3', 'release', false, false],
          ['v1', '0.9.0-alpha.2+mc26.3', 'alpha', false, false],
        ].map(([id, number, versionType, current, recommended], n) => ({
          id,
          name: `Sodium ${number}`,
          number,
          versionType,
          date: new Date(now - n * 864e5 * 6).toISOString(),
          current,
          recommended,
        })),
      )
    case 'modrinth_install_version':
      await sleep(700)
      return r({ installed: ['Sodium'] })
    case 'world_backup':
      await sleep(600)
      return r('backup.zip')
    case 'world_delete':
    case 'screenshot_delete':
    case 'instance_open_subfolder':
    case 'open_file':
    case 'mod_toggle':
    case 'mod_remove':
    case 'instance_open_folder':
    case 'open_data_folder':
      return r(undefined)
    // Друзья в демо-режиме
    case 'friends_state':
    case 'friends_refresh':
      return r(mockFriendsState())
    case 'friends_settings': {
      if (typeof args.enabled === 'boolean') mockFriends.enabled = args.enabled
      if (typeof args.status === 'string') mockFriends.status = args.status as FriendStatus
      if (typeof args.hosting === 'boolean') mockFriends.hosting = args.hosting
      return r(mockFriendsState())
    }
    case 'friends_request': {
      const nick = String(args.nick)
      if (nick === 'Ghost') throw new Error(`Игрок ${nick} не зарегистрирован в Hytpotchi`)
      mockFriends.outgoing.push({ id: `o${nick}`, nick, at: now })
      return r(mockFriendsState())
    }
    case 'friends_respond': {
      const req = mockFriends.requests.find((q) => q.id === args.id)
      mockFriends.requests = mockFriends.requests.filter((q) => q.id !== args.id)
      if (req && args.accept)
        mockFriends.friends.push({ ...req, online: true, status: 'online', activity: null, host: null, lastSeen: now })
      return r(mockFriendsState())
    }
    case 'friends_remove':
      mockFriends.friends = mockFriends.friends.filter((f) => f.id !== args.id)
      mockFriends.outgoing = mockFriends.outgoing.filter((f) => f.id !== args.id)
      return r(mockFriendsState())
    case 'friends_invite':
      return r(mockFriendsState())
    case 'friends_dismiss':
      mockFriends.invites = mockFriends.invites.filter((i) => i.id !== args.id)
      return r(mockFriendsState())
    // Свои фоны в демо-режиме: файл выбирается браузерным диалогом и живёт до перезагрузки
    case 'background_list':
      return r([...mockBackgrounds])
    case 'background_add': {
      const file = await pickBrowserFile('image/*,video/mp4,video/webm')
      if (!file) return r(null)
      const id = Math.random().toString(36).slice(2)
      const bg = {
        id,
        name: file.name.replace(/\.[^.]+$/, ''),
        kind: file.type.startsWith('video/') ? 'video' : 'image',
        path: URL.createObjectURL(file),
        file: file.name,
      }
      mockBackgrounds.push(bg)
      return r(bg)
    }
    case 'background_rename': {
      const bg = mockBackgrounds.find((b) => b.id === args.id)
      if (bg) bg.name = String(args.name)
      return r([...mockBackgrounds])
    }
    case 'background_remove': {
      const i = mockBackgrounds.findIndex((b) => b.id === args.id)
      if (i >= 0) mockBackgrounds.splice(i, 1)
      return r([...mockBackgrounds])
    }
    default:
      throw new Error(`Демо-режим: команда ${cmd} недоступна`)
  }
}
