# Hytpotchi Launcher — Full Clone Implementation Plan

**Target**: Feature-parity clone of [millida/launcher](https://github.com/millida/launcher)  
**Stack**: Tauri 2 + React 19 + TypeScript + Rust  
**Platform**: Windows only (WebView2)  
**Auth**: Microsoft Device Code Flow (Azure AD App Registration required)

---

## 1. Project Structure (Mirroring millida Architecture)

```
hytpotchi-launcher/
├── src/                          # React 19 + TypeScript Frontend
│   ├── main.tsx                  # Entry point
│   ├── App.tsx                   # Root component, screen router (class-based)
│   ├── styles/
│   │   ├── 01-base.css           # CSS variables, reset, typography
│   │   ├── 02-layout.css         # Grid/flex layouts, screen containers
│   │   ├── 03-components.css     # Reusable UI components
│   │   ├── 04-screens.css        # Screen-specific styles
│   │   └── 05-media.css          # @media queries, animations
│   ├── screens/                  # Lazy-loaded screen components
│   │   ├── registry.ts           # Screen registry + lazy loading
│   │   ├── Home/                 # Instance list, play button
│   │   ├── InstanceSettings/     # Version, loader, Java, memory, JVM args
│   │   ├── Mods/                 # Modrinth/CurseForge browser, installed mods
│   │   ├── Accounts/             # Microsoft auth, offline accounts
│   │   ├── Skins/                # Skin library, 3D preview, CustomSkinLoader
│   │   ├── Friends/              # Friends list, invites, presence
│   │   ├── Voice/                # WebRTC voice/video calls
│   │   ├── ServerPanel/          # Server console, file manager, worlds
│   │   ├── Worlds/               # World backup/restore/copy/export
│   │   ├── Settings/             # General, appearance, telemetry, updates
│   │   └── Cloud/                # Cloud profile sync
│   ├── state/                    # Zustand stores (one per domain)
│   │   ├── instances.ts          # Instance CRUD, active instance
│   │   ├── mods.ts               # Mod search, installed, updates
│   │   ├── accounts.ts           # Microsoft sessions, offline accounts
│   │   ├── skins.ts              # Skin library, uploads, authlib
│   │   ├── friends.ts            # Friends, requests, presence
│   │   ├── voice.ts              # Call state, WebRTC connections
│   │   ├── game.ts               # Launch state, logs, running processes
│   │   ├── ui.ts                 # Theme, sidebar, toasts, modals
│   │   └── settings.ts           # User preferences (localStorage)
│   ├── ipc/                      # Tauri IPC Bridge
│   │   ├── tauri.ts              # invoke() wrapper, event listeners
│   │   ├── commands.ts           # Typed command definitions (~135 commands)
│   │   └── events.ts             # Backend → Frontend event types
│   ├── lib/                      # Shared utilities
│   │   ├── telemetry.ts          # Opt-in telemetry client
│   │   ├── launch.ts             # Launch parameter builders
│   │   ├── secure.ts             # Crypto helpers (Web Crypto API)
│   │   ├── crypto.ts             # HKDF, AES-GCM wrappers
│   │   └── utils.ts              # General helpers
│   └── vendor/                   # Bundled third-party (mine3d, etc.)
├── src-tauri/                    # Rust Backend (Core Engine)
│   ├── src/
│   │   ├── main.rs               # Entry, Tauri app builder
│   │   ├── lib.rs                # Plugin setup, command registration (~135)
│   │   ├── secrets.rs            # Encrypted token vault (AES-256-GCM + DPAPI)
│   │   ├── commands/             # IPC command wrappers (thin, parse → engine)
│   │   │   ├── accounts.rs
│   │   │   ├── game.rs
│   │   │   ├── content.rs
│   │   │   ├── profiles.rs
│   │   │   ├── skins.rs
│   │   │   ├── cloud.rs
│   │   │   ├── friends.rs
│   │   │   ├── voice.rs
│   │   │   ├── server.rs
│   │   │   ├── telemetry.rs
│   │   │   └── update.rs
│   │   ├── engine/               # Core Business Logic
│   │   │   ├── core/             # HTTP client, paths, archives, dedup, self-update
│   │   │   │   ├── http.rs       # reqwest + rustls, retry, proxy
│   │   │   │   ├── paths.rs      # App dirs, safe_join, canonicalization
│   │   │   │   ├── archive.rs    # zip/tar.gz/zstd extraction
│   │   │   │   ├── dedup.rs      # Content-addressable store + hard links
│   │   │   │   ├── selfupdate.rs # minisign verification, delta updates
│   │   │   │   ├── selfheal.rs   # Frontend readiness watchdog
│   │   │   │   └── crash.rs      # Crash handler, minidump
│   │   │   ├── game/             # Version install, Java, launch pipeline
│   │   │   │   ├── manifest.rs   # Version manifest parsing/merging
│   │   │   │   ├── install.rs    # Client, libraries, assets, loaders
│   │   │   │   ├── java.rs       # Adoptium API, Temurin detection, validation
│   │   │   │   ├── launch/
│   │   │   │   │   ├── plan.rs       # Pure: version json → JVM command line
│   │   │   │   │   ├── prepare.rs    # Parallel task graph (account, java, libs, natives)
│   │   │   │   │   ├── start.rs      # Spawn JVM, log streaming
│   │   │   │   │   └── watch.rs      # Process tracking, stop handling
│   │   │   │   ├── worlds.rs     # World CRUD, backup, NBT, screenshots
│   │   │   │   ├── servers.rs    # Server ping, RCON, console
│   │   │   │   ├── tuning.rs     # Auto RAM, GC flags, FPS Boost mods
│   │   │   │   └── crashfix.rs   # Known crash patterns → fixes
│   │   │   ├── content/          # Mods/modpacks
│   │   │   │   ├── modrinth.rs   # Modrinth API v2 client
│   │   │   │   ├── curseforge.rs # CurseForge API (via backend proxy)
│   │   │   │   ├── local.rs      # Local file scan, SHA1 + MurmurHash2 fingerprint
│   │   │   │   ├── resolver.rs   # Unified dependency resolver
│   │   │   │   ├── updates.rs    # Mod update checking
│   │   │   │   └── mrpack.rs     # .mrpack import/export
│   │   │   ├── profiles/         # Instance management
│   │   │   │   ├── store.rs      # profiles.json CRUD
│   │   │   │   ├── groups.rs     # Instance groups
│   │   │   │   ├── covers.rs     # Cover images
│   │   │   │   ├── import.rs     # Prism, MultiMC, ATLauncher, GDLauncher, vanilla
│   │   │   │   ├── export.rs     # .mrpack, backup
│   │   │   │   └── screenshots.rs
│   │   │   ├── accounts/         # Authentication
│   │   │   │   ├── microsoft.rs  # Device code flow, token refresh
│   │   │   │   ├── millida.rs    # Millida API proxy (optional, for cloud)
│   │   │   │   ├── session.rs    # Session binding, validation
│   │   │   │   └── vault.rs      # Token storage (delegates to secrets.rs)
│   │   │   ├── skins/            # Cosmetics
│   │   │   │   ├── mojang.rs     # Mojang profile API, skin/cape upload
│   │   │   │   ├── library.rs    # Local skin library
│   │   │   │   ├── authlib.rs    # authlib-injector Yggdrasil
│   │   │   │   ├── customskin.rs # CustomSkinLoader install/config
│   │   │   │   └── avatar.rs     # 3D head rendering data
│   │   │   ├── cloud/            # Cloud sync
│   │   │   │   ├── sync.rs       # Manifest-only sync (no files)
│   │   │   │   └── conflict.rs   # Conflict resolution
│   │   │   ├── friends/          # Social
│   │   │   │   ├── api.rs        # Friends backend API
│   │   │   │   ├── presence.rs   # Online status, game activity
│   │   │   │   └── invites.rs    # Friend requests
│   │   │   ├── voice/            # WebRTC Mesh
│   │   │   │   ├── signaling.rs  # Centrifuge WebSocket
│   │   │   │   ├── webrtc.rs     # Peer connections, mesh topology
│   │   │   │   ├── audio.rs      # Opus, AudioWorklet noise gate
│   │   │   │   ├── screen.rs     # getDisplayMedia, H.264 encoding
│   │   │   │   └── turn.rs       # TURN credentials
│   │   │   ├── server/           # Server hosting panel
│   │   │   │   ├── console.rs    # Process I/O, ANSI parsing
│   │   │   │   ├── files.rs      # File manager (upload/download/delete)
│   │   │   │   ├── worlds.rs     # World management
│   │   │   │   └── mods.rs       # Server mod installation
│   │   │   └── media/            # Music, sounds, wallpapers
│   │   │       ├── audio.rs      # OGG/MP3, lamejs re-encode
│   │   │       └── wallpaper.rs  # Downloaded + local
│   │   ├── tray.rs               # System tray icon/menu
│   │   ├── discord.rs            # Discord Rich Presence
│   │   ├── overlay.rs            # Transparent overlay window (Alt+M)
│   │   ├── background.rs         # Background service (updates, calls)
│   │   └── graphics_capture.rs   # Windows Graphics Capture API (Rewind)
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   └── build.rs                  # minisign public key embed
├── .github/workflows/
│   └── release.yml               # CI: build, sign, attest, release
├── ARCHITECTURE.md               # Detailed architecture doc
├── BUILDING.md                   # Build instructions
├── TELEMETRY.md                  # Telemetry specification
├── SAFETY.md                     # Supply chain verification
├── SECURITY.md                   # Vulnerability reporting
├── CONTRIBUTING.md               # Contribution guide
├── TRADEMARK.md                  # Branding guidelines
└── dmca.md                       # DMCA contact
```

---

## 2. Phase Breakdown & Dependencies

### Phase 0: Foundation (Week 1)
| Task | Depends On | Est. |
|------|------------|------|
| Tauri 2 + React 19 + TypeScript + Bun setup | — | 1d |
| CSS architecture (01-base → 05-media) | — | 0.5d |
| Screen router (class-based, lazy load) | — | 0.5d |
| Zustand store pattern + IPC bridge | — | 1d |
| Rust workspace + Tauri plugins | — | 1d |
| **paths.rs, safe_join, archive, http client** | — | 1d |
| **secrets.rs (DPAPI vault)** | — | 1d |

**Deliverable**: Empty app launches, IPC works, encrypted storage ready.

---

### Phase 1: Microsoft Authentication (Week 2) — **CRITICAL PATH**
| Task | Depends On | Est. |
|------|------------|------|
| Azure AD App Registration (client_id, redirect_uri) | — | 0.5d |
| Device Code Flow implementation (Rust) | secrets.rs | 2d |
| Token refresh + session binding | vault.rs | 1d |
| Frontend: Accounts screen + sign-in flow | IPC bridge | 1d |
| Offline account support | — | 0.5d |
| Profile fetch (UUID, username, skins) | microsoft.rs | 0.5d |

**Deliverable**: User can sign in with Microsoft, tokens encrypted in vault, profile shown.

> ⚠️ **Blocker**: Need Azure AD App Registration **before** coding. Configure:
> - Platform: "Mobile and desktop applications"
> - Redirect URI: `http://localhost` (device code flow)
> - Permissions: `XboxLive.signin`, `offline_access`
> - Public client flows: **Yes**

---

### Phase 2: Game Install & Launch Pipeline (Weeks 3–5)
| Module | Tasks | Est. |
|--------|-------|------|
| **manifest.rs** | Version manifest v2 parsing, inheritance, library merging | 2d |
| **install.rs** | Client jar, libraries (Maven), assets (index + objects), loader installers (Forge/Fabric/Quilt/NeoForge) | 4d |
| **java.rs** | Adoptium API v3, Temurin 8/11/17/21 detection, checksum validation, custom Java path | 2d |
| **launch/plan.rs** | Pure function: version JSON → full JVM command line (args, classpath, natives, properties) | 3d |
| **launch/prepare.rs** | Parallel task graph: account session, Java, client, libraries, natives, assets, loader meta | 3d |
| **launch/start.rs** | Spawn child process (no console window), stdout/stderr → log file + event stream | 2d |
| **launch/watch.rs** | Process tracking map, stop request handling, exit code analysis | 1d |
| **tuning.rs** | Auto RAM (heuristic), GC flags (G1/ZGC), FPS Boost mod auto-install | 2d |

**Deliverable**: Can launch Vanilla + Forge + Fabric instances with correct Java.

---

### Phase 3: Mod Management (Weeks 5–7)
| Module | Tasks | Est. |
|--------|-------|------|
| **modrinth.rs** | Modrinth API v2: search, versions, dependencies, download | 2d |
| **curseforge.rs** | CurseForge API via backend proxy (protect API key), fingerprint matching | 3d |
| **local.rs** | Scan mods folder, SHA1 + MurmurHash2 (CurseForge fingerprint) | 2d |
| **resolver.rs** | Unified resolver: transitive deps, conflict detection, install preview | 4d |
| **mrpack.rs** | Import/export .mrpack (Modrinth format) | 2d |
| **updates.rs** | Check for mod updates (both sources) | 1d |
| Frontend: Mods screen (search, installed, updates, drag-drop) | IPC commands | 3d |

**Deliverable**: Full mod browser, dependency resolution, .mrpack support.

---

### Phase 4: Profiles & Instance Management (Week 7–8)
| Module | Tasks | Est. |
|--------|-------|------|
| **store.rs** | profiles.json: CRUD, validation, migration | 1d |
| **groups.rs** | Instance groups (nested, drag-drop) | 1d |
| **covers.rs** | Cover image download/cache, custom upload | 1d |
| **import.rs** | Prism, MultiMC, ATLauncher, GDLauncher, CurseForge App, vanilla .minecraft | 3d |
| **export.rs** | .mrpack export, instance backup (zip) | 1d |
| **screenshots.rs** | In-game screenshot gallery | 1d |
| Frontend: Instance settings, groups, import/export wizard | — | 3d |

**Deliverable**: Complete instance lifecycle, migration from other launchers.

---

### Phase 5: Skins & Cosmetics (Week 8–9)
| Module | Tasks | Est. |
|--------|-------|------|
| **mojang.rs** | Mojang profile API: skin/cape upload, texture fetching | 1d |
| **library.rs** | Local skin library (file + metadata), 3D preview data | 1d |
| **authlib.rs** | authlib-injector: download, configure custom Yggdrasil | 2d |
| **customskin.rs** | CustomSkinLoader install, config generation | 1d |
| **avatar.rs** | 3D head geometry + texture for frontend | 1d |
| Frontend: Skins screen, 3D preview (three.js via mine3d), upload | — | 2d |

**Deliverable**: Skin library, CustomSkinLoader, authlib-injector, 3D preview.

---

### Phase 6: Social & Voice/Video (Weeks 9–12) — **HIGH COMPLEXITY**
| Module | Tasks | Est. |
|--------|-------|------|
| **friends/api.rs** | Friends backend API (or simple WebSocket server) | 3d |
| **friends/presence.rs** | Online status, current game, rich presence | 2d |
| **voice/signaling.rs** | Centrifuge WebSocket client, room management | 3d |
| **voice/webrtc.rs** | Mesh topology (up to 10 audio, 5 screen), renegotiation | 5d |
| **voice/audio.rs** | Opus encoding, AudioWorklet noise gate (micGateStep) | 3d |
| **voice/screen.rs** | getDisplayMedia, H.264 (Media Foundation), degradationPreference | 3d |
| **voice/turn.rs** | TURN credential fetch, ICE candidate handling | 1d |
| Frontend: Friends list, call UI, screen share picker | — | 3d |

> ⚠️ **Alternative**: Skip custom backend → use existing (Millida API proxy) or defer to Phase 9.

**Deliverable**: Friend system, voice calls, screen sharing (mesh WebRTC).

---

### Phase 7: Server Hosting Panel (Week 12–13)
| Module | Tasks | Est. |
|--------|-------|------|
| **server/console.rs** | Process I/O, ANSI parsing, command input | 2d |
| **server/files.rs** | File manager: tree, upload/download/delete/edit | 2d |
| **server/worlds.rs** | World list, backup, delete, settings (server.properties) | 1d |
| **server/mods.rs** | Server-side mod installation (Forge/Fabric) | 1d |
| Frontend: Server dashboard, console, file manager | — | 2d |

**Deliverable**: Full server control panel.

---

### Phase 8: Worlds Management (Week 13)
| Module | Tasks | Est. |
|--------|-------|------|
| **worlds.rs** | World CRUD, NBT parsing (level.dat), backup/restore | 2d |
| **screenshots.rs** | Screenshot capture, gallery, metadata | 1d |
| Frontend: Worlds screen, backup manager, screenshot gallery | — | 2d |

**Deliverable**: World backup/restore, screenshot gallery.

---

### Phase 9: Cloud Sync & Polish (Week 14)
| Module | Tasks | Est. |
|--------|-------|------|
| **cloud/sync.rs** | Manifest-only sync (instances, groups, settings) | 2d |
| **cloud/conflict.rs** | Last-write-wins + manual merge UI | 1d |
| **selfupdate.rs** | minisign verification, delta updates (zstd patch) | 2d |
| **selfheal.rs** | Frontend readiness watchdog → reinstall | 1d |
| **overlay.rs** | Transparent always-on-top window (Alt+M), now-playing | 2d |
| **graphics_capture.rs** | Windows Graphics Capture → H.264 (Rewind) | 3d |
| **discord.rs** | Rich Presence (game state, party) | 1d |
| **telemetry.rs** | Opt-in events, scrubbing, batch upload | 2d |
| Settings screen, theme, wallpapers, accessibility | — | 3d |

**Deliverable**: Cloud sync, self-update, overlay, Rewind, Discord RPC, telemetry.

---

### Phase 10: Build, Sign, Release (Week 15)
| Task | Est. |
|------|------|
| GitHub Actions workflow (build, test, sign) | 2d |
| Code signing cert (Certum / DigiCert) + Azure Key Vault | 1d |
| minisign keypair generation + public key embed | 0.5d |
| NSIS/MSIX installer, delta updates | 1d |
| gh attestation verify (SLSA) | 1d |
| VirusTotal scan automation | 0.5d |
| Release notes, changelog automation | 0.5d |

**Deliverable**: Signed installer, auto-update, verified builds.

---

## 3. Critical Path Items

```
Azure AD App Reg (Day 1)
       ↓
Microsoft Device Flow (Week 2)
       ↓
Game Launch Pipeline (Weeks 3-5) ──────────────────┐
       ↓                                           │
Mod Management (Weeks 5-7)                         │
       ↓                                           │
Profiles/Import (Weeks 7-8)                        │──→ MVP Launchable
       ↓                                           │
Skins (Weeks 8-9)                                  │
       ↓                                           │
Social/Voice (Weeks 9-12)  ←── Can defer to v1.1   │
       ↓                                           │
Server/Worlds (Weeks 12-13)                        │
       ↓                                           │
Cloud/Self-Update/Polish (Week 14)                 │
       ↓                                           │
Build/Sign/Release (Week 15)                       │
```

**Total: ~15 weeks (3.5 months) for full clone solo**  
**With 2-3 devs: ~8-10 weeks** (parallelize Phases 3/4/5, 6/7/8)

---

## 4. Rust Engine Module Breakdown (Detailed)

### `engine/core/`
| File | Responsibility |
|------|----------------|
| `http.rs` | `reqwest::Client` with rustls, gzip, http2, system proxy (Windows), retry/backoff, timeout config |
| `paths.rs` | `app_dir()`, `instances_dir()`, `java_dir()`, `cache_dir()`, `safe_join()`, `safe_child()`, `safe_file_name()` — canonicalization, traversal block, reserved names |
| `archive.rs` | `extract_zip()`, `extract_tar_gz()`, `extract_zstd()` — streaming, progress, integrity |
| `dedup.rs` | Content-addressable store: `objects/<xx>/<sha1>`, hard link on install, refcount GC |
| `selfupdate.rs` | Manifest fetch, minisign verify, delta patch (zstd), atomic replace, rollback |
| `selfheal.rs` | Watchdog: if `frontend_ready` not received in 30s → mark broken → reinstall on next start |
| `crash.rs` | `minidump` crate, crash context, auto-upload (opt-in) |

### `engine/game/`
| File | Responsibility |
|------|----------------|
| `manifest.rs` | `VersionManifest` struct, inheritance resolution, library merging (natives per OS), asset index |
| `install.rs` | `install_version()`: client jar → libraries (Maven resolver) → assets (parallel) → loader installer |
| `java.rs` | `JavaRuntime`: major version, path, validation (checksum), `AdoptiumClient`: releases API, Temurin URLs |
| `launch/plan.rs` | `LaunchPlan`: pure, snapshot-testable (20 reference builds), produces `Vec<String>` JVM args |
| `launch/prepare.rs` | Task graph: `AccountTask`, `JavaTask`, `ClientTask`, `LibrariesTask`, `NativesTask`, `AssetsTask`, `LoaderTask` — parallel via `tokio::join!` |
| `launch/start.rs` | `Command::new(java).args(&plan).stdout(pipe).stderr(pipe).spawn()`, no console (Windows: `CREATE_NO_WINDOW`) |
| `launch/watch.rs` | `RUNNING: DashMap<u32, ChildProcess>`, `stop_instance(pid)`, exit code → `GameExit` event |
| `worlds.rs` | `World`: NBT `level.dat` parse, `backup()`, `restore()`, `copy()`, `export()`, `screenshots()` |
| `servers.rs` | `ping_server()`, `RCON`, `console_log_stream()` |
| `tuning.rs` | `auto_ram(total_mem)`, `gc_flags(java_version)`, `fps_boost_mods(loader)` |
| `crashfix.rs` | Pattern → fix mapping (e.g., "OpenGL 1.4" → `--add-modules=jdk.naming.dns`) |

### `engine/content/`
| File | Responsibility |
|------|----------------|
| `modrinth.rs` | `ModrinthClient`: search, project, versions, files, dependencies, download (SHA1/SHA512 verify) |
| `curseforge.rs` | `CurseForgeClient` (backend proxy): search, file info, fingerprint (MurmurHash2), download |
| `local.rs` | `scan_mods_dir()`: parse `mods.toml`/`fabric.mod.json`, SHA1 file hash, CF fingerprint |
| `resolver.rs` | `resolve(mods: Vec<ModId>) -> InstallPlan`: topological sort, conflict detection, missing deps |
| `updates.rs` | `check_updates(installed: Vec<Mod>) -> Vec<Update>` |
| `mrpack.rs` | `import_mrpack()`, `export_mrpack(instances: Vec<Instance>)` |

### `engine/profiles/`
| File | Responsibility |
|------|----------------|
| `store.rs` | `ProfilesStore`: `profiles.json` atomic write, schema validation, migration |
| `groups.rs` | `Group`: nested, order, drag-drop serialization |
| `covers.rs` | Cover download (Modrinth/CF), cache, custom upload (resize → WebP) |
| `import.rs` | `detect_source(path)`, parsers for each launcher format |
| `export.rs` | `export_mrpack()`, `backup_instance()` |
| `screenshots.rs` | `Screenshot`: path, instance, timestamp, metadata (dimensions) |

### `engine/accounts/`
| File | Responsibility |
|------|----------------|
| `microsoft.rs` | Device code flow: `start_auth() -> (device_code, user_code, verification_uri)`, `poll_token()`, `refresh_token()` |
| `millida.rs` | Optional: Millida API proxy for cloud features |
| `session.rs` | `GameSession`: access_token, uuid, username, expires_at, `validate()` |
| `vault.rs` | `TokenVault`: `store(account_id, tokens)`, `get(account_id) -> Tokens`, `delete()`, delegates to `secrets.rs` |

### `engine/skins/`
| File | Responsibility |
|------|----------------|
| `mojang.rs` | `upload_skin()`, `upload_cape()`, `get_textures(uuid)` |
| `library.rs` | `SkinLibrary`: local files + metadata (name, type, model), 3D head data |
| `authlib.rs` | `download_authlib_injector()`, `generate_yggdrasil_config(skin_url)` |
| `customskin.rs` | `install_customskinloader(instance)`, `generate_config(skins)` |
| `avatar.rs` | `AvatarGeometry`: head model + texture coordinates for three.js |

### `engine/cloud/`
| File | Responsibility |
|------|----------------|
| `sync.rs` | `sync_profiles()`, `pull()`, `push()` — manifest only (no files) |
| `conflict.rs` | `resolve_conflict(local, remote) -> Merged` |

### `engine/friends/`
| File | Responsibility |
|------|----------------|
| `api.rs` | WebSocket client: connect, auth, subscribe, request/response |
| `presence.rs` | `Presence`: status, game_activity, last_seen |
| `invites.rs` | Friend request send/accept/decline/block |

### `engine/voice/`
| File | Responsibility |
|------|----------------|
| `signaling.rs` | Centrifuge protocol: subscribe, publish, history, presence |
| `webrtc.rs` | `PeerConnection` mesh: `RTCPeerConnection`, ICE, DTLS, renegotiation |
| `audio.rs` | Opus encoder/decoder, `AudioWorklet` noise gate (micGateStep.js) |
| `screen.rs` | `getDisplayMedia()`, H.264 encoder (Media Foundation), simulcast |
| `turn.rs` | TURN credential fetch, `RTCIceServer` config |

### `engine/server/`
| File | Responsibility |
|------|----------------|
| `console.rs` | `ServerProcess`: stdin/stdout/stderr, ANSI strip, command queue |
| `files.rs` | `FileManager`: list, read, write, delete, upload (multipart), download (range) |
| `worlds.rs` | World CRUD, `server.properties` edit |
| `mods.rs` | Server mod install (Forge/Fabric installer headless) |

### `engine/media/`
| File | Responsibility |
|------|----------------|
| `audio.rs` | OGG decode, MP3 encode (lamejs), playlist |
| `wallpaper.rs` | Wallpaper download, cache, slideshow |

---

## 5. Frontend Screen/State Architecture

### Screen Router (No React Router)
```tsx
// App.tsx
const screens = ['Home', 'InstanceSettings', 'Mods', 'Accounts', 'Skins', 'Friends', 'Voice', 'ServerPanel', 'Worlds', 'Settings', 'Cloud'];
// <section class={`screen ${activeScreen}`}> — CSS `display: none` / `.on { display: block }`
```

### Zustand Stores (Domain-separated)
```ts
// state/instances.ts
interface InstanceState {
  instances: Instance[];
  activeId: string | null;
  create: (data) => Promise<Instance>;
  update: (id, data) => Promise<void>;
  delete: (id) => Promise<void>;
  import: (file) => Promise<Instance[]>;
  export: (id) => Promise<Blob>;
}

// state/mods.ts
interface ModsState {
  searchResults: ModrinthProject[];
  installed: InstalledMod[];
  updates: ModUpdate[];
  search: (query, loader, version) => Promise<void>;
  install: (projectId, versionId) => Promise<void>;
  uninstall: (modId) => Promise<void>;
  checkUpdates: () => Promise<void>;
}

// ... similar for accounts, skins, friends, voice, game, ui, settings
```

### IPC Bridge (Typed)
```ts
// ipc/commands.ts
export const commands = {
  // Accounts
  microsoft_auth_start: () => Promise<{ device_code, user_code, verification_uri, expires_in }>,
  microsoft_auth_poll: () => Promise<Account | null>,
  microsoft_refresh: (accountId) => Promise<void>,
  account_remove: (accountId) => Promise<void>,
  
  // Game
  version_list: () => Promise<VersionManifest[]>,
  version_install: (id, loader?) => Promise<InstallProgress>,
  instance_create: (data) => Promise<Instance>,
  instance_launch: (id) => Promise<LaunchResult>,
  instance_stop: (pid) => Promise<void>,
  game_logs: (pid) => Promise<LogLine[]>,
  
  // Mods
  modrinth_search: (params) => Promise<ModrinthSearchResult>,
  modrinth_install: (projectId, versionId, instanceId) => Promise<void>,
  curseforge_search: (params) => Promise<CurseForgeSearchResult>,
  local_mods_scan: (instanceId) => Promise<InstalledMod[]>,
  mod_resolver_preview: (mods) => Promise<InstallPlan>,
  mod_resolver_apply: (plan, instanceId) => Promise<void>,
  
  // ... ~135 total commands
};
```

### Events (Backend → Frontend)
```ts
// ipc/events.ts
type BackendEvent =
  | { type: 'install_progress'; payload: { task, progress, total } }
  | { type: 'launch_started'; payload: { instanceId, pid } }
  | { type: 'game_log'; payload: { pid, line } }
  | { type: 'game_exit'; payload: { pid, code } }
  | { type: 'mod_update_available'; payload: ModUpdate }
  | { type: 'friend_online'; payload: Friend }
  | { type: 'call_incoming'; payload: CallInfo }
  | { type: 'server_console_line'; payload: { serverId, line } }
  | { type: 'telemetry_event'; payload: TelemetryEvent };
```

---

## 6. Security Architecture

### Secrets Vault (`secrets.rs`)
```rust
// AES-256-GCM + HKDF-SHA256
// Key derivation: HKDF(machine_id + user_sid, salt="hytpotchi-vault")
// Encryption: AES-GCM(nonce, aad=account_id)
// Storage: %APPDATA%/hytpotchi/secrets.bin (0600 equivalent via DPAPI)
```

**Threat Model:**
- Stolen `secrets.bin` → useless without machine-bound key (DPAPI)
- WebView compromise → no token access (only `accountId` exposed)
- Memory dump → tokens only in Rust, zeroized after use

### Path Validation (All External Inputs)
```rust
fn safe_join(base: &Path, user: &str) -> Result<PathBuf> {
    let canonical_base = base.canonicalize()?;
    let joined = canonical_base.join(user);
    let canonical_joined = joined.canonicalize()?;
    if !canonical_joined.starts_with(canonical_base) {
        return Err(Error::Traversal);
    }
    // Block reserved names (CON, PRN, AUX, NUL, COM1-9, LPT1-9)
    // Block control chars, trailing dots/spaces
    Ok(canonical_joined)
}
```

### Tauri Capabilities (Minimal)
```json
// tauri.conf.json
"capabilities": [
  { "identifier": "main", "permissions": [
    "core:event:allow-listen", "core:event:allow-emit",
    "core:window:allow-close", "core:window:allow-minimize",
    "core:window:allow-maximize", "core:window:allow-unmaximize",
    "core:window:allow-set-title", "core:window:allow-set-size",
    "core:updater:allow-check-update", "core:updater:allow-install",
    "core:deep-link:allow-open", "core:clipboard:allow-read-text",
    "core:clipboard:allow-write-text", "core:app:allow-restart"
  ]}
]
// NO: fs, shell, process, dialog, notification, global-shortcut (handled in Rust)
```

### CSP (Strict)
```html
<meta http-equiv="Content-Security-Policy" content="
  default-src 'self';
  script-src 'self' blob:;
  style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob: https:;
  font-src 'self' data:;
  connect-src 'self' https://api.modrinth.com https://api.curseforge.com https://login.microsoftonline.com https://auth.xboxlive.com https://sessionserver.mojang.com https://api.minecraftservices.com https://textures.minecraft.net https://launcher-storage.millida.net;
  frame-src https://www.youtube.com https://www.youtube-nocookie.com https://w.soundcloud.com;
  object-src 'none';
  base-uri 'self';
  form-action 'none';
">
```

### Verified Downloads (All External Files)
| Source | Verification |
|--------|--------------|
| Mojang version manifest | SHA1 from manifest |
| Adoptium JDK | SHA256 from API |
| Modrinth files | SHA1 + SHA512 + size |
| CurseForge files | SHA1 + size (via proxy) |
| Self-update | minisign (ed25519) |
| authlib-injector | SHA256 pinned |

---

## 7. Build & Release Pipeline (Windows)

### CI (`.github/workflows/release.yml`)
```yaml
jobs:
  build:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
      - uses: oven-sh/setup-bun@v1
      - run: bun install
      - run: bun run build
      - run: cargo tauri build --target x86_64-pc-windows-msvc
      - name: Sign binaries
        run: |
          signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 /a target/release/bundle/nsis/*.exe
      - name: Generate minisign signatures
        run: |
          minisign -Sm target/release/hytpotchi.exe -s $MINISIGN_KEY
      - name: Create NSIS installer
        run: cargo tauri build --target x86_64-pc-windows-msvc -- --config tauri.conf.json
      - name: Upload artifacts
        uses: actions/upload-artifact@v4
        with:
          name: installer
          path: target/release/bundle/nsis/*.exe
      - name: Attest build
        uses: actions/attest-build-provenance@v1
```

### Code Signing
- **Cert**: Certum Code Signing (or DigiCert) — EV cert for SmartScreen reputation
- **Storage**: Azure Key Vault / GitHub Secrets (PFX + password)
- **Timestamp**: DigiCert / Sectigo RFC3161

### minisign (Self-Update Verification)
```bash
# Generate keypair (once)
minisign -G -p minisign.pub -s minisign.sec

# Embed public key in Rust binary
# build.rs: println!("cargo:rustc-env=MINISIGN_PUBKEY={}", std::fs::read_to_string("minisign.pub")?);

# Sign release
minisign -Sm hytpotchi.exe -s minisign.sec
minisign -Sm hytpotchi_1.0.0_delta.zst -s minisign.sec
```

### Delta Updates (Windows Only)
```
Current: hytpotchi_1.0.0.exe (50 MB)
New:     hytpotchi_1.0.1.exe (52 MB)
Delta:   hytpotchi_1.0.0_1.0.1.zst (3 MB)  # zstd --patch-from=old.exe new.exe
```
Verified by minisign before apply.

---

## 8. Timeline Summary

| Phase | Weeks | Cumulative | Milestone |
|-------|-------|------------|-----------|
| 0: Foundation | 1 | 1 | App shell, IPC, vault |
| 1: Microsoft Auth | 1 | 2 | **Sign-in working** |
| 2: Game Launch | 3 | 5 | **Launch Vanilla/Forge/Fabric** |
| 3: Mod Management | 2 | 7 | **Mod browser, deps, .mrpack** |
| 4: Profiles/Import | 1 | 8 | **Instance mgmt, migration** |
| 5: Skins/Cosmetics | 1 | 9 | **Skin lib, CustomSkinLoader, 3D** |
| 6: Social/Voice | 3 | 12 | Friends, calls, screen share |
| 7: Server Panel | 1 | 13 | Console, files, worlds |
| 8: Worlds | 1 | 14 | Backup, gallery |
| 9: Cloud/Polish | 1 | 15 | Sync, self-update, overlay, RPC |
| 10: Build/Release | 1 | 16 | **Signed installer, auto-update** |

**Total: ~16 weeks solo**  
**MVP (Phases 0-4): ~8 weeks** — launchable with core features

---

## 9. Risks & Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Microsoft Azure AD policy changes | Medium | High | Abstract auth behind interface; support offline mode |
| CurseForge API rate limits / key leak | High | Medium | Backend proxy (hide key), aggressive caching, fallback to Modrinth |
| WebRTC mesh complexity (NAT, Firefox/Chrome diffs) | High | High | Use `webrtc` crate + `centrifuge`; defer to v1.1 if needed |
| Windows Graphics Capture API instability | Medium | Medium | Graceful fallback (no Rewind), feature flag |
| Code signing cert procurement delay | Medium | High | Start cert process Week 1; use self-signed for dev |
| Tauri 2 / WebView2 breaking changes | Low | High | Pin versions, test on Windows 10/11, CI matrix |
| Mod dependency resolver edge cases | High | Medium | Snapshot tests against 20+ real modpacks |
| Self-update failure (corrupt delta) | Low | High | Atomic replace, rollback on verify fail, self-heal |
| Legal: Mojang/Microsoft trademark | Low | Critical | GPL-3.0, clear "not affiliated", own branding (TRADEMARK.md) |
| Team burnout (scope creep) | High | High | Phase gates, defer non-core to v1.1, weekly retro |

---

## 10. Immediate Next Steps (Week 1)

1. **Day 1**: Azure AD App Registration → get `client_id`
2. **Day 1**: `cargo tauri init` + `bun create react` → merge into Tauri 2 structure
3. **Day 2**: Implement `secrets.rs` (DPAPI vault) + `paths.rs` (safe_join)
4. **Day 3**: IPC bridge + `commands.ts` skeleton + screen router
5. **Day 4**: CSS architecture (01-base → 05-media) + Zustand stores
6. **Day 5**: Microsoft device flow Rust implementation (`microsoft.rs`)
7. **Day 6-7**: Frontend Accounts screen + sign-in flow + token storage

**Ready to start Phase 0?** I'll scaffold the Tauri 2 + React 19 project structure with all config files.