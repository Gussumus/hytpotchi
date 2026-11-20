//! HTTP-клиент: ретраи, проверка хешей и размера, атомарная запись файлов

use std::path::Path;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use reqwest::{Client, ClientBuilder, Response};
use serde::de::DeserializeOwned;
use sha1::Digest as _;
use tokio::io::AsyncWriteExt;

/// Ожидаемые параметры файла (хеши — hex в нижнем регистре)
#[derive(Debug, Clone, Default)]
pub struct VerifiedDownload {
    pub sha1: Option<String>,
    pub sha256: Option<String>,
    pub size: Option<u64>,
}

impl VerifiedDownload {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn with_sha1(mut self, hash: impl Into<String>) -> Self {
        self.sha1 = Some(hash.into().to_lowercase());
        self
    }
    pub fn with_sha256(mut self, hash: impl Into<String>) -> Self {
        self.sha256 = Some(hash.into().to_lowercase());
        self
    }
    pub fn with_size(mut self, size: u64) -> Self {
        self.size = Some(size);
        self
    }
    pub fn sha1_opt(mut self, hash: Option<&str>) -> Self {
        self.sha1 = hash.map(str::to_lowercase);
        self
    }
    pub fn size_opt(mut self, size: Option<u64>) -> Self {
        self.size = size;
        self
    }
}

/// Колбэк прогресса скачивания: (скачано байт, всего байт)
pub type ByteProgress<'a> = &'a (dyn Fn(u64, Option<u64>) + Send + Sync);

#[derive(Clone)]
pub struct HttpClient {
    pub client: Client,
}

impl HttpClient {
    /// Перенаправляет только официальные адреса Modrinth через Worker.
    /// Если переменная сборки не задана, используется прямое подключение.
    pub fn route_url(&self, raw: &str) -> String {
        let Some(base) = option_env!("HYTPOTCHI_MODRINTH_PROXY") else {
            return raw.to_string();
        };
        let Ok(url) = url::Url::parse(raw) else {
            return raw.to_string();
        };
        let Some(host) = url.host_str() else {
            return raw.to_string();
        };
        let host = host.to_ascii_lowercase();
        let is_api = host == "api.modrinth.com";
        let is_file = host == "modrinth.com"
            || host == "modrinth.net"
            || host.ends_with(".modrinth.com")
            || host.ends_with(".modrinth.net");
        if !is_api && !is_file {
            return raw.to_string();
        }
        let base = base.trim_end_matches('/');
        if is_api {
            format!("{base}{}", url.path_and_query())
        } else {
            let encoded: String = url::form_urlencoded::byte_serialize(raw.as_bytes()).collect();
            format!("{base}/download?url={encoded}")
        }
    }

    pub fn new() -> Result<Self> {
        let client = ClientBuilder::new()
            .connect_timeout(Duration::from_secs(15))
            .read_timeout(Duration::from_secs(60))
            .pool_max_idle_per_host(32)
            .user_agent(concat!(
                "Hytpotchi/",
                env!("CARGO_PKG_VERSION"),
                " (github.com/hytpotchi/launcher)"
            ))
            .build()
            .context("Не удалось создать HTTP-клиент")?;
        Ok(Self { client })
    }

    /// GET с проверкой статуса
    pub async fn get(&self, url: &str) -> Result<Response> {
        let response = self
            .client
            .get(self.route_url(url))
            .send()
            .await
            .with_context(|| format!("Нет ответа от {}", host_of(url)))?;
        Ok(response.error_for_status()?)
    }

    pub async fn get_with_headers(&self, url: &str, headers: &[(&str, &str)]) -> Result<Response> {
        let mut request = self.client.get(self.route_url(url));
        for (k, v) in headers {
            request = request.header(*k, *v);
        }
        let response = request
            .send()
            .await
            .with_context(|| format!("Нет ответа от {}", host_of(url)))?;
        Ok(response.error_for_status()?)
    }

    /// GET + JSON с ретраями
    pub async fn get_json<T: DeserializeOwned>(&self, url: &str) -> Result<T> {
        let mut last_err = None;
        for attempt in 0..3 {
            if attempt > 0 {
                tokio::time::sleep(Duration::from_millis(400 * attempt)).await;
            }
            match self.get(url).await {
                Ok(resp) => match resp.json::<T>().await {
                    Ok(v) => return Ok(v),
                    Err(e) => last_err = Some(anyhow::Error::from(e)),
                },
                Err(e) => {
                    // 4xx повторять бессмысленно
                    if is_client_error(&e) {
                        return Err(e);
                    }
                    last_err = Some(e);
                }
            }
        }
        Err(last_err.unwrap_or_else(|| anyhow::anyhow!("Запрос не удался")))
            .with_context(|| format!("Не удалось загрузить {url}"))
    }

    /// Скачать файл с проверкой (3 попытки, запись через `.part`)
    pub async fn download_verified(
        &self,
        url: &str,
        dest: &Path,
        expected: VerifiedDownload,
    ) -> Result<()> {
        self.download_with_progress(url, dest, &expected, None).await
    }

    pub async fn download_with_progress(
        &self,
        url: &str,
        dest: &Path,
        expected: &VerifiedDownload,
        progress: Option<ByteProgress<'_>>,
    ) -> Result<()> {
        if let Some(parent) = dest.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let mut last_err = None;
        for attempt in 0..3u64 {
            if attempt > 0 {
                tokio::time::sleep(Duration::from_millis(500 * attempt)).await;
            }
            match self.try_download(url, dest, expected, progress).await {
                Ok(()) => return Ok(()),
                Err(e) => {
                    log::warn!("Загрузка {url} (попытка {}): {e:#}", attempt + 1);
                    if is_client_error(&e) {
                        return Err(e);
                    }
                    last_err = Some(e);
                }
            }
        }
        Err(last_err.unwrap()).with_context(|| format!("Не удалось скачать {url}"))
    }

    async fn try_download(
        &self,
        url: &str,
        dest: &Path,
        expected: &VerifiedDownload,
        progress: Option<ByteProgress<'_>>,
    ) -> Result<()> {
        let mut response = self.get(url).await?;
        let total = expected.size.or(response.content_length());
        let mut part_name = dest.file_name().unwrap_or_default().to_os_string();
        part_name.push(".part");
        let part = dest.with_file_name(part_name);
        let mut file = tokio::fs::File::create(&part).await?;
        let mut sha1 = sha1::Sha1::new();
        let mut sha256 = sha2::Sha256::new();
        let mut done = 0u64;

        let result: Result<()> = async {
            while let Some(chunk) = response.chunk().await? {
                file.write_all(&chunk).await?;
                if expected.sha1.is_some() {
                    sha1.update(&chunk);
                }
                if expected.sha256.is_some() {
                    sha256.update(&chunk);
                }
                done += chunk.len() as u64;
                if let Some(limit) = expected.size {
                    if done > limit {
                        bail!("Файл больше ожидаемого");
                    }
                }
                if let Some(cb) = progress {
                    cb(done, total);
                }
            }
            file.flush().await?;
            drop(file);

            if let Some(size) = expected.size {
                if size != done {
                    bail!("Размер не совпадает: {done} вместо {size}");
                }
            }
            if let Some(hash) = &expected.sha1 {
                if hex::encode(sha1.finalize()) != *hash {
                    bail!("SHA-1 не совпадает");
                }
            }
            if let Some(hash) = &expected.sha256 {
                if hex::encode(sha256.finalize()) != *hash {
                    bail!("SHA-256 не совпадает");
                }
            }
            Ok(())
        }
        .await;

        if let Err(e) = result {
            let _ = tokio::fs::remove_file(&part).await;
            return Err(e);
        }
        tokio::fs::rename(&part, dest).await?;
        Ok(())
    }
}

impl Default for HttpClient {
    fn default() -> Self {
        Self::new().expect("HTTP-клиент")
    }
}

fn host_of(url: &str) -> String {
    url::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .unwrap_or_else(|| url.to_string())
}

fn is_client_error(e: &anyhow::Error) -> bool {
    e.downcast_ref::<reqwest::Error>()
        .and_then(|e| e.status())
        .is_some_and(|s| s.is_client_error())
}

/// SHA-1 файла (hex)
pub async fn file_sha1(path: &Path) -> Result<String> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let mut file = std::fs::File::open(&path)?;
        let mut hasher = sha1::Sha1::new();
        std::io::copy(&mut file, &mut hasher)?;
        Ok(hex::encode(hasher.finalize()))
    })
    .await?
}

/// Файл уже есть и подходит по размеру (быстрая проверка без хеширования)
pub async fn file_matches_size(path: &Path, size: Option<u64>) -> bool {
    match tokio::fs::metadata(path).await {
        Ok(meta) => meta.is_file() && size.is_none_or(|s| s == meta.len()),
        Err(_) => false,
    }
}
