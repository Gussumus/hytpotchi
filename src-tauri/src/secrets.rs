//! Хранилище секретов — зашифрованные токены, ключ привязан к устройству.
//!
//! AES-256-GCM, мастер-ключ защищён DPAPI (Windows) или файлом 0600 (Unix).
//! Токены никогда не уходят во фронтенд — наружу видны только `account_id`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, Key, KeyInit, Nonce};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;
use zeroize::{Zeroize, ZeroizeOnDrop};

/// Токены аккаунта Microsoft
#[derive(Clone, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
pub struct TokenBundle {
    /// Refresh-токен Microsoft (живёт ~90 дней)
    pub ms_refresh_token: String,
    /// Токен Minecraft Services (живёт ~24 часа)
    pub mc_access_token: String,
    /// Unix-время истечения токена Minecraft
    pub mc_expires_at: i64,
}

impl std::fmt::Debug for TokenBundle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TokenBundle")
            .field("mc_expires_at", &self.mc_expires_at)
            .finish_non_exhaustive()
    }
}

/// Идентификатор аккаунта
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct AccountId(pub String);

impl AccountId {
    pub fn new() -> Self {
        Self(uuid::Uuid::new_v4().to_string())
    }
}

impl Default for AccountId {
    fn default() -> Self {
        Self::new()
    }
}

/// Содержимое хранилища
#[derive(Default, Serialize, Deserialize)]
struct VaultData {
    #[serde(default)]
    tokens: HashMap<String, TokenBundle>,
    /// Прочие секреты (например, ключи владения ником на сервере скинов)
    #[serde(default)]
    secrets: HashMap<String, String>,
}

impl VaultData {
    /// Совместимость: раньше файл был просто картой account_id → токены
    fn parse(bytes: &[u8]) -> Result<Self> {
        let value: serde_json::Value = serde_json::from_slice(bytes)?;
        let is_new = value.get("tokens").is_some_and(|v| v.is_object())
            || value.get("secrets").is_some_and(|v| v.is_object());
        if is_new {
            Ok(serde_json::from_value(value)?)
        } else {
            Ok(Self { tokens: serde_json::from_value(value)?, secrets: HashMap::new() })
        }
    }
}

/// Зашифрованное хранилище токенов
pub struct SecretsVault {
    path: PathBuf,
    master_key: [u8; 32],
    cache: RwLock<VaultData>,
}

impl Drop for SecretsVault {
    fn drop(&mut self) {
        self.master_key.zeroize();
    }
}

impl SecretsVault {
    const VAULT_FILENAME: &str = "secrets.bin";
    const KEY_FILENAME: &str = "vault.key";

    /// Открыть хранилище в каталоге данных (создаётся при первом запуске)
    pub fn open(dir: &Path) -> Result<Arc<Self>> {
        std::fs::create_dir_all(dir).context("Не удалось создать каталог данных")?;
        let master_key = load_or_create_master_key(&dir.join(Self::KEY_FILENAME))?;
        let path = dir.join(Self::VAULT_FILENAME);

        let entries = match Self::read_file(&path, &master_key) {
            Ok(entries) => entries,
            Err(e) => {
                // Повреждённое хранилище не должно ломать запуск — откладываем его в сторону
                log::error!("Хранилище секретов не читается ({e}), создаю новое");
                let _ = std::fs::rename(&path, path.with_extension("bin.broken"));
                VaultData::default()
            }
        };

        Ok(Arc::new(Self {
            path,
            master_key,
            cache: RwLock::new(entries),
        }))
    }

    fn read_file(path: &Path, key: &[u8; 32]) -> Result<VaultData> {
        if !path.exists() {
            return Ok(VaultData::default());
        }
        let data = std::fs::read(path)?;
        if data.is_empty() {
            return Ok(VaultData::default());
        }
        if data.len() < 12 {
            anyhow::bail!("Некорректный файл хранилища");
        }
        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
        let mut plaintext = cipher
            .decrypt(Nonce::from_slice(&data[..12]), &data[12..])
            .map_err(|_| anyhow::anyhow!("Не удалось расшифровать хранилище"))?;
        let entries = VaultData::parse(&plaintext);
        plaintext.zeroize();
        Ok(entries?)
    }

    async fn save(&self) -> Result<()> {
        let mut plaintext = {
            let cache = self.cache.read().await;
            serde_json::to_vec(&*cache)?
        };

        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&self.master_key));
        let mut nonce = [0u8; 12];
        getrandom::getrandom(&mut nonce)?;
        let ciphertext = cipher
            .encrypt(Nonce::from_slice(&nonce), plaintext.as_ref())
            .map_err(|_| anyhow::anyhow!("Не удалось зашифровать хранилище"));
        plaintext.zeroize();
        let ciphertext = ciphertext?;

        let mut data = Vec::with_capacity(12 + ciphertext.len());
        data.extend_from_slice(&nonce);
        data.extend_from_slice(&ciphertext);

        let tmp = self.path.with_extension("tmp");
        tokio::fs::write(&tmp, data).await?;
        tokio::fs::rename(tmp, &self.path).await?;
        Ok(())
    }

    /// Сохранить токены аккаунта
    pub async fn store_token(&self, account_id: &AccountId, token: TokenBundle) -> Result<()> {
        self.cache.write().await.tokens.insert(account_id.0.clone(), token);
        self.save().await
    }

    /// Получить токены аккаунта
    pub async fn get_token(&self, account_id: &AccountId) -> Result<Option<TokenBundle>> {
        Ok(self.cache.read().await.tokens.get(&account_id.0).cloned())
    }

    /// Удалить токены аккаунта
    pub async fn remove_account(&self, account_id: &AccountId) -> Result<()> {
        let removed = self.cache.write().await.tokens.remove(&account_id.0).is_some();
        if removed {
            self.save().await?;
        }
        Ok(())
    }

    /// Очистить хранилище
    pub async fn clear(&self) -> Result<()> {
        let mut c = self.cache.write().await;
        c.tokens.clear();
        c.secrets.clear();
        drop(c);
        self.save().await
    }

    /// Сохранить произвольный секрет
    pub async fn set_secret(&self, key: &str, value: String) -> Result<()> {
        self.cache.write().await.secrets.insert(key.to_string(), value);
        self.save().await
    }

    /// Прочитать произвольный секрет
    pub async fn get_secret(&self, key: &str) -> Option<String> {
        self.cache.read().await.secrets.get(key).cloned()
    }

    /// Удалить произвольный секрет
    pub async fn remove_secret(&self, key: &str) -> Result<()> {
        if self.cache.write().await.secrets.remove(key).is_some() {
            self.save().await?;
        }
        Ok(())
    }
}

#[cfg(target_os = "windows")]
fn load_or_create_master_key(key_path: &Path) -> Result<[u8; 32]> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
    };

    if key_path.exists() {
        let encrypted = std::fs::read(key_path)?;
        let input = CRYPT_INTEGER_BLOB {
            cbData: encrypted.len() as u32,
            pbData: encrypted.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        // SAFETY: входной буфер жив до конца вызова, выходной освобождаем через LocalFree
        let ok = unsafe {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        if ok != 0 && !output.pbData.is_null() {
            let mut key = [0u8; 32];
            let valid = output.cbData == 32;
            unsafe {
                if valid {
                    key.copy_from_slice(std::slice::from_raw_parts(output.pbData, 32));
                }
                std::ptr::write_bytes(output.pbData, 0, output.cbData as usize);
                LocalFree(output.pbData as _);
            }
            if valid {
                return Ok(key);
            }
        }
        log::warn!("Мастер-ключ не расшифровывается DPAPI — создаю новый");
    }

    let mut key = [0u8; 32];
    getrandom::getrandom(&mut key)?;
    let input = CRYPT_INTEGER_BLOB {
        cbData: 32,
        pbData: key.as_mut_ptr(),
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    // SAFETY: см. выше
    let ok = unsafe {
        CryptProtectData(
            &input,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if ok == 0 || output.pbData.is_null() {
        anyhow::bail!("DPAPI: не удалось защитить мастер-ключ");
    }
    let protected =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        LocalFree(output.pbData as _);
    }
    let tmp = key_path.with_extension("tmp");
    std::fs::write(&tmp, protected)?;
    std::fs::rename(tmp, key_path)?;
    Ok(key)
}

#[cfg(not(target_os = "windows"))]
fn load_or_create_master_key(key_path: &Path) -> Result<[u8; 32]> {
    use std::os::unix::fs::PermissionsExt;

    if let Ok(bytes) = std::fs::read(key_path) {
        if bytes.len() == 32 {
            let mut key = [0u8; 32];
            key.copy_from_slice(&bytes);
            return Ok(key);
        }
    }
    let mut key = [0u8; 32];
    getrandom::getrandom(&mut key)?;
    std::fs::write(key_path, key)?;
    std::fs::set_permissions(key_path, std::fs::Permissions::from_mode(0o600))?;
    Ok(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn vault_roundtrip() {
        let dir = tempfile::TempDir::new().unwrap();
        let id = AccountId::new();
        {
            let vault = SecretsVault::open(dir.path()).unwrap();
            vault
                .store_token(
                    &id,
                    TokenBundle {
                        ms_refresh_token: "r".into(),
                        mc_access_token: "a".into(),
                        mc_expires_at: 42,
                    },
                )
                .await
                .unwrap();
        }
        let vault = SecretsVault::open(dir.path()).unwrap();
        let token = vault.get_token(&id).await.unwrap().unwrap();
        assert_eq!(token.mc_access_token, "a");
        assert_eq!(token.mc_expires_at, 42);

        vault.set_secret("skin-claim:steve", "k".into()).await.unwrap();
        let reopened = SecretsVault::open(dir.path()).unwrap();
        assert_eq!(reopened.get_secret("skin-claim:steve").await.as_deref(), Some("k"));
        assert!(reopened.get_token(&id).await.unwrap().is_some());
    }

    #[test]
    fn parses_legacy_vault_format() {
        let legacy = br#"{"acc-1":{"ms_refresh_token":"r","mc_access_token":"a","mc_expires_at":1}}"#;
        let d = VaultData::parse(legacy).unwrap();
        assert_eq!(d.tokens["acc-1"].mc_access_token, "a");
        assert!(d.secrets.is_empty());
        let new = br#"{"tokens":{},"secrets":{"k":"v"}}"#;
        assert_eq!(VaultData::parse(new).unwrap().secrets["k"], "v");
    }
}
