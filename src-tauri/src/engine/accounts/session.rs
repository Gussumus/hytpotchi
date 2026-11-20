//! Список аккаунтов (без секретов — токены лежат в SecretsVault)

use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use md5::{Digest, Md5};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AccountKind {
    Microsoft,
    /// Аккаунт Hytpotchi: уникальный ник с паролем на сервере Hytpotchi
    Hytpotchi,
    /// Старый офлайн-аккаунт (любой ник без пароля). Играть им больше нельзя —
    /// только перенести ник в аккаунт Hytpotchi.
    Offline,
}

impl AccountKind {
    /// Вход в игру без Microsoft (UUID из ника, токен "0")
    pub fn offline_mode(self) -> bool {
        matches!(self, Self::Hytpotchi | Self::Offline)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub username: String,
    /// UUID профиля Minecraft (без дефисов)
    pub uuid: String,
    pub kind: AccountKind,
    pub added_at: String,
    #[serde(default)]
    pub skin_url: Option<String>,
    /// Офлайн: id скина из библиотеки (показывается через CustomSkinLoader)
    #[serde(default)]
    pub offline_skin: Option<String>,
    /// Офлайн: classic | slim
    #[serde(default)]
    pub offline_variant: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct AccountsFile {
    accounts: Vec<Account>,
    active: Option<String>,
}

pub struct AccountStore {
    path: PathBuf,
    data: RwLock<AccountsFile>,
}

impl AccountStore {
    pub fn load(dir: &Path) -> Result<Self> {
        let path = dir.join("accounts.json");
        let data = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|e| {
                log::error!("accounts.json повреждён: {e}");
                AccountsFile::default()
            }),
            Err(_) => AccountsFile::default(),
        };
        Ok(Self { path, data: RwLock::new(data) })
    }

    fn persist(&self, data: &AccountsFile) -> Result<()> {
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(data)?)?;
        std::fs::rename(tmp, &self.path)?;
        Ok(())
    }

    pub fn list(&self) -> (Vec<Account>, Option<String>) {
        let d = self.data.read();
        (d.accounts.clone(), d.active.clone())
    }

    pub fn get(&self, id: &str) -> Option<Account> {
        self.data.read().accounts.iter().find(|a| a.id == id).cloned()
    }

    pub fn active(&self) -> Option<Account> {
        let d = self.data.read();
        let id = d.active.as_ref()?;
        d.accounts.iter().find(|a| &a.id == id).cloned()
    }

    /// Добавить или обновить (тот же UUID и тип → тот же аккаунт)
    pub fn upsert(&self, mut account: Account) -> Result<Account> {
        let mut d = self.data.write();
        if let Some(existing) = d
            .accounts
            .iter_mut()
            .find(|a| a.uuid == account.uuid && a.kind == account.kind)
        {
            account.id = existing.id.clone();
            account.added_at = existing.added_at.clone();
            // Повторный вход не должен сбрасывать выбранный офлайн-скин
            if account.offline_skin.is_none() {
                account.offline_skin = existing.offline_skin.clone();
                account.offline_variant = existing.offline_variant.clone();
            }
            *existing = account.clone();
        } else {
            d.accounts.push(account.clone());
        }
        d.active = Some(account.id.clone());
        self.persist(&d)?;
        Ok(account)
    }

    pub fn remove(&self, id: &str) -> Result<()> {
        let mut d = self.data.write();
        d.accounts.retain(|a| a.id != id);
        if d.active.as_deref() == Some(id) {
            d.active = d.accounts.first().map(|a| a.id.clone());
        }
        self.persist(&d)
    }

    /// Выбрать скин из библиотеки для офлайн-аккаунта (`None` — стандартный)
    pub fn set_offline_skin(&self, id: &str, skin: Option<(String, String)>) -> Result<Account> {
        let mut d = self.data.write();
        let account = d.accounts.iter_mut().find(|a| a.id == id).context("Аккаунт не найден")?;
        match skin {
            Some((skin_id, variant)) => {
                account.offline_skin = Some(skin_id);
                account.offline_variant = Some(variant);
            }
            None => {
                account.offline_skin = None;
                account.offline_variant = None;
            }
        }
        let updated = account.clone();
        self.persist(&d)?;
        Ok(updated)
    }

    pub fn set_active(&self, id: &str) -> Result<()> {
        let mut d = self.data.write();
        if !d.accounts.iter().any(|a| a.id == id) {
            bail!("Аккаунт не найден");
        }
        d.active = Some(id.to_string());
        self.persist(&d)
    }
}

/// Офлайн-UUID как у ванильного сервера: md5("OfflinePlayer:" + ник), версия 3
pub fn offline_uuid(username: &str) -> String {
    let mut bytes: [u8; 16] = Md5::digest(format!("OfflinePlayer:{username}").as_bytes()).into();
    bytes[6] = (bytes[6] & 0x0f) | 0x30;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    uuid::Uuid::from_bytes(bytes).simple().to_string()
}

pub fn validate_username(name: &str) -> Result<()> {
    let ok = (3..=16).contains(&name.len())
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
    if !ok {
        bail!("Ник: 3–16 символов, латиница, цифры и _");
    }
    Ok(())
}

pub fn new_account(username: &str, uuid: &str, kind: AccountKind, skin: Option<String>) -> Account {
    Account {
        id: uuid::Uuid::new_v4().to_string(),
        username: username.to_string(),
        uuid: uuid.replace('-', ""),
        kind,
        added_at: chrono::Utc::now().to_rfc3339(),
        skin_url: skin,
        offline_skin: None,
        offline_variant: None,
    }
}

pub fn require(account: Option<Account>) -> Result<Account> {
    account.context("Добавьте аккаунт, чтобы играть")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offline_uuid_matches_vanilla() {
        // Известное значение для ника "Notch"
        assert_eq!(offline_uuid("Notch"), "b50ad385829d3141a2167e7d7539ba7f");
    }
}
