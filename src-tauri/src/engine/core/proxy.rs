//! Прокси с запасным прямым путём.
//!
//! Многие держат включённым системный прокси Windows от VPN-программы (v2rayN, Clash и т.п.).
//! Когда программа переподключается или выключена, прокси на 127.0.0.1 отказывает в соединении
//! (os error 10061) — и раньше вместе с ним падал весь лаунчер: «Сервер недоступен», моды
//! не качаются. Теперь перед запросом проверяем, принимает ли прокси соединения (результат
//! кешируется на пару секунд): работает — идём через него, нет — напрямую.

use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;

/// Адрес прокси вида http://host:port
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProxyConfig {
    pub url: String,
    host: String,
    port: u16,
}

/// Разобрать адрес прокси из переменной окружения или настроек Windows.
/// Формы: "host:port", "http://host:port", "http=h:p;https=h2:p2", "socks=h:p".
pub fn parse(raw: &str) -> Option<ProxyConfig> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    // Список по протоколам: берём https, иначе http, иначе socks
    let pick = if raw.contains('=') {
        let parts: Vec<(&str, &str)> = raw
            .split(';')
            .filter_map(|p| p.split_once('='))
            .map(|(k, v)| (k.trim(), v.trim()))
            .collect();
        let find = |key: &str| parts.iter().find(|(k, _)| k.eq_ignore_ascii_case(key)).map(|(_, v)| *v);
        match (find("https"), find("http"), find("socks")) {
            (Some(v), _, _) | (None, Some(v), _) => v.to_string(),
            (None, None, Some(v)) => format!("socks5://{}", v.trim_start_matches("socks5://")),
            _ => return None,
        }
    } else {
        raw.to_string()
    };
    let url = if pick.contains("://") { pick } else { format!("http://{pick}") };
    let after_scheme = url.split_once("://")?.1.trim_end_matches('/');
    let hostport = after_scheme.rsplit('@').next()?;
    let (host, port) = hostport.rsplit_once(':')?;
    let port: u16 = port.parse().ok()?;
    let host = host.trim_matches(|c| c == '[' || c == ']').to_string();
    if host.is_empty() {
        return None;
    }
    Some(ProxyConfig { url, host, port })
}

/// Прокси из окружения (HTTPS_PROXY и т.п.), иначе системный прокси Windows
pub fn detect() -> Option<ProxyConfig> {
    for var in ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "HTTP_PROXY", "http_proxy"] {
        if let Some(cfg) = std::env::var(var).ok().as_deref().and_then(parse) {
            return Some(cfg);
        }
    }
    windows_proxy()
}

#[cfg(target_os = "windows")]
fn windows_proxy() -> Option<ProxyConfig> {
    use windows_sys::Win32::System::Registry::{HKEY_CURRENT_USER, RRF_RT_REG_DWORD, RRF_RT_REG_SZ, RegGetValueW};

    let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let key = wide(r"Software\Microsoft\Windows\CurrentVersion\Internet Settings");

    let mut enabled: u32 = 0;
    let mut size = std::mem::size_of::<u32>() as u32;
    let name = wide("ProxyEnable");
    // SAFETY: буферы корректного размера, строки оканчиваются нулём
    let rc = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            key.as_ptr(),
            name.as_ptr(),
            RRF_RT_REG_DWORD,
            std::ptr::null_mut(),
            (&mut enabled as *mut u32).cast(),
            &mut size,
        )
    };
    if rc != 0 || enabled == 0 {
        return None;
    }

    let mut buf = vec![0u16; 1024];
    let mut size = (buf.len() * 2) as u32;
    let name = wide("ProxyServer");
    // SAFETY: см. выше
    let rc = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            key.as_ptr(),
            name.as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            buf.as_mut_ptr().cast(),
            &mut size,
        )
    };
    if rc != 0 {
        return None;
    }
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    parse(&String::from_utf16_lossy(&buf[..len]))
}

#[cfg(not(target_os = "windows"))]
fn windows_proxy() -> Option<ProxyConfig> {
    None
}

/// Проверка «прокси сейчас принимает соединения» с коротким кешем
#[derive(Clone)]
pub struct Liveness {
    cfg: ProxyConfig,
    state: Arc<Mutex<Option<(Instant, bool)>>>,
}

const CACHE_FOR: Duration = Duration::from_secs(3);
const CONNECT_TIMEOUT: Duration = Duration::from_millis(400);

impl Liveness {
    pub fn new(cfg: ProxyConfig) -> Self {
        Self { cfg, state: Arc::new(Mutex::new(None)) }
    }

    pub fn url(&self) -> &str {
        &self.cfg.url
    }

    fn addrs(&self) -> Vec<SocketAddr> {
        (self.cfg.host.as_str(), self.cfg.port).to_socket_addrs().map(|a| a.collect()).unwrap_or_default()
    }

    pub fn alive(&self) -> bool {
        if let Some((at, ok)) = *self.state.lock() {
            if at.elapsed() < CACHE_FOR {
                return ok;
            }
        }
        let ok = self.addrs().iter().any(|a| TcpStream::connect_timeout(a, CONNECT_TIMEOUT).is_ok());
        let prev = self.state.lock().replace((Instant::now(), ok)).map(|(_, p)| p);
        if prev != Some(ok) {
            if ok {
                log::info!("Прокси {} снова работает — запросы идут через него", self.cfg.url);
            } else {
                log::warn!("Прокси {} не отвечает — запросы идут напрямую", self.cfg.url);
            }
        }
        ok
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_forms() {
        let p = parse("127.0.0.1:10809").unwrap();
        assert_eq!((p.url.as_str(), p.host.as_str(), p.port), ("http://127.0.0.1:10809", "127.0.0.1", 10809));
        assert_eq!(parse("http://127.0.0.1:10809/").unwrap().port, 10809);
        assert_eq!(parse("http=a.local:1;https=b.local:2").unwrap().host, "b.local");
        assert_eq!(parse("socks=127.0.0.1:1080").unwrap().url, "socks5://127.0.0.1:1080");
        assert_eq!(parse("http://user:pw@proxy.lan:3128").unwrap().host, "proxy.lan");
        assert!(parse("").is_none());
        assert!(parse("not a proxy").is_none());
    }

    #[test]
    fn dead_proxy_is_detected() {
        // Порт, на котором точно никто не слушает
        let free = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let live = Liveness::new(parse(&format!("127.0.0.1:{free}")).unwrap());
        assert!(!live.alive());
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(Liveness::new(parse(&format!("127.0.0.1:{port}")).unwrap()).alive());
    }
}

#[cfg(test)]
mod live_tests {
    use super::*;

    /// Живая проверка (нужен интернет): прокси «упал» — запрос всё равно доходит напрямую.
    /// cargo test --lib dead_proxy_falls_back_live -- --ignored
    #[tokio::test]
    #[ignore]
    async fn dead_proxy_falls_back_live() {
        let free = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let live = Liveness::new(parse(&format!("127.0.0.1:{free}")).unwrap());
        let target = reqwest::Url::parse(live.url()).unwrap();
        let client = reqwest::Client::builder()
            .proxy(reqwest::Proxy::custom(move |_| live.alive().then(|| target.clone())))
            .build()
            .unwrap();
        let resp = client.get("https://hytpotchi-skins.akiom31.workers.dev/").send().await.unwrap();
        assert!(resp.status().is_success());

        // Для сравнения: тот же «мёртвый» прокси без проверки — ошибка, как была у лаунчера
        let broken = reqwest::Client::builder()
            .proxy(reqwest::Proxy::all(format!("http://127.0.0.1:{free}")).unwrap())
            .build()
            .unwrap();
        assert!(broken.get("https://hytpotchi-skins.akiom31.workers.dev/").send().await.is_err());
    }
}
