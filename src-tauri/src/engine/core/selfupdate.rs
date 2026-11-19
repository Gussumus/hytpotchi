//! Self-update with minisign verification and delta updates

use anyhow::{Result, Context};
use minisign_verify::{PublicKey, Signature};
use serde::{Deserialize, Serialize};
use crate::engine::core::http::HttpClient;
use tokio::io::AsyncWriteExt;
use sha2::Digest;

/// Update manifest from server
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateManifest {
    pub version: String,
    pub notes: String,
    pub pub_date: String,
    pub platforms: PlatformManifests,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlatformManifests {
    pub windows_x64_msix: Option<ArtifactInfo>,
    pub windows_x64_nsis: Option<ArtifactInfo>,
    pub windows_x64_delta: Option<DeltaInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArtifactInfo {
    pub url: String,
    pub size: u64,
    pub sha256: String,
    pub signature: String, // minisign base64
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeltaInfo {
    pub from_version: String,
    pub url: String,
    pub size: u64,
    pub sha256: String,
    pub signature: String,
}

/// Self-updater with minisign verification
pub struct SelfUpdater {
    client: HttpClient,
    current_version: String,
    public_key: PublicKey,
    update_url: String,
}

impl SelfUpdater {
    /// Create new updater with embedded public key
    pub fn new(current_version: String, public_key_pem: &str, update_url: String) -> Result<Self> {
        let public_key = PublicKey::decode(public_key_pem)
            .context("Invalid minisign public key")?;

        Ok(Self {
            client: HttpClient::new()?,
            current_version,
            public_key,
            update_url,
        })
    }

    /// Check for updates
    pub async fn check_update(&self) -> Result<Option<UpdateManifest>> {
        let url = format!("{}/manifest.json", self.update_url.trim_end_matches('/'));
        let response = self.client.get(&url).await?;

        if !response.status().is_success() {
            return Ok(None);
        }

        let manifest: UpdateManifest = response.json().await?;

        // Compare versions
        if self.is_newer(&manifest.version) {
            Ok(Some(manifest))
        } else {
            Ok(None)
        }
    }

    /// Download and verify update artifact
    pub async fn download_update(
        &self,
        manifest: &UpdateManifest,
        target: &std::path::Path,
    ) -> Result<()> {
        // Prefer delta update if available
        if let Some(delta) = &manifest.platforms.windows_x64_delta {
            if delta.from_version == self.current_version {
                return self.download_and_verify(&delta.url, target, &delta.sha256, &delta.signature).await;
            }
        }

        // Fallback to full installer
        if let Some(artifact) = &manifest.platforms.windows_x64_nsis {
            return self.download_and_verify(&artifact.url, target, &artifact.sha256, &artifact.signature).await;
        }

        if let Some(artifact) = &manifest.platforms.windows_x64_msix {
            return self.download_and_verify(&artifact.url, target, &artifact.sha256, &artifact.signature).await;
        }

        Err(anyhow::anyhow!("No suitable update artifact found"))
    }

    async fn download_and_verify(
        &self,
        url: &str,
        target: &std::path::Path,
        expected_sha256: &str,
        signature_b64: &str,
    ) -> Result<()> {
        // Download to temp file
        let temp_path = target.with_extension("tmp");
        let response = self.client.get(url).await?;

        // Verify SHA256
        let expected_hash = hex::decode(expected_sha256)?;
        let mut hasher = sha2::Sha256::new();
        let mut file = tokio::fs::File::create(&temp_path).await?;

        let mut stream = response.bytes_stream();
        while let Some(chunk) = futures::StreamExt::next(&mut stream).await {
            let chunk = chunk?;
            hasher.update(&chunk);
            tokio::io::AsyncWriteExt::write_all(&mut file, &chunk).await?;
        }
        file.flush().await?;

        let actual_hash = hasher.finalize();
        if actual_hash.as_slice() != expected_hash {
            tokio::fs::remove_file(&temp_path).await.ok();
            return Err(anyhow::anyhow!("SHA256 mismatch"));
        }

        // Verify minisign signature
        let signature = Signature::decode(signature_b64)?;
        let data = tokio::fs::read(&temp_path).await?;

        self.public_key.verify(&data, &signature, true)
            .map_err(|e| anyhow::anyhow!("Minisign verification failed: {}", e))?;

        // Atomic move
        tokio::fs::rename(&temp_path, target).await?;

        Ok(())
    }

    /// Apply delta update (bsdiff)
    pub async fn apply_delta(&self, current_exe: &std::path::Path, delta_path: &std::path::Path, output: &std::path::Path) -> Result<()> {
        // Use bspatch
        let status = tokio::process::Command::new("bspatch")
            .arg(current_exe)
            .arg(output)
            .arg(delta_path)
            .status()
            .await
            .context("Failed to run bspatch")?;

        if !status.success() {
            return Err(anyhow::anyhow!("bspatch failed"));
        }

        Ok(())
    }

    fn is_newer(&self, version: &str) -> bool {
        let current = semver::Version::parse(&self.current_version).ok();
        semver::Version::parse(version).ok()
            .map(|v| current.map(|c| v > c).unwrap_or(true))
            .unwrap_or(false)
    }
}