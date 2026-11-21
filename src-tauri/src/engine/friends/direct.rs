//! Прямой вход в мир друга: проброс порта на роутере хозяина (UPnP).
//!
//! У части провайдеров соединения к Cloudflare без VPN «замерзают», и туннель через сервер
//! Hytpotchi для игры не годится. Если роутер хозяина умеет UPnP и у него публичный адрес
//! (не NAT провайдера), друг подключается к миру напрямую — трафик не уходит за границу.
//! Не вышло — остаются релей в России и туннель через Cloudflare.

use std::net::{IpAddr, Ipv4Addr, SocketAddr, SocketAddrV4};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use igd_next::aio::Gateway;
use igd_next::aio::tokio::{Tokio, search_gateway};
use igd_next::{PortMappingProtocol, SearchOptions};

/// Срок проброса на роутере; продлеваем заранее
const LEASE_SECS: u32 = 3600;
const RENEW_AFTER: Duration = Duration::from_secs(20 * 60);
/// Не вышло пробросить — не мучаем роутер поиском при каждой синхронизации
const RETRY_AFTER: Duration = Duration::from_secs(10 * 60);
const SEARCH_TIMEOUT: Duration = Duration::from_secs(3);
const DESCRIPTION: &str = "Hytpotchi";

struct Mapping {
    /// Порт мира («Открыть для сети») на этом компьютере
    port: u16,
    external: SocketAddrV4,
    gateway: Gateway<Tokio>,
    renewed: Instant,
}

#[derive(Default)]
pub struct DirectHost {
    mapping: tokio::sync::Mutex<Option<Mapping>>,
    /// Порт, для которого проброс не удался, и когда
    failed: parking_lot::Mutex<Option<(u16, Instant)>>,
}

/// Адрес, по которому к компьютеру можно подключиться из интернета
pub fn is_public(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(ip.is_unspecified()
        || ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_multicast()
        || ip.is_broadcast()
        || a >= 240
        || (a == 100 && (64..128).contains(&b)) // CGNAT провайдера
        || (a == 192 && b == 0 && c == 0)
        || (a == 198 && (b == 18 || b == 19)))
}

/// Публичный адрес из ответа сервера «ip:порт» (чужим адресам в своей сети не верим)
pub fn parse_public(addr: &str) -> Option<SocketAddrV4> {
    let a: SocketAddrV4 = addr.parse().ok()?;
    (is_public(*a.ip()) && a.port() >= 1024).then_some(a)
}

/// Свой адрес в сети роутера (интерфейс, через который виден роутер)
fn local_ip_towards(gateway: SocketAddr) -> Result<IpAddr> {
    let sock = std::net::UdpSocket::bind(("0.0.0.0", 0))?;
    sock.connect(gateway)?;
    Ok(sock.local_addr()?.ip())
}

async fn map(port: u16) -> Result<Mapping> {
    let mut options = SearchOptions::default();
    options.timeout = Some(SEARCH_TIMEOUT);
    let gateway = search_gateway(options).await.context("роутер с UPnP не найден")?;
    let external = match gateway.get_external_ip().await.context("роутер не сообщил внешний адрес")? {
        IpAddr::V4(ip) => ip,
        IpAddr::V6(ip) => bail!("внешний адрес роутера IPv6 ({ip})"),
    };
    if !is_public(external) {
        bail!("роутер за NAT провайдера (его внешний адрес {external})");
    }
    let local = SocketAddr::new(local_ip_towards(gateway.addr)?, port);
    // Тот же внешний порт, что у мира; занят — любой свободный
    let ext_port = match gateway.add_port(PortMappingProtocol::TCP, port, local, LEASE_SECS, DESCRIPTION).await {
        Ok(()) => port,
        Err(_) => gateway
            .add_any_port(PortMappingProtocol::TCP, local, LEASE_SECS, DESCRIPTION)
            .await
            .context("роутер отказал в пробросе порта")?,
    };
    Ok(Mapping { port, external: SocketAddrV4::new(external, ext_port), gateway, renewed: Instant::now() })
}

impl DirectHost {
    /// Держать мир на порту `port` доступным из интернета. Возвращает внешний адрес «ip:порт»
    /// или None, если напрямую нельзя (тогда друзья зайдут через релей).
    pub async fn ensure(&self, port: u16) -> Option<String> {
        let mut slot = self.mapping.lock().await;
        if let Some(m) = slot.as_mut() {
            if m.port == port {
                if m.renewed.elapsed() > RENEW_AFTER {
                    let local = SocketAddr::new(
                        local_ip_towards(m.gateway.addr).unwrap_or(IpAddr::V4(Ipv4Addr::UNSPECIFIED)),
                        port,
                    );
                    match m
                        .gateway
                        .add_port(PortMappingProtocol::TCP, m.external.port(), local, LEASE_SECS, DESCRIPTION)
                        .await
                    {
                        Ok(()) => m.renewed = Instant::now(),
                        Err(e) => log::warn!("Прямой вход: проброс не продлён: {e}"),
                    }
                }
                return Some(m.external.to_string());
            }
        }
        if let Some(old) = slot.take() {
            let _ = old.gateway.remove_port(PortMappingProtocol::TCP, old.external.port()).await;
        }
        if self.failed.lock().is_some_and(|(p, at)| p == port && at.elapsed() < RETRY_AFTER) {
            return None;
        }
        match map(port).await {
            Ok(m) => {
                log::info!("Прямой вход: мир доступен из интернета по {} (UPnP)", m.external);
                let addr = m.external.to_string();
                *slot = Some(m);
                *self.failed.lock() = None;
                Some(addr)
            }
            Err(e) => {
                log::info!("Прямой вход недоступен: {e:#} — друзья зайдут через релей");
                *self.failed.lock() = Some((port, Instant::now()));
                None
            }
        }
    }

    /// Мир закрыт: убрать проброс с роутера
    pub async fn stop(&self) {
        *self.failed.lock() = None;
        if let Some(m) = self.mapping.lock().await.take() {
            match m.gateway.remove_port(PortMappingProtocol::TCP, m.external.port()).await {
                Ok(()) => log::info!("Прямой вход: проброс {} снят", m.external),
                Err(e) => log::warn!("Прямой вход: проброс {} не снят: {e}", m.external),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_addresses() {
        for ok in ["93.184.216.34", "5.255.255.5", "100.63.0.1", "100.128.0.1"] {
            assert!(is_public(ok.parse().unwrap()), "{ok}");
        }
        for bad in [
            "10.0.0.1", "172.16.5.5", "192.168.0.1", "127.0.0.1", "100.64.0.1", "100.127.255.1", "169.254.1.1",
            "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1", "192.0.0.8",
        ] {
            assert!(!is_public(bad.parse().unwrap()), "{bad}");
        }
        assert_eq!(parse_public("93.184.216.34:25565"), Some("93.184.216.34:25565".parse().unwrap()));
        assert_eq!(parse_public("192.168.0.5:25565"), None);
        assert_eq!(parse_public("93.184.216.34:80"), None);
        assert_eq!(parse_public("example.com:25565"), None);
    }

    /// Живая проверка на настоящем роутере: найти шлюз, пробросить временный порт и сразу снять.
    /// cargo test --lib upnp_live -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn upnp_live() {
        let mut options = SearchOptions::default();
        options.timeout = Some(SEARCH_TIMEOUT);
        if let Ok(ip) = std::env::var("UPNP_BIND") {
            options.bind_addr = SocketAddr::new(ip.parse().unwrap(), 0);
        }
        match search_gateway(options).await {
            Ok(gw) => {
                println!("Роутер: {} ({})", gw.addr, gw.root_url);
                println!("Внешний адрес роутера: {:?}", gw.get_external_ip().await);
                println!("Свой адрес в сети роутера: {:?}", local_ip_towards(gw.addr));
            }
            Err(e) => println!("Роутер с UPnP не найден: {e}"),
        }
        let listener = std::net::TcpListener::bind(("0.0.0.0", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let host = DirectHost::default();
        let addr = host.ensure(port).await;
        println!("Итог ensure({port}): {addr:?}");
        host.stop().await;
    }
}
