//! Настоящая сетевая карта компьютера (Wi-Fi или Ethernet) — мимо VPN-адаптеров.
//!
//! VPN в режиме TUN (Happ, v2rayN, Clash…) забирает весь трафик себе, в том числе UDP.
//! Для прямого соединения с другом это плохо: внешний адрес оказывается адресом VPN-сервера,
//! а он входящие пакеты от незнакомых адресов не пропускает. Если привязать сокет к адресу
//! настоящей сетевой карты, пакеты идут через домашний роутер, как без VPN.

use std::net::Ipv4Addr;

#[derive(Debug, Clone)]
pub struct Adapter {
    pub ip: Ipv4Addr,
    /// Описание и имя адаптера (для отсева виртуальных)
    pub name: String,
    /// IANA ifType: 6 — Ethernet, 71 — Wi-Fi
    pub if_type: u32,
    pub has_gateway: bool,
}

const ETHERNET: u32 = 6;
const WIFI: u32 = 71;

/// Слова в названиях виртуальных и VPN-адаптеров
const VIRTUAL: &[&str] = &[
    "virtual", "vpn", "tap", "tun", "wintun", "wireguard", "radmin", "hamachi", "zerotier", "tailscale",
    "hyper-v", "vethernet", "loopback", "happ", "clash", "sing-box", "v2ray", "xray", "openvpn", "outline",
    "amnezia", "vmware", "virtualbox", "npcap",
];

/// Выбрать адрес настоящей сетевой карты из списка адаптеров
pub fn pick(adapters: &[Adapter]) -> Option<Ipv4Addr> {
    let rank = |ip: &Ipv4Addr| match ip.octets() {
        [192, 168, ..] => 0,
        [10, ..] => 1,
        _ => 2,
    };
    adapters
        .iter()
        .filter(|a| a.has_gateway && (a.if_type == ETHERNET || a.if_type == WIFI) && a.ip.is_private())
        .filter(|a| {
            let name = a.name.to_lowercase();
            !VIRTUAL.iter().any(|w| name.contains(w))
        })
        .min_by_key(|a| (rank(&a.ip), if a.if_type == ETHERNET { 0 } else { 1 }))
        .map(|a| a.ip)
}

/// Адрес настоящей сетевой карты, если его удалось определить
pub fn lan_ipv4() -> Option<Ipv4Addr> {
    pick(&adapters())
}

#[cfg(windows)]
pub fn adapters() -> Vec<Adapter> {
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        GAA_FLAG_INCLUDE_GATEWAYS, GAA_FLAG_SKIP_ANYCAST, GAA_FLAG_SKIP_DNS_SERVER, GAA_FLAG_SKIP_MULTICAST,
        GetAdaptersAddresses, IP_ADAPTER_ADDRESSES_LH,
    };
    use windows_sys::Win32::NetworkManagement::Ndis::IfOperStatusUp;
    use windows_sys::Win32::Networking::WinSock::{AF_INET, SOCKADDR_IN};

    const ERROR_BUFFER_OVERFLOW: u32 = 111;
    let flags = GAA_FLAG_INCLUDE_GATEWAYS | GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER;
    let mut size: u32 = 16 * 1024;
    let mut buf: Vec<u64>;
    loop {
        buf = vec![0u64; (size as usize).div_ceil(8)];
        // SAFETY: буфер выровнен и не меньше size байт
        let rc = unsafe {
            GetAdaptersAddresses(
                AF_INET as u32,
                flags,
                std::ptr::null(),
                buf.as_mut_ptr().cast::<IP_ADAPTER_ADDRESSES_LH>(),
                &mut size,
            )
        };
        match rc {
            0 => break,
            ERROR_BUFFER_OVERFLOW if size < 4 * 1024 * 1024 => continue,
            _ => return Vec::new(),
        }
    }

    let wide = |p: *const u16| -> String {
        if p.is_null() {
            return String::new();
        }
        // SAFETY: строка Windows оканчивается нулём
        unsafe {
            let len = (0..).take_while(|&i| *p.add(i) != 0).count();
            String::from_utf16_lossy(std::slice::from_raw_parts(p, len))
        }
    };

    let mut out = Vec::new();
    let mut cur = buf.as_ptr().cast::<IP_ADAPTER_ADDRESSES_LH>();
    // SAFETY: обходим связный список, который заполнила GetAdaptersAddresses, внутри buf
    unsafe {
        while !cur.is_null() {
            let a = &*cur;
            if a.OperStatus == IfOperStatusUp {
                let name = format!("{} {}", wide(a.Description), wide(a.FriendlyName));
                let mut u = a.FirstUnicastAddress;
                while !u.is_null() {
                    let sa = (*u).Address.lpSockaddr;
                    if !sa.is_null() && (*sa).sa_family == AF_INET {
                        let sin = &*sa.cast::<SOCKADDR_IN>();
                        let ip = Ipv4Addr::from(u32::from_be(sin.sin_addr.S_un.S_addr));
                        out.push(Adapter {
                            ip,
                            name: name.clone(),
                            if_type: a.IfType,
                            has_gateway: !a.FirstGatewayAddress.is_null(),
                        });
                    }
                    u = (*u).Next;
                }
            }
            cur = a.Next;
        }
    }
    out
}

#[cfg(not(windows))]
pub fn adapters() -> Vec<Adapter> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn a(ip: &str, name: &str, if_type: u32, gw: bool) -> Adapter {
        Adapter { ip: ip.parse().unwrap(), name: name.into(), if_type, has_gateway: gw }
    }

    #[test]
    fn picks_real_card() {
        let list = [
            a("172.18.0.1", "Happ Wintun", 53, true),
            a("26.28.63.109", "Radmin VPN", 6, true),
            a("172.30.16.1", "Hyper-V Virtual Ethernet Adapter vEthernet (WSL)", 6, false),
            a("192.168.0.12", "Intel(R) Wi-Fi 6 AX201 Беспроводная сеть", 71, true),
        ];
        assert_eq!(pick(&list), Some("192.168.0.12".parse().unwrap()));
        // Ethernet предпочтительнее Wi-Fi в той же сети
        let both = [a("192.168.0.12", "Wi-Fi", 71, true), a("192.168.0.20", "Realtek PCIe GbE", 6, true)];
        assert_eq!(pick(&both), Some("192.168.0.20".parse().unwrap()));
        // Ничего настоящего — не привязываемся
        assert_eq!(pick(&list[..3]), None);
    }

    /// Что видно на этом компьютере: cargo test --lib netif_live -- --ignored --nocapture
    #[test]
    #[ignore]
    fn netif_live() {
        for ad in adapters() {
            println!("{ad:?}");
        }
        println!("Выбран: {:?}", lan_ipv4());
    }
}
