//! Прямое соединение лаунчеров без сервера и без настройки роутера («пробитие NAT»).
//!
//! У части провайдеров соединения к Cloudflare без VPN «замерзают», а короткие запросы проходят.
//! Поэтому через сервер Hytpotchi лаунчеры только обмениваются адресами, а игра идёт напрямую:
//!   1. Гость открывает UDP-сокет, узнаёт свой внешний адрес у STUN и шлёт его хозяину через хаб.
//!   2. Хозяин (опрашивает хаб, пока мир открыт) делает то же самое, шлёт гостю пару UDP-пакетов —
//!      это открывает его NAT для гостя — и отвечает своим адресом и отпечатком сертификата.
//!   3. Гость шлёт пакеты хозяину и подключается по QUIC. Сертификат хозяина проверяется по отпечатку.
//!   4. Каждое соединение игры — отдельный поток QUIC; первые 32 байта — ключ от хаба.
//!
//! Не сработает, если NAT у обоих «симметричный» (меняет порт для каждого адресата) — тогда
//! остаются релей и туннель через Cloudflare.

use std::collections::HashSet;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use quinn::crypto::rustls::{QuicClientConfig, QuicServerConfig};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use tokio::net::{TcpStream, UdpSocket};
use tokio::task::JoinHandle;

use crate::engine::accounts::hytpotchi;
use crate::engine::core::http::HttpClient;

/// STUN-серверы, которые отвечают из России без VPN (Google — нет)
const STUN_SERVERS: &[&str] = &["stun.cloudflare.com:3478", "stun.nextcloud.com:3478", "stun.sipnet.ru:3478"];
const STUN_TIMEOUT: Duration = Duration::from_millis(1500);
const ALPN: &[u8] = b"hytpotchi/1";
const SERVER_NAME: &str = "hytpotchi";
const PUNCH_PACKET: &[u8] = b"hytpotchi-punch";
/// Опрос хаба хозяином, пока мир открыт
const POLL_EVERY: Duration = Duration::from_secs(2);
/// Сколько гость ждёт ответа хозяина
const ANSWER_WAIT: Duration = Duration::from_secs(15);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
const KEY_LEN: usize = 32;

// ---------- STUN ----------

/// Внешний адрес сокета по ответу одного STUN-сервера (RFC 5389, Binding Request)
async fn stun_one(sock: &UdpSocket, server: SocketAddr) -> Result<SocketAddrV4> {
    let mut tid = [0u8; 12];
    getrandom::getrandom(&mut tid)?;
    let mut req = Vec::with_capacity(20);
    req.extend_from_slice(&[0x00, 0x01, 0x00, 0x00, 0x21, 0x12, 0xA4, 0x42]);
    req.extend_from_slice(&tid);
    sock.send_to(&req, server).await?;
    let mut buf = [0u8; 1024];
    let deadline = tokio::time::Instant::now() + STUN_TIMEOUT;
    loop {
        let (n, from) = tokio::time::timeout_at(deadline, sock.recv_from(&mut buf)).await.context("STUN не ответил")??;
        if from != server || n < 20 || buf[8..20] != tid {
            continue;
        }
        return parse_stun(&buf[..n]).context("STUN ответил без адреса");
    }
}

fn parse_stun(msg: &[u8]) -> Option<SocketAddrV4> {
    let mut i = 20;
    let mut plain = None;
    while i + 4 <= msg.len() {
        let t = u16::from_be_bytes([msg[i], msg[i + 1]]);
        let l = u16::from_be_bytes([msg[i + 2], msg[i + 3]]) as usize;
        let v = msg.get(i + 4..i + 4 + l)?;
        if v.len() >= 8 && v[1] == 0x01 {
            let port = u16::from_be_bytes([v[2], v[3]]);
            let ip = Ipv4Addr::new(v[4], v[5], v[6], v[7]);
            match t {
                // XOR-MAPPED-ADDRESS
                0x0020 => {
                    let ip = Ipv4Addr::from(u32::from(ip) ^ 0x2112_A442);
                    return Some(SocketAddrV4::new(ip, port ^ 0x2112));
                }
                0x0001 => plain = Some(SocketAddrV4::new(ip, port)),
                _ => {}
            }
        }
        i += 4 + l + (4 - l % 4) % 4;
    }
    plain
}

/// Внешний адрес сокета. Спрашиваем два сервера: если порты разные — NAT симметричный,
/// пробить его нельзя, и пытаться незачем.
pub async fn public_addr(sock: &UdpSocket) -> Result<SocketAddrV4> {
    let mut seen: Vec<SocketAddrV4> = Vec::new();
    for host in STUN_SERVERS {
        let Ok(Some(server)) = tokio::net::lookup_host(host).await.map(|mut a| a.find(SocketAddr::is_ipv4)) else {
            continue;
        };
        if let Ok(addr) = stun_one(sock, server).await {
            seen.push(addr);
            if seen.len() == 2 {
                break;
            }
        }
    }
    match seen.as_slice() {
        [] => bail!("STUN недоступен"),
        [a, b] if a != b => bail!("NAT меняет порт для каждого адресата ({a} / {b}) — напрямую не соединиться"),
        [a, ..] if !super::direct::is_public(*a.ip()) => bail!("STUN вернул локальный адрес {a}"),
        [a, ..] => Ok(*a),
    }
}

/// Адрес из ответа хаба: только публичный IPv4
fn parse_peer(addr: &str) -> Result<SocketAddrV4> {
    let a: SocketAddrV4 = addr.parse().context("Некорректный адрес друга")?;
    if !super::direct::is_public(*a.ip()) {
        bail!("Некорректный адрес друга");
    }
    Ok(a)
}

/// UDP-сокет на настоящей сетевой карте: при включённом VPN (TUN) иначе внешним адресом
/// оказался бы адрес VPN-сервера, а он пакеты от друга не пропускает
async fn bind() -> Result<UdpSocket> {
    if let Some(ip) = crate::engine::core::netif::lan_ipv4() {
        if let Ok(sock) = UdpSocket::bind((ip, 0)).await {
            return Ok(sock);
        }
    }
    Ok(UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).await?)
}

/// Открыть свой NAT для собеседника: пара пакетов на его внешний адрес (для тестов)
#[cfg(test)]
async fn knock(sock: &UdpSocket, peer: SocketAddr) {
    for _ in 0..3 {
        let _ = sock.send_to(PUNCH_PACKET, peer).await;
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
}

/// Стучаться к собеседнику, пока соединение не установится. Роутеры двух сторон «открываются»
/// в разное время (друг узнаёт адрес позже), и одной пачки пакетов в начале часто мало:
/// первые пакеты чужой роутер отбрасывает. Пакеты идут с того же порта, что и QUIC
/// (через копию сокета), поэтому держат открытым именно его.
struct Knocker {
    stop: Arc<std::sync::atomic::AtomicBool>,
}

const KNOCK_EVERY: Duration = Duration::from_millis(150);

impl Knocker {
    fn start(sock: &std::net::UdpSocket, peer: SocketAddr, for_: Duration) -> Result<Self> {
        let copy = sock.try_clone()?;
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = stop.clone();
        std::thread::Builder::new().name("hytpotchi-knock".into()).spawn(move || {
            let end = std::time::Instant::now() + for_;
            while !flag.load(std::sync::atomic::Ordering::Relaxed) && std::time::Instant::now() < end {
                let _ = copy.send_to(PUNCH_PACKET, peer);
                std::thread::sleep(KNOCK_EVERY);
            }
        })?;
        Ok(Self { stop })
    }
}

impl Drop for Knocker {
    fn drop(&mut self) {
        self.stop.store(true, std::sync::atomic::Ordering::Relaxed);
    }
}

// ---------- QUIC ----------

fn provider() -> Arc<rustls::crypto::CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

fn transport() -> Arc<quinn::TransportConfig> {
    let mut t = quinn::TransportConfig::default();
    // Пакеты каждые 5 с держат NAT открытым; без ответа 30 с — соединение потеряно
    t.keep_alive_interval(Some(Duration::from_secs(5)));
    t.max_idle_timeout(Some(Duration::from_secs(30).try_into().expect("30 с")));
    Arc::new(t)
}

fn sha256_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

/// QUIC-сервер хозяина на уже «пробитом» сокете. Возвращает endpoint и отпечаток сертификата.
fn server_endpoint(sock: std::net::UdpSocket) -> Result<(quinn::Endpoint, String)> {
    let generated = rcgen::generate_simple_self_signed(vec![SERVER_NAME.to_string()])?;
    let cert = generated.cert.der().clone();
    let fingerprint = sha256_hex(&cert);
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(generated.signing_key.serialize_der()));
    let mut tls = rustls::ServerConfig::builder_with_provider(provider())
        .with_protocol_versions(&[&rustls::version::TLS13])?
        .with_no_client_auth()
        .with_single_cert(vec![cert], key)?;
    tls.alpn_protocols = vec![ALPN.to_vec()];
    let mut config = quinn::ServerConfig::with_crypto(Arc::new(QuicServerConfig::try_from(tls)?));
    config.transport_config(transport());
    let endpoint = quinn::Endpoint::new(
        quinn::EndpointConfig::default(),
        Some(config),
        sock,
        Arc::new(quinn::TokioRuntime),
    )?;
    Ok((endpoint, fingerprint))
}

/// Сертификат хозяина самоподписанный — проверяем его отпечаток, полученный через хаб
#[derive(Debug)]
struct PinnedCert {
    fingerprint: String,
    provider: Arc<rustls::crypto::CryptoProvider>,
}

impl ServerCertVerifier for PinnedCert {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        if sha256_hex(end_entity) == self.fingerprint {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(rustls::Error::General("сертификат хозяина не совпадает".into()))
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider.signature_verification_algorithms.supported_schemes()
    }
}

fn client_endpoint(sock: std::net::UdpSocket, fingerprint: &str) -> Result<quinn::Endpoint> {
    let provider = provider();
    let mut tls = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_protocol_versions(&[&rustls::version::TLS13])?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(PinnedCert { fingerprint: fingerprint.to_string(), provider }))
        .with_no_client_auth();
    tls.alpn_protocols = vec![ALPN.to_vec()];
    let mut config = quinn::ClientConfig::new(Arc::new(QuicClientConfig::try_from(tls)?));
    config.transport_config(transport());
    let mut endpoint =
        quinn::Endpoint::new(quinn::EndpointConfig::default(), None, sock, Arc::new(quinn::TokioRuntime))?;
    endpoint.set_default_client_config(config);
    Ok(endpoint)
}

/// Байты туда-обратно между игрой (TCP) и потоком QUIC
async fn pipe(tcp: TcpStream, mut send: quinn::SendStream, mut recv: quinn::RecvStream) {
    let _ = tcp.set_nodelay(true);
    let (mut tr, mut tw) = tcp.into_split();
    let up = async {
        let _ = tokio::io::copy(&mut tr, &mut send).await;
        let _ = send.finish();
    };
    let down = async {
        let _ = tokio::io::copy(&mut recv, &mut tw).await;
        let _ = tw.shutdown().await;
    };
    tokio::join!(up, down);
}

// ---------- Хозяин ----------

/// Хозяин: принять одного гостя на «пробитом» сокете и пускать его потоки в мир на `port`
async fn serve_guest(endpoint: quinn::Endpoint, guest: SocketAddrV4, key: String, port: u16, knocker: Option<Knocker>) {
    // Ждём первого удачного рукопожатия: случайный пакет или неудачная попытка не должны
    // занять место гостя
    let deadline = tokio::time::Instant::now() + ANSWER_WAIT + HANDSHAKE_TIMEOUT;
    let conn = loop {
        let incoming = match tokio::time::timeout_at(deadline, endpoint.accept()).await {
            Ok(Some(i)) => i,
            _ => {
                log::info!("Прямое соединение: гость {guest} не подключился");
                endpoint.close(0u32.into(), b"");
                return;
            }
        };
        match tokio::time::timeout_at(deadline, incoming).await {
            Ok(Ok(c)) => break c,
            Ok(Err(e)) => log::info!("Прямое соединение: рукопожатие не удалось: {e}"),
            Err(_) => {}
        }
    };
    drop(knocker);
    log::info!("Прямое соединение: друг подключился напрямую ({})", conn.remote_address());
    let key = Arc::new(key.into_bytes());
    while let Ok((send, mut recv)) = conn.accept_bi().await {
        let key = key.clone();
        tokio::spawn(async move {
            let mut got = [0u8; KEY_LEN];
            let ok = tokio::time::timeout(Duration::from_secs(10), recv.read_exact(&mut got)).await;
            if !matches!(ok, Ok(Ok(()))) || got[..] != key[..] {
                log::warn!("Прямое соединение: поток без ключа — закрыт");
                return;
            }
            match TcpStream::connect((Ipv4Addr::LOCALHOST, port)).await {
                Ok(tcp) => pipe(tcp, send, recv).await,
                Err(e) => log::warn!("Прямое соединение: мир на порту {port} не отвечает: {e}"),
            }
        });
    }
    log::info!("Прямое соединение с {guest} закрыто");
    endpoint.close(0u32.into(), b"");
}

/// Хозяин: ответить на одну заявку гостя
async fn answer(http: &HttpClient, token: &str, nonce: &str, guest: SocketAddrV4, key: String, port: u16) -> Result<()> {
    let sock = bind().await?;
    let mine = public_addr(&sock).await?;
    log::info!("Прямое соединение: гость {guest}, мой адрес {mine} — стучусь к нему");
    let sock = sock.into_std()?;
    let knocker = Knocker::start(&sock, guest.into(), ANSWER_WAIT + HANDSHAKE_TIMEOUT)?;
    let (endpoint, fingerprint) = server_endpoint(sock)?;
    hytpotchi::post(
        http,
        "/api/friends/punch/answer",
        Some(token),
        json!({ "nonce": nonce, "addr": mine.to_string(), "cert": fingerprint }),
    )
    .await?;
    tokio::spawn(serve_guest(endpoint, guest, key, port, Some(knocker)));
    Ok(())
}

/// Пока мир открыт — опрашивать хаб и отвечать гостям
async fn host_loop(http: HttpClient, token: String, port: u16) {
    let mut seen = HashSet::new();
    loop {
        tokio::time::sleep(POLL_EVERY).await;
        let Ok(reply) = hytpotchi::post(&http, "/api/friends/punch/poll", Some(&token), json!({})).await else {
            continue;
        };
        for p in reply["punches"].as_array().cloned().unwrap_or_default() {
            let (Some(nonce), Some(addr), Some(key)) = (p["nonce"].as_str(), p["addr"].as_str(), p["key"].as_str()) else {
                continue;
            };
            if !seen.insert(nonce.to_string()) || key.len() != KEY_LEN {
                continue;
            }
            let Ok(guest) = parse_peer(addr) else { continue };
            let (http, token, nonce, key) = (http.clone(), token.clone(), nonce.to_string(), key.to_string());
            tokio::spawn(async move {
                if let Err(e) = answer(&http, &token, &nonce, guest, key, port).await {
                    log::info!("Прямое соединение: не ответили гостю: {e:#}");
                }
            });
        }
        if seen.len() > 1000 {
            seen.clear();
        }
    }
}

/// Хозяин: держать мир открытым для прямых соединений
#[derive(Default)]
pub struct PunchHost {
    task: parking_lot::Mutex<Option<(u16, JoinHandle<()>)>>,
}

impl PunchHost {
    pub fn ensure(&self, http: &HttpClient, token: &str, port: u16) {
        let mut task = self.task.lock();
        if task.as_ref().is_some_and(|(p, t)| *p == port && !t.is_finished()) {
            return;
        }
        if let Some((_, t)) = task.take() {
            t.abort();
        }
        *task = Some((port, tokio::spawn(host_loop(http.clone(), token.to_string(), port))));
    }

    pub fn stop(&self) {
        if let Some((_, t)) = self.task.lock().take() {
            t.abort();
        }
    }
}

// ---------- Гость ----------

/// Прямое соединение гостя с хозяином: по потоку QUIC на каждое соединение игры
pub struct Session {
    conn: quinn::Connection,
    key: String,
    _endpoint: quinn::Endpoint,
}

impl Session {
    pub fn alive(&self) -> bool {
        self.conn.close_reason().is_none()
    }

    /// Провести одно соединение игры через это прямое соединение
    pub async fn carry(&self, tcp: TcpStream) -> Result<()> {
        let (mut send, recv) = self.conn.open_bi().await?;
        send.write_all(self.key.as_bytes()).await?;
        pipe(tcp, send, recv).await;
        Ok(())
    }
}

/// Гость: подключиться к хозяину на пробитом сокете
async fn connect(sock: UdpSocket, host: SocketAddrV4, fingerprint: &str, key: String) -> Result<Session> {
    let sock = sock.into_std()?;
    let knocker = Knocker::start(&sock, host.into(), HANDSHAKE_TIMEOUT)?;
    let endpoint = client_endpoint(sock, fingerprint)?;
    let connecting = endpoint.connect(host.into(), SERVER_NAME)?;
    let conn = tokio::time::timeout(HANDSHAKE_TIMEOUT, connecting)
        .await
        .context("друг не ответил напрямую (его роутер или брандмауэр не пропустил пакеты)")??;
    drop(knocker);
    Ok(Session { conn, key, _endpoint: endpoint })
}

/// Гость: договориться с хозяином через хаб и соединиться напрямую
pub async fn guest_session(http: &HttpClient, token: &str, friend_id: &str) -> Result<Session> {
    let sock = bind().await?;
    let mine = public_addr(&sock).await?;
    log::info!("Прямое соединение: мой адрес {mine} (сокет {:?}) — прошу друга ответить", sock.local_addr());
    let reply = hytpotchi::post(
        http,
        "/api/friends/punch",
        Some(token),
        json!({ "id": friend_id, "addr": mine.to_string() }),
    )
    .await?;
    let nonce = reply["nonce"].as_str().context("Сервер не принял заявку")?.to_string();
    let key = reply["key"].as_str().filter(|k| k.len() == KEY_LEN).context("Сервер не выдал ключ")?.to_string();
    let deadline = tokio::time::Instant::now() + ANSWER_WAIT;
    let answer = loop {
        tokio::time::sleep(Duration::from_millis(700)).await;
        let r = hytpotchi::post(http, "/api/friends/punch/wait", Some(token), json!({ "nonce": nonce })).await?;
        if !r["answer"].is_null() {
            break r["answer"].clone();
        }
        if tokio::time::Instant::now() > deadline {
            bail!("друг не ответил (у него старая версия лаунчера или мир закрыт)");
        }
    };
    let host = parse_peer(answer["addr"].as_str().unwrap_or_default())?;
    log::info!("Прямое соединение: друг ответил, его адрес {host} — подключаюсь");
    let fingerprint = answer["cert"].as_str().context("Нет отпечатка сертификата")?;
    connect(sock, host, fingerprint, key).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncReadExt;

    #[test]
    fn parses_stun_reply() {
        // XOR-MAPPED-ADDRESS 92.100.180.119:55382
        let ip = u32::from(Ipv4Addr::new(92, 100, 180, 119)) ^ 0x2112_A442;
        let port = 55382u16 ^ 0x2112;
        let mut msg = vec![0x01, 0x01, 0x00, 0x0c, 0x21, 0x12, 0xA4, 0x42];
        msg.extend_from_slice(&[0; 12]);
        msg.extend_from_slice(&[0x00, 0x20, 0x00, 0x08, 0x00, 0x01]);
        msg.extend_from_slice(&port.to_be_bytes());
        msg.extend_from_slice(&ip.to_be_bytes());
        assert_eq!(parse_stun(&msg), Some("92.100.180.119:55382".parse().unwrap()));
        assert_eq!(parse_stun(&msg[..20]), None);
    }

    /// Хозяин и гость на одном компьютере (без NAT и хаба): QUIC с отпечатком, ключ, байты насквозь
    #[tokio::test]
    async fn quic_session_roundtrip() {
        // «Мир» хозяина — TCP-эхо
        let world = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let port = world.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut s, _)) = world.accept().await {
                tokio::spawn(async move {
                    let (mut r, mut w) = s.split();
                    let _ = tokio::io::copy(&mut r, &mut w).await;
                });
            }
        });

        let key = "k".repeat(KEY_LEN);
        let host_sock = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let guest_sock = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let host_addr = match host_sock.local_addr().unwrap() {
            SocketAddr::V4(a) => a,
            _ => unreachable!(),
        };
        let guest_addr = match guest_sock.local_addr().unwrap() {
            SocketAddr::V4(a) => a,
            _ => unreachable!(),
        };
        knock(&host_sock, guest_addr.into()).await;
        let (endpoint, fingerprint) = server_endpoint(host_sock.into_std().unwrap()).unwrap();
        tokio::spawn(serve_guest(endpoint, guest_addr, key.clone(), port, None));

        // Чужой отпечаток — соединения нет
        let bad = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        assert!(connect(bad, host_addr, &"0".repeat(64), key.clone()).await.is_err());

        let session = connect(guest_sock, host_addr, &fingerprint, key).await.unwrap();
        // Два соединения игры через одно прямое соединение, 300 КБ каждое
        for _ in 0..2 {
            let game = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
            let gport = game.local_addr().unwrap().port();
            let mut client = TcpStream::connect((Ipv4Addr::LOCALHOST, gport)).await.unwrap();
            let (server_side, _) = game.accept().await.unwrap();
            let carry = session.carry(server_side);
            let check = async {
                let payload: Vec<u8> = (0..300 * 1024).map(|i| (i % 251) as u8).collect();
                let (mut r, mut w) = client.split();
                let send = async { w.write_all(&payload).await.unwrap() };
                let recv = async {
                    let mut got = vec![0u8; payload.len()];
                    tokio::time::timeout(Duration::from_secs(10), r.read_exact(&mut got)).await.unwrap().unwrap();
                    got
                };
                let ((), got) = tokio::join!(send, recv);
                assert_eq!(got, payload);
            };
            tokio::select! {
                _ = carry => panic!("соединение закрылось раньше времени"),
                _ = check => {}
            }
        }
        assert!(session.alive());
    }

    /// Живая проверка на настоящей сети: STUN и QUIC через свой NAT (хозяин и гость на одном
    /// компьютере стучатся друг другу через публичный адрес — нужен «hairpin» на роутере).
    /// PUNCH_BIND=<адрес сетевой карты> cargo test --lib punch_live -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn punch_live() {
        let ip: Ipv4Addr = std::env::var("PUNCH_BIND").unwrap_or("0.0.0.0".into()).parse().unwrap();
        let host_sock = UdpSocket::bind((ip, 0)).await.unwrap();
        // Гость можно увести в другую сеть (например, через VPN): PUNCH_BIND_GUEST=0.0.0.0
        let gip: Ipv4Addr = std::env::var("PUNCH_BIND_GUEST").map(|s| s.parse().unwrap()).unwrap_or(ip);
        let guest_sock = UdpSocket::bind((gip, 0)).await.unwrap();
        let host_pub = public_addr(&host_sock).await;
        let guest_pub = public_addr(&guest_sock).await;
        println!("STUN: хозяин {:?} (локально {:?}), гость {:?} (локально {:?})",
            host_pub, host_sock.local_addr(), guest_pub, guest_sock.local_addr());
        let (Ok(host_pub), Ok(guest_pub)) = (host_pub, guest_pub) else { return };

        let world = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let port = world.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut s, _) = world.accept().await.unwrap();
            let (mut r, mut w) = s.split();
            let _ = tokio::io::copy(&mut r, &mut w).await;
        });
        let key = "k".repeat(KEY_LEN);
        let host_std = host_sock.into_std().unwrap();
        let knocker = Knocker::start(&host_std, guest_pub.into(), Duration::from_secs(20)).unwrap();
        let (endpoint, fingerprint) = server_endpoint(host_std).unwrap();
        tokio::spawn(serve_guest(endpoint, guest_pub, key.clone(), port, Some(knocker)));
        let t0 = std::time::Instant::now();
        match connect(guest_sock, host_pub, &fingerprint, key).await {
            Ok(session) => {
                println!("QUIC через публичные адреса установлен за {} мс", t0.elapsed().as_millis());
                let game = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
                let mut client = TcpStream::connect(game.local_addr().unwrap()).await.unwrap();
                let (server_side, _) = game.accept().await.unwrap();
                tokio::spawn(async move { session.carry(server_side).await });
                let payload = vec![7u8; 1024 * 1024];
                let (mut r, mut w) = client.split();
                let t1 = std::time::Instant::now();
                let send = async { w.write_all(&payload).await.unwrap() };
                let recv = async {
                    let mut got = vec![0u8; payload.len()];
                    tokio::time::timeout(Duration::from_secs(20), r.read_exact(&mut got)).await.map(|r| r.map(|_| got.len()))
                };
                let ((), got) = tokio::join!(send, recv);
                println!("1 МБ эхом через прямое соединение: {:?} за {} мс", got, t1.elapsed().as_millis());
            }
            Err(e) => println!("QUIC не установлен: {e:#} (роутер не поддерживает hairpin — между разными сетями это не мешает)"),
        }
    }

    /// Внешний адрес, который увидит друг (при включённом VPN должен быть домашним):
    /// cargo test --lib stun_live -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn stun_live() {
        let sock = bind().await.unwrap();
        println!("Сокет: {:?}, внешний адрес: {:?}", sock.local_addr(), public_addr(&sock).await);
    }
}
