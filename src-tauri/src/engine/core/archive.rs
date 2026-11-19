//! Распаковка архивов с защитой от zip-slip

use std::fs::File;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};

/// Распаковать ZIP (только пути внутри `dest`)
pub fn extract_zip_sync(archive: &Path, dest: &Path) -> Result<()> {
    let file = File::open(archive).with_context(|| format!("Не открыть {}", archive.display()))?;
    let mut zip = zip::ZipArchive::new(file)?;
    std::fs::create_dir_all(dest)?;

    for i in 0..zip.len() {
        let mut entry = zip.by_index(i)?;
        let Some(relative) = entry.enclosed_name().map(PathBuf::from) else {
            bail!("Опасный путь в архиве: {}", entry.name());
        };
        let out = dest.join(relative);
        if entry.is_dir() {
            std::fs::create_dir_all(&out)?;
            continue;
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut target = File::create(&out)?;
        std::io::copy(&mut entry, &mut target)?;
    }
    Ok(())
}

/// Распаковать tar-поток (tar сам отбрасывает записи с `..` и абсолютными путями)
fn unpack_tar<R: std::io::Read>(reader: R, dest: &Path) -> Result<()> {
    std::fs::create_dir_all(dest)?;
    let mut archive = tar::Archive::new(reader);
    for entry in archive.entries()? {
        let mut entry = entry?;
        if !entry.unpack_in(dest)? {
            bail!("Опасный путь в архиве");
        }
    }
    Ok(())
}

pub async fn extract_zip(archive: &Path, dest: &Path) -> Result<()> {
    let (a, d) = (archive.to_path_buf(), dest.to_path_buf());
    tokio::task::spawn_blocking(move || extract_zip_sync(&a, &d)).await?
}

pub async fn extract_tar_gz(archive: &Path, dest: &Path) -> Result<()> {
    let (a, d) = (archive.to_path_buf(), dest.to_path_buf());
    tokio::task::spawn_blocking(move || {
        unpack_tar(flate2::read::GzDecoder::new(File::open(&a)?), &d)
    })
    .await?
}

pub async fn extract_zstd(archive: &Path, dest: &Path) -> Result<()> {
    let (a, d) = (archive.to_path_buf(), dest.to_path_buf());
    tokio::task::spawn_blocking(move || {
        unpack_tar(zstd::stream::read::Decoder::new(File::open(&a)?)?, &d)
    })
    .await?
}
