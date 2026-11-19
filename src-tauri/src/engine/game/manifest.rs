//! Манифесты версий Mojang и профили загрузчиков (Fabric/Quilt).
//!
//! Поддерживаются старые (`minecraftArguments`, `natives`) и новые (`arguments`,
//! natives как отдельные библиотеки) форматы, а также наследование `inheritsFrom`.

use std::collections::{HashMap, HashSet};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

use crate::engine::core::http::{HttpClient, VerifiedDownload};
use crate::engine::core::paths::{version_json_path, versions_dir};

const VERSION_LIST_URL: &str = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";

pub const OS_NAME: &str = if cfg!(target_os = "windows") {
    "windows"
} else if cfg!(target_os = "macos") {
    "osx"
} else {
    "linux"
};

pub const OS_ARCH: &str = if cfg!(target_arch = "x86") {
    "x86"
} else if cfg!(target_arch = "aarch64") {
    "arm64"
} else {
    "x86_64"
};

// ---------- Список версий ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VersionEntry {
    pub id: String,
    #[serde(rename = "type")]
    pub version_type: String,
    pub url: String,
    #[serde(default)]
    pub time: String,
    #[serde(rename = "releaseTime", default)]
    pub release_time: String,
    #[serde(default)]
    pub sha1: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LatestVersions {
    pub release: String,
    pub snapshot: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VersionList {
    pub latest: LatestVersions,
    pub versions: Vec<VersionEntry>,
}

/// Список версий: сеть, при её отсутствии — кеш с диска
pub async fn fetch_version_list(client: &HttpClient) -> Result<VersionList> {
    let cache = versions_dir()?.join("version_manifest_v2.json");
    match client.get_json::<VersionList>(VERSION_LIST_URL).await {
        Ok(list) => {
            if let Some(parent) = cache.parent() {
                let _ = tokio::fs::create_dir_all(parent).await;
            }
            let _ = tokio::fs::write(&cache, serde_json::to_vec(&list)?).await;
            Ok(list)
        }
        Err(e) => {
            log::warn!("Список версий недоступен, беру кеш: {e:#}");
            let data = tokio::fs::read(&cache)
                .await
                .context("Нет интернета и нет сохранённого списка версий")?;
            Ok(serde_json::from_slice(&data)?)
        }
    }
}

// ---------- Манифест версии ----------

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionManifest {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inherits_from: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset_index: Option<AssetIndex>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assets: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub downloads: Option<Downloads>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub java_version: Option<JavaVersion>,
    #[serde(default)]
    pub libraries: Vec<Library>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logging: Option<Logging>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub main_class: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub minecraft_arguments: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arguments: Option<Arguments>,
    #[serde(rename = "type", default, skip_serializing_if = "Option::is_none")]
    pub version_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub release_time: Option<String>,
    /// Версия, чей client.jar используется (корень цепочки наследования)
    #[serde(skip)]
    pub jar_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetIndex {
    pub id: String,
    pub sha1: String,
    pub size: u64,
    pub url: String,
    #[serde(default)]
    pub total_size: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Downloads {
    pub client: Artifact,
    #[serde(default)]
    pub server: Option<Artifact>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Artifact {
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub sha1: Option<String>,
    #[serde(default)]
    pub size: Option<u64>,
    #[serde(default)]
    pub url: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JavaVersion {
    #[serde(default)]
    pub component: Option<String>,
    pub major_version: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Library {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub downloads: Option<LibraryDownloads>,
    /// Maven-репозиторий (формат Fabric/Quilt)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha1: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub natives: Option<HashMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rules: Option<Vec<Rule>>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct LibraryDownloads {
    #[serde(default)]
    pub artifact: Option<Artifact>,
    #[serde(default)]
    pub classifiers: Option<HashMap<String, Artifact>>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Rule {
    pub action: String,
    #[serde(default)]
    pub os: Option<OsRule>,
    #[serde(default)]
    pub features: Option<HashMap<String, bool>>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct OsRule {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub arch: Option<String>,
    #[serde(default)]
    pub version: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct Arguments {
    #[serde(default)]
    pub game: Vec<Argument>,
    #[serde(default)]
    pub jvm: Vec<Argument>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(untagged)]
pub enum Argument {
    Plain(String),
    Ruled {
        #[serde(default)]
        rules: Vec<Rule>,
        value: ArgValue,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(untagged)]
pub enum ArgValue {
    One(String),
    Many(Vec<String>),
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Logging {
    #[serde(default)]
    pub client: Option<LoggingClient>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct LoggingClient {
    pub argument: String,
    pub file: LoggingFile,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct LoggingFile {
    pub id: String,
    pub sha1: String,
    pub size: u64,
    pub url: String,
}

// ---------- Правила ----------

impl Rule {
    fn matches(&self) -> bool {
        // Особые режимы (демо, своё разрешение, quick play) не используем
        if let Some(features) = &self.features {
            if features.values().any(|wanted| *wanted) {
                return false;
            }
        }
        if let Some(os) = &self.os {
            if os.name.as_deref().is_some_and(|n| n != OS_NAME) {
                return false;
            }
            if os.arch.as_deref().is_some_and(|a| a != OS_ARCH) {
                return false;
            }
        }
        true
    }
}

/// Итог по списку правил: последнее подходящее правило побеждает
pub fn rules_allow(rules: &[Rule]) -> bool {
    if rules.is_empty() {
        return true;
    }
    let mut allowed = false;
    for rule in rules {
        if rule.matches() {
            allowed = rule.action == "allow";
        }
    }
    allowed
}

impl Argument {
    pub fn resolve(&self) -> Vec<String> {
        match self {
            Argument::Plain(s) => vec![s.clone()],
            Argument::Ruled { rules, value } if rules_allow(rules) => match value {
                ArgValue::One(s) => vec![s.clone()],
                ArgValue::Many(v) => v.clone(),
            },
            Argument::Ruled { .. } => vec![],
        }
    }
}

// ---------- Библиотеки ----------

/// Файл, который нужно скачать
#[derive(Debug, Clone)]
pub struct LibraryFile {
    pub url: String,
    /// Путь относительно каталога libraries
    pub path: String,
    pub sha1: Option<String>,
    pub size: Option<u64>,
}

/// `group:artifact:version[:classifier][@ext]` → maven-путь
pub fn maven_path(name: &str) -> Option<String> {
    let (coords, ext) = match name.split_once('@') {
        Some((c, e)) => (c, e),
        None => (name, "jar"),
    };
    let parts: Vec<&str> = coords.split(':').collect();
    if parts.len() < 3 {
        return None;
    }
    let (group, artifact, version) = (parts[0].replace('.', "/"), parts[1], parts[2]);
    let file = match parts.get(3) {
        Some(classifier) => format!("{artifact}-{version}-{classifier}.{ext}"),
        None => format!("{artifact}-{version}.{ext}"),
    };
    Some(format!("{group}/{artifact}/{version}/{file}"))
}

impl Library {
    pub fn applies(&self) -> bool {
        self.rules.as_deref().is_none_or(rules_allow)
    }

    /// Ключ для слияния: group:artifact[:classifier] без версии
    fn merge_key(&self) -> String {
        let parts: Vec<&str> = self.name.split('@').next().unwrap_or("").split(':').collect();
        match parts.as_slice() {
            [g, a, _, c, ..] => format!("{g}:{a}:{c}"),
            [g, a, ..] => format!("{g}:{a}"),
            _ => self.name.clone(),
        }
    }

    /// Классификатор нативов старого формата (`natives: { windows: "natives-windows" }`)
    pub fn native_classifier(&self) -> Option<String> {
        let bits = if cfg!(target_pointer_width = "64") { "64" } else { "32" };
        self.natives
            .as_ref()?
            .get(OS_NAME)
            .map(|c| c.replace("${arch}", bits))
    }

    fn classifier(&self) -> Option<&str> {
        self.name.split('@').next().unwrap_or("").split(':').nth(3)
    }

    /// Библиотека-натив нового формата (`...:natives-windows`)
    pub fn is_native_artifact(&self) -> bool {
        self.classifier().is_some_and(|c| c.starts_with("natives"))
    }

    /// Натив подходит под архитектуру процессора.
    /// Mojang помечает `natives-windows` и `natives-windows-arm64` одним правилом `os: windows`,
    /// поэтому архитектуру приходится проверять по имени классификатора.
    pub fn matches_arch(&self) -> bool {
        let Some(c) = self.classifier() else { return true };
        if !c.starts_with("natives") {
            return true;
        }
        let arm = c.contains("arm64") || c.contains("aarch64");
        let x86_32 = c.ends_with("-x86");
        match OS_ARCH {
            "arm64" => arm,
            "x86" => x86_32,
            _ => !arm && !x86_32,
        }
    }

    /// Основной jar. У Forge часть библиотек без URL — их создаёт установщик.
    pub fn artifact_file(&self) -> Option<LibraryFile> {
        match &self.downloads {
            Some(downloads) => {
                let artifact = downloads.artifact.as_ref()?;
                Some(LibraryFile {
                    url: artifact.url.clone(),
                    path: artifact.path.clone().or_else(|| maven_path(&self.name))?,
                    sha1: artifact.sha1.clone(),
                    size: artifact.size,
                })
            }
            None => {
                // Формат Fabric/Quilt: только имя и адрес репозитория
                let path = maven_path(&self.name)?;
                let base = self
                    .url
                    .clone()
                    .unwrap_or_else(|| "https://libraries.minecraft.net/".into());
                Some(LibraryFile {
                    url: format!("{}/{}", base.trim_end_matches('/'), path),
                    path,
                    sha1: self.sha1.clone(),
                    size: self.size,
                })
            }
        }
    }

    /// Jar с нативами старого формата
    pub fn native_file(&self) -> Option<LibraryFile> {
        let classifier = self.native_classifier()?;
        let artifact = self.downloads.as_ref()?.classifiers.as_ref()?.get(&classifier)?;
        let path = artifact
            .path
            .clone()
            .or_else(|| maven_path(&format!("{}:{}", self.name, classifier)))?;
        Some(LibraryFile {
            url: artifact.url.clone(),
            path,
            sha1: artifact.sha1.clone(),
            size: artifact.size,
        })
    }
}

impl VersionManifest {
    /// Мажорная версия Java, которую требует версия игры
    pub fn required_java(&self) -> u32 {
        self.java_version.as_ref().map(|j| j.major_version).unwrap_or(8)
    }

    fn active_libraries(&self) -> impl Iterator<Item = &Library> {
        self.libraries.iter().filter(|l| l.applies() && l.matches_arch())
    }

    /// Все файлы библиотек для текущей ОС, которые можно скачать
    pub fn library_files(&self) -> Vec<LibraryFile> {
        let mut seen = HashSet::new();
        let mut files = Vec::new();
        for lib in self.active_libraries() {
            for file in [lib.artifact_file(), lib.native_file()].into_iter().flatten() {
                if !file.url.is_empty() && seen.insert(file.path.clone()) {
                    files.push(file);
                }
            }
        }
        files
    }

    /// Пути (относительно libraries) для classpath.
    /// Нативы нового формата тоже идут в classpath: LWJGL 3.3+ сам достаёт из них .dll.
    pub fn classpath_entries(&self) -> Vec<String> {
        let mut seen = HashSet::new();
        self.active_libraries()
            .filter_map(|l| l.artifact_file())
            .map(|f| f.path)
            .filter(|p| seen.insert(p.clone()))
            .collect()
    }

    /// Пути jar'ов, из которых нужно распаковать нативы
    pub fn native_jars(&self) -> Vec<String> {
        let mut result = Vec::new();
        for lib in self.active_libraries() {
            if let Some(file) = lib.native_file() {
                result.push(file.path);
            } else if lib.is_native_artifact() {
                if let Some(file) = lib.artifact_file() {
                    result.push(file.path);
                }
            }
        }
        result
    }
}

// ---------- Загрузка и наследование ----------

fn merge(parent: VersionManifest, child: VersionManifest) -> VersionManifest {
    // Библиотеки ребёнка (загрузчик) идут первыми и перекрывают родительские
    let keys: HashSet<String> = child.libraries.iter().map(Library::merge_key).collect();
    let mut libraries = child.libraries;
    libraries.extend(
        parent
            .libraries
            .into_iter()
            .filter(|l| !keys.contains(&l.merge_key())),
    );

    let arguments = match (parent.arguments, child.arguments) {
        (Some(mut p), Some(c)) => {
            p.jvm.extend(c.jvm);
            p.game.extend(c.game);
            Some(p)
        }
        (p, c) => c.or(p),
    };

    VersionManifest {
        id: child.id,
        inherits_from: None,
        asset_index: child.asset_index.or(parent.asset_index),
        assets: child.assets.or(parent.assets),
        downloads: child.downloads.or(parent.downloads),
        java_version: child.java_version.or(parent.java_version),
        libraries,
        logging: child.logging.or(parent.logging),
        main_class: child.main_class.or(parent.main_class),
        minecraft_arguments: child.minecraft_arguments.or(parent.minecraft_arguments),
        arguments,
        version_type: child.version_type.or(parent.version_type),
        release_time: child.release_time.or(parent.release_time),
        jar_id: parent.jar_id,
    }
}

/// Загрузить манифест версии: с диска или из сети (с проверкой SHA-1)
pub async fn load_version(client: &HttpClient, version_id: &str) -> Result<VersionManifest> {
    let path = version_json_path(version_id)?;
    if let Ok(data) = tokio::fs::read(&path).await {
        match serde_json::from_slice::<VersionManifest>(&data) {
            Ok(mut manifest) => {
                manifest.jar_id = manifest.id.clone();
                return Ok(manifest);
            }
            Err(e) => log::warn!("Повреждён {}: {e}, скачиваю заново", path.display()),
        }
    }

    let list = fetch_version_list(client).await?;
    let entry = list
        .versions
        .iter()
        .find(|v| v.id == version_id)
        .with_context(|| format!("Версия {version_id} не найдена"))?;

    client
        .download_verified(
            &entry.url,
            &path,
            VerifiedDownload::new().sha1_opt(entry.sha1.as_deref()),
        )
        .await?;

    let data = tokio::fs::read(&path).await?;
    let mut manifest: VersionManifest =
        serde_json::from_slice(&data).context("Некорректный манифест версии")?;
    manifest.jar_id = manifest.id.clone();
    Ok(manifest)
}

/// Манифест с разрешённой цепочкой наследования
pub async fn resolve_version(client: &HttpClient, version_id: &str) -> Result<VersionManifest> {
    let mut merged = load_version(client, version_id).await?;
    let mut depth = 0;
    while let Some(parent_id) = merged.inherits_from.clone() {
        depth += 1;
        if depth > 8 {
            bail!("Слишком длинная цепочка наследования у {version_id}");
        }
        let parent = load_version(client, &parent_id).await?;
        merged = merge(parent, merged);
    }
    if merged.main_class.is_none() {
        bail!("В манифесте {version_id} нет mainClass");
    }
    Ok(merged)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maven_paths() {
        assert_eq!(
            maven_path("com.mojang:brigadier:1.2.3").unwrap(),
            "com/mojang/brigadier/1.2.3/brigadier-1.2.3.jar"
        );
        assert_eq!(
            maven_path("org.lwjgl:lwjgl:3.3.3:natives-windows").unwrap(),
            "org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar"
        );
        assert_eq!(maven_path("a.b:c:1@zip").unwrap(), "a/b/c/1/c-1.zip");
    }

    #[test]
    fn rules() {
        let allow_all = Rule { action: "allow".into(), os: None, features: None };
        let disallow_here = Rule {
            action: "disallow".into(),
            os: Some(OsRule { name: Some(OS_NAME.into()), arch: None, version: None }),
            features: None,
        };
        assert!(rules_allow(&[allow_all.clone()]));
        assert!(!rules_allow(&[allow_all, disallow_here]));
        let demo = Rule {
            action: "allow".into(),
            os: None,
            features: Some([("is_demo_user".to_string(), true)].into()),
        };
        assert!(!rules_allow(&[demo]));
    }

    #[test]
    fn x86_only_jvm_args_are_skipped_on_x64() {
        let arg: Argument = serde_json::from_str(
            r#"{"rules":[{"action":"allow","os":{"arch":"x86"}}],"value":["-Xss1M","-XX:-UseBASE64Intrinsics"]}"#,
        )
        .unwrap();
        if OS_ARCH == "x86_64" {
            assert!(arg.resolve().is_empty());
        }
    }

    #[test]
    fn native_arch_filter() {
        let lib = |name: &str| Library {
            name: name.into(),
            downloads: None,
            url: None,
            sha1: None,
            size: None,
            natives: None,
            rules: None,
        };
        if OS_ARCH == "x86_64" {
            assert!(lib("org.lwjgl:lwjgl:3.4.3:natives-windows").matches_arch());
            assert!(!lib("org.lwjgl:lwjgl:3.4.3:natives-windows-arm64").matches_arch());
            assert!(!lib("org.lwjgl:lwjgl:3.3.1:natives-windows-x86").matches_arch());
            assert!(lib("org.lwjgl:lwjgl:3.4.3").matches_arch());
        }
    }
}
