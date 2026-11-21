//! Туннель «играть вместе без модов».
//!
//! Хозяин: в игре «Открыть для сети» → лаунчер держит управляющий WebSocket с сервером
//! Hytpotchi. Когда друг подключается, сервер присылает {"t":"open","c":id}, и лаунчер
//! открывает отдельный WebSocket для этого соединения и соединяет его с локальным миром
//! (127.0.0.1:<порт LAN>).
//!
//! Гость: лаунчер слушает 127.0.0.1:<случайный порт>, а игра запускается с этим адресом.
//! Каждое соединение игры идёт к хозяину первым рабочим путём:
//!   1. напрямую на его роутер (проброс UPnP, см. direct.rs) — трафик не уходит за границу;
//!   2. напрямую между лаунчерами с пробитием NAT (см. punch.rs) — без сервера и настроек;
//!   3. через релей Hytpotchi в России (если он настроен на сервере);
//!   4. через туннель на Cloudflare (у части провайдеров без VPN «замерзает»).
//! Хозяин держит control сразу на всех релеях, чтобы гость мог прийти любым путём.

use std::net::SocketAddrV4;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use anyhow::{Context, Result};
use futures::{SinkExt, StreamExt};
use parking_lot::Mutex;
use serde::Deserialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>;

/// Пропуск гостя в мир друга (ответ хаба на join)
#[derive(Debug, Clone)]
pub struct JoinPass {
    /// Билет для туннеля на сервере Hytpotchi (Cloudflare)
    pub ticket: String,
    /// Мир хозяина напрямую из интернета (проброс UPnP)
    pub direct: Option<SocketAddrV4>,
    /// Релей в России: (адрес ws(s)://…, пропуск)
    pub via: Option<(String, String)>,
}

impl JoinPass {
    pub fn from_reply(r: &serde_json::Value) -> Result<Self> {
        let ticket = r["ticket"].as_str().context("Сервер не выдал билет")?.to_string();
        let direct = r["direct"].as_str().and_then(super::direct::parse_public);
        let via = match (r["via"]["url"].as_str(), r["via"]["ticket"].as_str()) {
            (Some(url), Some(t)) if url.starts_with("ws://") || url.starts_with("wss://") => {
                Some((url.to_string(), t.to_string()))
            }
            _ => None,
        };
        Ok(Self { ticket, direct, via })
    }
}

/// Откуда берётся свежий пропуск для очередного соединения гостя
pub type TicketSource = Arc<dyn Fn() -> futures::future::BoxFuture<'static, Result<JoinPass>> + Send + Sync>;

/// Установить прямое соединение с хозяином (пробитие NAT)
pub type PunchSource =
    Arc<dyn Fn() -> futures::future::BoxFuture<'static, Result<super::punch::Session>> + Send + Sync>;

/// Прямое соединение гостя с хозяином: одно на все соединения игры; не вышло — больше не пробуем
#[derive(Default)]
struct PunchState {
    session: Option<Arc<super::punch::Session>>,
    failed: bool,
}

/// Сколько всего ждать установки прямого соединения
const PUNCH_TIMEOUT: Duration = Duration::from_secs(25);

/// Сколько ждать прямого подключения к хозяину, прежде чем идти через релей
const DIRECT_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Default)]
pub struct Tunnels {
    host: Mutex<Option<HostTunnel>>,
    /// Входы в миры друзей: hostId → локальный порт (для «Присоединиться» и списка серверов)
    guests: Mutex<std::collections::HashMap<String, GuestTunnel>>,
}

struct HostTunnel {
    host_id: String,
    port: u16,
    /// Релеи, на которых держим мир (адреса серверов)
    servers: Vec<String>,
    tasks: Vec<JoinHandle<()>>,
}

struct GuestTunnel {
    port: u16,
    task: JoinHandle<()>,
}

impl Drop for HostTunnel {
    fn drop(&mut self) {
        for t in &self.tasks {
            t.abort();
        }
    }
}

impl Drop for GuestTunnel {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn ws_url(server: &str, host_id: &str, kind: &str) -> String {
    let base = server.replacen("https://", "wss://", 1).replacen("http://", "ws://", 1);
    format!("{base}/api/tunnel/{host_id}/{kind}")
}

async fn connect(url: &str, credential: &str) -> Result<Ws> {
    let mut req = url.into_client_request()?;
    req.headers_mut()
        .insert("authorization", HeaderValue::from_str(&format!("Bearer {credential}"))?);
    let (ws, _) = tokio::time::timeout(Duration::from_secs(15), tokio_tungstenite::connect_async(req))
        .await
        .context("Сервер Hytpotchi не ответил")?
        .context("Не удалось подключиться к туннелю")?;
    Ok(ws)
}

/// Байты туда-обратно между игрой (TCP) и туннелем (WebSocket), пока одна сторона не закроется
async fn pipe(ws: Ws, tcp: TcpStream) {
    let _ = tcp.set_nodelay(true);
    let (mut ws_tx, mut ws_rx) = ws.split();
    let (mut tcp_rx, mut tcp_tx) = tcp.into_split();
    let up = async {
        let mut buf = vec![0u8; 32 * 1024];
        loop {
            let n = match tcp_rx.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            if ws_tx.send(Message::Binary(buf[..n].to_vec().into())).await.is_err() {
                break;
            }
        }
        let _ = ws_tx.close().await;
    };
    let down = async {
        while let Some(Ok(msg)) = ws_rx.next().await {
            match msg {
                Message::Binary(b) => {
                    if tcp_tx.write_all(&b).await.is_err() {
                        break;
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
        let _ = tcp_tx.shutdown().await;
    };
    tokio::select! {
        _ = up => {}
        _ = down => {}
    }
}

/// Живое прямое соединение с хозяином: имеющееся или новое (если ещё не пробовали неудачно)
async fn punched(
    punch: &PunchSource,
    state: &tokio::sync::Mutex<PunchState>,
) -> Option<Arc<super::punch::Session>> {
    let mut st = state.lock().await;
    if let Some(s) = st.session.as_ref().filter(|s| s.alive()) {
        return Some(s.clone());
    }
    if st.failed {
        return None;
    }
    match tokio::time::timeout(PUNCH_TIMEOUT, punch()).await {
        Ok(Ok(session)) => {
            log::info!("Туннель гостя: прямое соединение с другом установлено (без сервера)");
            let session = Arc::new(session);
            st.session = Some(session.clone());
            Some(session)
        }
        Ok(Err(e)) => {
            log::info!("Туннель гостя: прямое соединение не вышло ({e:#}) — через сервер");
            st.failed = true;
            None
        }
        Err(_) => {
            log::info!("Туннель гостя: прямое соединение не установилось вовремя — через сервер");
            st.failed = true;
            None
        }
    }
}

/// Одно соединение игры гостя: напрямую → релей в России → Cloudflare
async fn guest_connection(
    tcp: TcpStream,
    server: &str,
    host_id: &str,
    pass: JoinPass,
    skip_direct: &AtomicBool,
    skip_via: &AtomicBool,
) {
    if let Some(addr) = pass.direct.filter(|_| !skip_direct.load(Ordering::Relaxed)) {
        match tokio::time::timeout(DIRECT_TIMEOUT, TcpStream::connect(addr)).await {
            Ok(Ok(mut remote)) => {
                log::info!("Туннель гостя: в мир друга напрямую ({addr})");
                let mut tcp = tcp;
                let _ = tcp.set_nodelay(true);
                let _ = remote.set_nodelay(true);
                let _ = tokio::io::copy_bidirectional(&mut tcp, &mut remote).await;
                return;
            }
            Ok(Err(e)) => log::info!("Туннель гостя: напрямую не вышло ({e}) — через релей"),
            Err(_) => log::info!("Туннель гостя: напрямую не отвечает — через релей"),
        }
        skip_direct.store(true, Ordering::Relaxed);
    }
    if let Some((relay, ticket)) = pass.via.as_ref().filter(|_| !skip_via.load(Ordering::Relaxed)) {
        match connect(&ws_url(relay, host_id, "join"), ticket).await {
            Ok(ws) => {
                log::info!("Туннель гостя: через релей Hytpotchi");
                pipe(ws, tcp).await;
                return;
            }
            Err(e) => {
                log::warn!("Туннель гостя: релей недоступен ({e:#}) — через сервер Hytpotchi");
                skip_via.store(true, Ordering::Relaxed);
            }
        }
    }
    match connect(&ws_url(server, host_id, "join"), &pass.ticket).await {
        Ok(ws) => pipe(ws, tcp).await,
        Err(e) => log::warn!("Туннель гостя: {e:#}"),
    }
}

#[derive(Deserialize)]
struct ControlMsg {
    t: String,
    c: String,
}

/// Управляющее соединение хозяина: держим, переподключаемся, открываем соединения для друзей
async fn host_loop(server: String, host_id: String, secret: String, port: u16) {
    let mut backoff = 1u64;
    loop {
        match connect(&ws_url(&server, &host_id, "control"), &secret).await {
            Ok(ws) => {
                backoff = 1;
                log::info!("Туннель: мир открыт для друзей (порт {port})");
                let (mut tx, mut rx) = ws.split();
                let mut ping = tokio::time::interval(Duration::from_secs(25));
                loop {
                    tokio::select! {
                        _ = ping.tick() => {
                            if tx.send(Message::Text("ping".into())).await.is_err() { break; }
                        }
                        msg = rx.next() => {
                            let Some(Ok(msg)) = msg else { break };
                            let Message::Text(text) = msg else { continue };
                            let Ok(ctl) = serde_json::from_str::<ControlMsg>(&text) else { continue };
                            if ctl.t != "open" { continue; }
                            let (server, host_id, secret) = (server.clone(), host_id.clone(), secret.clone());
                            tokio::spawn(async move {
                                let url = format!("{}?c={}", ws_url(&server, &host_id, "data"), ctl.c);
                                let ws = match connect(&url, &secret).await {
                                    Ok(ws) => ws,
                                    Err(e) => {
                                        log::warn!("Туннель: соединение {} не открылось: {e:#}", ctl.c);
                                        return;
                                    }
                                };
                                match TcpStream::connect(("127.0.0.1", port)).await {
                                    Ok(tcp) => {
                                        log::info!("Туннель: друг подключился (соединение {})", ctl.c);
                                        pipe(ws, tcp).await;
                                    }
                                    Err(e) => {
                                        // Мир уже закрыт: закрываем data — сервер тут же отключит гостя
                                        log::warn!("Туннель: мир на порту {port} не отвечает: {e}");
                                        let mut ws = ws;
                                        let _ = ws.close(None).await;
                                    }
                                }
                            });
                        }
                    }
                }
                log::info!("Туннель: управляющее соединение закрыто, переподключаемся");
            }
            Err(e) => {
                // 403 — мир закрыт на сервере (секрет больше не действует): дальше пытаться незачем
                if format!("{e:#}").contains("403") {
                    log::info!("Туннель хозяина закрыт сервером");
                    return;
                }
                log::warn!("Туннель: {e:#}");
            }
        }
        tokio::time::sleep(Duration::from_secs(backoff)).await;
        backoff = (backoff * 2).min(30);
    }
}

impl Tunnels {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Держать мир открытым для друзей на релеях `routes` — (адрес сервера, ключ хозяина).
    /// Повторный вызов с теми же данными ничего не делает; упавшие соединения перезапускает.
    pub fn ensure_host(&self, routes: &[(String, String)], host_id: &str, port: u16) {
        let mut host = self.host.lock();
        let servers: Vec<String> = routes.iter().map(|(s, _)| s.clone()).collect();
        if host.as_ref().is_some_and(|h| {
            h.host_id == host_id && h.port == port && h.servers == servers && h.tasks.iter().all(|t| !t.is_finished())
        }) {
            return;
        }
        let tasks = routes
            .iter()
            .map(|(server, cred)| tokio::spawn(host_loop(server.clone(), host_id.to_string(), cred.clone(), port)))
            .collect();
        *host = Some(HostTunnel { host_id: host_id.to_string(), port, servers, tasks });
    }

    pub fn stop_host(&self) {
        if self.host.lock().take().is_some() {
            log::info!("Туннель: мир закрыт для друзей");
        }
    }

    /// Подготовить вход в мир друга. Возвращает локальный адрес для игры.
    pub async fn start_guest(
        &self,
        server: &str,
        host_id: &str,
        tickets: TicketSource,
        punch: Option<PunchSource>,
    ) -> Result<String> {
        if let Some(g) = self.guests.lock().get(host_id) {
            if !g.task.is_finished() {
                return Ok(format!("127.0.0.1:{}", g.port));
            }
        }
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.context("Не удалось открыть локальный порт")?;
        let port = listener.local_addr()?.port();
        let (server, host_id_owned) = (server.to_string(), host_id.to_string());
        // Путь, который не сработал, дальше в этой сессии не пробуем — чтобы не ждать его каждый раз
        let skip_direct = Arc::new(AtomicBool::new(false));
        let skip_via = Arc::new(AtomicBool::new(false));
        let punch_state = Arc::new(tokio::sync::Mutex::new(PunchState::default()));
        let task = tokio::spawn(async move {
            loop {
                let Ok((tcp, _)) = listener.accept().await else { break };
                let (server, host_id, tickets) = (server.clone(), host_id_owned.clone(), tickets.clone());
                let (skip_direct, skip_via) = (skip_direct.clone(), skip_via.clone());
                let (punch, punch_state) = (punch.clone(), punch_state.clone());
                tokio::spawn(async move {
                    // Прямое соединение лаунчеров: если есть или удалось установить — игра идёт по нему
                    let tcp = match punch {
                        Some(punch) => match punched(&punch, &punch_state).await {
                            Some(session) => match session.carry(tcp).await {
                                Ok(()) => return,
                                Err(e) => {
                                    log::warn!("Прямое соединение оборвалось: {e:#}");
                                    return;
                                }
                            },
                            None => tcp,
                        },
                        None => tcp,
                    };
                    // Свежий пропуск на каждое соединение: игра переподключается и после пары минут в мире
                    let pass = match tickets().await {
                        Ok(p) => p,
                        Err(e) => {
                            log::warn!("Туннель гостя: {e:#}");
                            return;
                        }
                    };
                    guest_connection(tcp, &server, &host_id, pass, &skip_direct, &skip_via).await;
                });
            }
        });
        self.guests
            .lock()
            .insert(host_id.to_string(), GuestTunnel { port, task });
        Ok(format!("127.0.0.1:{port}"))
    }

    /// Закрыть все входы в миры друзей
    pub fn stop_guest(&self) {
        self.guests.lock().clear();
    }

    /// Закрыть входы в миры, которых больше нет (друг закрыл мир)
    pub fn keep_guests(&self, alive: &std::collections::HashSet<String>) {
        self.guests.lock().retain(|id, _| alive.contains(id));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls() {
        assert_eq!(
            ws_url("https://srv.example.dev", "abc", "join"),
            "wss://srv.example.dev/api/tunnel/abc/join"
        );
        assert_eq!(ws_url("http://localhost:8787", "abc", "control"), "ws://localhost:8787/api/tunnel/abc/control");
    }

    /// Труба честно гоняет байты: TCP ⇄ WebSocket через локальный «сервер-эхо»
    #[tokio::test]
    async fn pipe_roundtrip() {
        // WebSocket-эхо
        let ws_listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let ws_port = ws_listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (s, _) = ws_listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(s).await.unwrap();
            while let Some(Ok(m)) = ws.next().await {
                if let Message::Binary(b) = m {
                    let mut v = b.to_vec();
                    v.reverse();
                    ws.send(Message::Binary(v.into())).await.unwrap();
                }
            }
        });
        // «Игра» подключается к локальному порту, лаунчер ведёт её в WebSocket
        let game_listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let game_port = game_listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (tcp, _) = game_listener.accept().await.unwrap();
            let ws = connect(&format!("ws://127.0.0.1:{ws_port}/"), "test-token").await.unwrap();
            pipe(ws, tcp).await;
        });
        let mut game = TcpStream::connect(("127.0.0.1", game_port)).await.unwrap();
        game.write_all(&[1, 2, 3]).await.unwrap();
        let mut got = [0u8; 3];
        tokio::time::timeout(Duration::from_secs(5), game.read_exact(&mut got)).await.unwrap().unwrap();
        assert_eq!(got, [3, 2, 1]);
    }
}

#[cfg(test)]
mod route_tests {
    use super::*;

    /// «Мир хозяина»: TCP-эхо
    async fn tcp_echo() -> u16 {
        let l = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = l.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut s, _)) = l.accept().await {
                tokio::spawn(async move {
                    let (mut r, mut w) = s.split();
                    let _ = tokio::io::copy(&mut r, &mut w).await;
                });
            }
        });
        port
    }

    /// «Релей»: WebSocket-эхо; считает подключения
    async fn ws_echo(hits: Arc<std::sync::atomic::AtomicUsize>) -> u16 {
        let l = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = l.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((s, _)) = l.accept().await {
                hits.fetch_add(1, Ordering::Relaxed);
                tokio::spawn(async move {
                    let mut ws = tokio_tungstenite::accept_async(s).await.unwrap();
                    while let Some(Ok(m)) = ws.next().await {
                        if m.is_binary() && ws.send(m).await.is_err() {
                            break;
                        }
                    }
                });
            }
        });
        port
    }

    async fn roundtrip(addr: &str) {
        let mut game = TcpStream::connect(addr).await.unwrap();
        game.write_all(b"hello").await.unwrap();
        let mut got = [0u8; 5];
        tokio::time::timeout(Duration::from_secs(10), game.read_exact(&mut got)).await.unwrap().unwrap();
        assert_eq!(&got, b"hello");
    }

    #[test]
    fn pass_from_reply() {
        let p = JoinPass::from_reply(&serde_json::json!({
            "hostId": "a", "ticket": "t", "direct": "93.184.216.34:25565",
            "via": { "url": "wss://relay.example", "ticket": "v" }
        }))
        .unwrap();
        assert_eq!(p.direct, Some("93.184.216.34:25565".parse().unwrap()));
        assert_eq!(p.via, Some(("wss://relay.example".into(), "v".into())));
        // Локальный адрес, неизвестная схема, старый сервер без новых полей — просто без них
        let p = JoinPass::from_reply(&serde_json::json!({
            "ticket": "t", "direct": "192.168.0.2:25565", "via": { "url": "http://x", "ticket": "v" }
        }))
        .unwrap();
        assert_eq!((p.direct, p.via), (None, None));
        assert!(JoinPass::from_reply(&serde_json::json!({ "hostId": "a" })).is_err());
    }

    /// Прямой путь работает — релей не трогаем; прямой недоступен — релей, и прямой больше не ждём
    #[tokio::test]
    async fn guest_prefers_direct_then_relay() {
        let world = tcp_echo().await;
        let hits = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let relay = ws_echo(hits.clone()).await;
        let dead = TcpListener::bind(("127.0.0.1", 0)).await.unwrap().local_addr().unwrap().port();

        let pass = |direct: u16| JoinPass {
            ticket: "cf".into(),
            direct: Some(SocketAddrV4::new(std::net::Ipv4Addr::LOCALHOST, direct)),
            via: Some((format!("ws://127.0.0.1:{relay}"), "relay-pass".into())),
        };

        let direct_ok = Tunnels::new();
        let p = pass(world);
        let addr = direct_ok
            .start_guest("ws://127.0.0.1:1", &"a".repeat(24), Arc::new(move || Box::pin(std::future::ready(Ok(p.clone())))), None)
            .await
            .unwrap();
        roundtrip(&addr).await;
        assert_eq!(hits.load(Ordering::Relaxed), 0);

        let direct_dead = Tunnels::new();
        let p = pass(dead);
        let addr = direct_dead
            .start_guest("ws://127.0.0.1:1", &"b".repeat(24), Arc::new(move || Box::pin(std::future::ready(Ok(p.clone())))), None)
            .await
            .unwrap();
        roundtrip(&addr).await;
        roundtrip(&addr).await;
        assert_eq!(hits.load(Ordering::Relaxed), 2);
    }
}

#[cfg(test)]
mod live_tests {
    use super::*;
    use serde_json::{Value, json};

    const S: &str = "https://hytpotchi-skins.akiom31.workers.dev";

    async fn post(c: &reqwest::Client, path: &str, body: Value, token: Option<&str>) -> Value {
        let mut r = c.post(format!("{S}{path}")).json(&body);
        if let Some(t) = token {
            r = r.bearer_auth(t);
        }
        r.send().await.unwrap().json().await.unwrap()
    }

    /// Живой сквозной тест: хозяин (ensure_host) ↔ сервер ↔ гость (start_guest), 300 КБ туда-обратно.
    /// cargo test --lib tunnel_end_to_end_live -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn tunnel_end_to_end_live() {
        let c = reqwest::Client::builder().no_proxy().build().unwrap();
        let sfx: u32 = rand_suffix();
        let pw = "probe-password-1";
        let h = post(&c, "/api/account/register", json!({"nick": format!("E2eH_{sfx}"), "password": pw}), None).await;
        let g = post(&c, "/api/account/register", json!({"nick": format!("E2eG_{sfx}"), "password": pw}), None).await;
        let (ht, gt) = (h["token"].as_str().unwrap().to_string(), g["token"].as_str().unwrap().to_string());
        post(&c, "/api/friends/request", json!({"nick": format!("E2eG_{sfx}")}), Some(&ht)).await;
        let gs = post(&c, "/api/friends/sync", json!({}), Some(&gt)).await;
        post(&c, "/api/friends/respond", json!({"id": gs["requests"][0]["id"], "accept": true}), Some(&gt)).await;

        // «Мир Minecraft» хозяина: эхо с переворотом байтов
        let world = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let world_port = world.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut s, _) = world.accept().await.unwrap();
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                let n = s.read(&mut buf).await.unwrap();
                if n == 0 {
                    break;
                }
                s.write_all(&buf[..n]).await.unwrap();
            }
        });

        let hs = post(&c, "/api/friends/sync", json!({"host": {"relay": true, "world": "E2E", "mc": "1.21.4", "loader": null}}), Some(&ht)).await;
        let relay = &hs["me"]["relay"];
        let host_side = Tunnels::new();
        host_side.ensure_host(
            &[(S.to_string(), relay["secret"].as_str().unwrap().to_string())],
            relay["hostId"].as_str().unwrap(),
            world_port,
        );
        tokio::time::sleep(Duration::from_secs(2)).await;

        let host_user = hs["me"]["id"].as_str().unwrap().to_string();
        let (c2, gt2) = (c.clone(), gt.clone());
        let tickets: TicketSource = Arc::new(move || {
            let (c, gt, id) = (c2.clone(), gt2.clone(), host_user.clone());
            Box::pin(async move {
                let r = post(&c, "/api/friends/join", json!({"id": id}), Some(&gt)).await;
                JoinPass::from_reply(&r)
            })
        });
        let guest_side = Tunnels::new();
        let addr = guest_side.start_guest(S, relay["hostId"].as_str().unwrap(), tickets, None).await.unwrap();

        // «Игра» гостя подключается к локальному адресу
        let mut game = TcpStream::connect(addr.as_str()).await.unwrap();
        let payload: Vec<u8> = (0..300 * 1024).map(|i| (i % 251) as u8).collect();
        let t0 = std::time::Instant::now();
        let (mut rd, mut wr) = game.split();
        let send = async { wr.write_all(&payload).await.unwrap() };
        let recv = async {
            let mut got = vec![0u8; payload.len()];
            tokio::time::timeout(Duration::from_secs(30), rd.read_exact(&mut got)).await.unwrap().unwrap();
            got
        };
        let ((), got) = tokio::join!(send, recv);
        assert_eq!(got, payload);
        println!("300 КБ туда и обратно через туннель: {} мс", t0.elapsed().as_millis());

        post(&c, "/api/friends/sync", json!({"host": null}), Some(&ht)).await;
        post(&c, "/api/friends/offline", json!({}), Some(&ht)).await;
        post(&c, "/api/friends/offline", json!({}), Some(&gt)).await;
    }

    fn rand_suffix() -> u32 {
        let mut b = [0u8; 4];
        getrandom::getrandom(&mut b).unwrap();
        u32::from_le_bytes(b) % 100_000
    }
}
