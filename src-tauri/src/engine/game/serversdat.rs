//! servers.dat — список серверов из меню «Сетевая игра»

use std::path::Path;

use anyhow::{Result, bail};
use serde::Serialize;

use crate::engine::game::nbt::{self, Tag};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedServer {
    pub name: String,
    pub address: String,
    /// Иконка из servers.dat (base64 PNG)
    pub icon: Option<String>,
}

pub fn read(game_dir: &Path) -> Result<Vec<SavedServer>> {
    let path = game_dir.join("servers.dat");
    let Ok(data) = std::fs::read(&path) else { return Ok(vec![]) };
    let root = nbt::read(&data)?;
    Ok(root
        .get("servers")
        .and_then(Tag::as_list)
        .unwrap_or(&[])
        .iter()
        .filter_map(|s| {
            Some(SavedServer {
                address: s.get("ip")?.as_str()?.to_string(),
                name: s.get("name").and_then(Tag::as_str).unwrap_or("Сервер Minecraft").to_string(),
                icon: s.get("icon").and_then(Tag::as_str).map(str::to_string),
            })
        })
        .collect())
}

fn write_all(game_dir: &Path, servers: Vec<Tag>) -> Result<()> {
    let root = Tag::Compound(vec![("servers".into(), Tag::List(servers))]);
    std::fs::create_dir_all(game_dir)?;
    let path = game_dir.join("servers.dat");
    let tmp = game_dir.join("servers.dat.tmp");
    std::fs::write(&tmp, nbt::write(&root)?)?;
    std::fs::rename(tmp, path)?;
    Ok(())
}

fn existing_tags(game_dir: &Path) -> Result<Vec<Tag>> {
    let Ok(data) = std::fs::read(game_dir.join("servers.dat")) else { return Ok(vec![]) };
    Ok(nbt::read(&data)?
        .get("servers")
        .and_then(Tag::as_list)
        .map(<[Tag]>::to_vec)
        .unwrap_or_default())
}

pub fn add(game_dir: &Path, name: &str, address: &str) -> Result<()> {
    let address = address.trim();
    if address.is_empty() || address.len() > 255 || address.contains(char::is_whitespace) {
        bail!("Некорректный адрес сервера");
    }
    let mut list = existing_tags(game_dir)?;
    if list.iter().any(|s| s.get("ip").and_then(Tag::as_str) == Some(address)) {
        return Ok(());
    }
    let name = if name.trim().is_empty() { "Сервер Minecraft" } else { name.trim() };
    list.push(Tag::Compound(vec![
        ("name".into(), Tag::String(name.into())),
        ("ip".into(), Tag::String(address.into())),
    ]));
    write_all(game_dir, list)
}

pub fn remove(game_dir: &Path, address: &str) -> Result<()> {
    let list = existing_tags(game_dir)?
        .into_iter()
        .filter(|s| s.get("ip").and_then(Tag::as_str) != Some(address))
        .collect();
    write_all(game_dir, list)
}

/// Метка записей, которые добавил лаунчер (миры друзей). По ней их находим и обновляем.
pub const FRIEND_MARK: &str = " · друг Hytpotchi";

/// Заменить записи миров друзей на актуальные (свои серверы игрока не трогаются).
/// Миры друзей идут первыми. Возвращает true, если файл изменился.
pub fn sync_friends(game_dir: &Path, entries: &[(String, String)]) -> Result<bool> {
    let current = existing_tags(game_dir)?;
    let is_friend = |t: &Tag| t.get("name").and_then(Tag::as_str).is_some_and(|n| n.ends_with(FRIEND_MARK));
    let old_friends: Vec<(String, String)> = current
        .iter()
        .filter(|t| is_friend(t))
        .filter_map(|t| Some((t.get("name")?.as_str()?.to_string(), t.get("ip")?.as_str()?.to_string())))
        .collect();
    let wanted: Vec<(String, String)> = entries
        .iter()
        .map(|(name, ip)| (format!("{name}{FRIEND_MARK}"), ip.clone()))
        .collect();
    if old_friends == wanted {
        return Ok(false);
    }
    let mut list: Vec<Tag> = wanted
        .into_iter()
        .map(|(name, ip)| {
            Tag::Compound(vec![
                ("name".into(), Tag::String(name)),
                ("ip".into(), Tag::String(ip)),
                // Не спрашивать про скачивание ресурспака сервера каждый раз
                ("acceptTextures".into(), Tag::Byte(1)),
            ])
        })
        .collect();
    list.extend(current.into_iter().filter(|t| !is_friend(t)));
    write_all(game_dir, list)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn friends_entries_replace_only_own() {
        let dir = tempfile::tempdir().unwrap();
        add(dir.path(), "Мой сервер", "mc.example.org").unwrap();
        assert!(sync_friends(dir.path(), &[("● Liza — Остров".into(), "127.0.0.1:5000".into())]).unwrap());
        let list = read(dir.path()).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].address, "127.0.0.1:5000");
        assert!(list[0].name.ends_with(FRIEND_MARK));
        assert_eq!(list[1].address, "mc.example.org");
        // Повтор — без изменений
        assert!(!sync_friends(dir.path(), &[("● Liza — Остров".into(), "127.0.0.1:5000".into())]).unwrap());
        // Друг ушёл — его запись пропала, свой сервер остался
        assert!(sync_friends(dir.path(), &[]).unwrap());
        let list = read(dir.path()).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].address, "mc.example.org");
    }
}
