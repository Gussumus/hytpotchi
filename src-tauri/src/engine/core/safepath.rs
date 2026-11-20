//! Safe path operations - prevents path traversal attacks
//!
//! All external paths MUST go through these functions.

use std::path::{Path, PathBuf, Component};
use anyhow::{Result, Context, bail};

/// Reserved Windows filenames that cannot be used
const RESERVED_NAMES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL",
    "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
    "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Maximum path length (Windows MAX_PATH)
const MAX_PATH_LEN: usize = 260;

/// Check if a filename is reserved on Windows
fn is_reserved_name(name: &str) -> bool {
    let upper = name.to_uppercase();
    // Check without extension
    let name_no_ext = upper.split('.').next().unwrap_or(&upper);
    RESERVED_NAMES.contains(&name_no_ext)
}

/// Check for control characters in path
fn has_control_chars(s: &str) -> bool {
    s.chars().any(|c| c.is_control() || c == '\u{007F}')
}

/// Normalize path (resolve . and .., remove redundant separators)
fn normalize_path(path: &Path) -> PathBuf {
    let mut components = Vec::new();

    for component in path.components() {
        match component {
            Component::CurDir => {}, // Skip .
            Component::ParentDir => {
                if !components.is_empty() && !matches!(components.last(), Some(Component::RootDir)) {
                    components.pop();
                }
            }
            Component::Normal(name) => {
                if has_control_chars(name.to_string_lossy().as_ref()) {
                    // Skip components with control chars
                    continue;
                }
                components.push(Component::Normal(name));
            }
            Component::RootDir => components.push(Component::RootDir),
            Component::Prefix(p) => components.push(Component::Prefix(p)),
        }
    }

    components.iter().collect()
}

/// Safely join a base path with a user-provided relative path
///
/// # Security
/// - Resolves symlinks in base
/// - Normalizes path
/// - Ensures result stays within base directory
/// - Rejects reserved names, control chars, traversal attempts
pub fn safe_join(base: &Path, user: &str) -> Result<PathBuf> {
    // Empty or root path
    if user.is_empty() || user == "." {
        return Ok(base.to_path_buf());
    }

    // Check for control characters
    if has_control_chars(user) {
        bail!("Path contains control characters");
    }

    // Check length
    if user.len() > MAX_PATH_LEN {
        bail!("Path too long");
    }

    // Canonicalize base to resolve symlinks
    let canonical_base = base.canonicalize()
        .with_context(|| format!("Failed to canonicalize base: {}", base.display()))?;

    // Join and normalize lexically (the target may not exist yet)
    let joined = canonical_base.join(user);
    let normalized = normalize_path(&joined);
    if !normalized.starts_with(&canonical_base) {
        bail!("Path traversal attempt detected");
    }

    // Resolve symlinks of the deepest existing ancestor and re-check containment
    let mut existing = normalized.as_path();
    while !existing.exists() {
        existing = match existing.parent() {
            Some(parent) => parent,
            None => break,
        };
    }
    let resolved = existing.canonicalize()
        .with_context(|| format!("Failed to canonicalize: {}", existing.display()))?;
    if !resolved.starts_with(&canonical_base) {
        bail!("Path traversal attempt detected");
    }
    let rest = normalized.strip_prefix(existing).unwrap_or(Path::new(""));
    let canonical_result = resolved.join(rest);

    // Check each component for reserved names
    for component in canonical_result.components() {
        if let Component::Normal(name) = component {
            let name_str = name.to_string_lossy();
            if is_reserved_name(&name_str) {
                bail!("Reserved filename: {}", name_str);
            }
            if name_str.ends_with('.') || name_str.ends_with(' ') {
                bail!("Invalid filename (trailing dot/space): {}", name_str);
            }
        }
    }

    Ok(canonical_result)
}

/// Safely create a child path within a directory
pub fn safe_child(dir: &Path, name: &str) -> Result<PathBuf> {
    if name.is_empty() {
        bail!("Empty filename");
    }

    if has_control_chars(name) {
        bail!("Filename contains control characters");
    }

    let name_upper = name.to_uppercase();
    let name_no_ext = name_upper.split('.').next().unwrap_or(&name_upper);
    if RESERVED_NAMES.contains(&name_no_ext) {
        bail!("Reserved filename: {}", name);
    }

    if name.ends_with('.') || name.ends_with(' ') {
        bail!("Invalid filename (trailing dot/space)");
    }

    safe_join(dir, name)
}

/// Sanitize a filename (for user-provided filenames)
pub fn safe_file_name(name: &str) -> Result<String> {
    if name.is_empty() {
        bail!("Empty filename");
    }

    if has_control_chars(name) {
        bail!("Filename contains control characters");
    }

    let mut sanitized = String::with_capacity(name.len());
    for c in name.chars() {
        match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => {
                // Replace invalid chars with underscore
                sanitized.push('_');
            }
            c if c.is_control() => {
                // Skip control chars
            }
            c => sanitized.push(c),
        }
    }

    // Trim trailing dots and spaces
    sanitized = sanitized.trim_end_matches('.').trim_end_matches(' ').to_string();

    if sanitized.is_empty() {
        bail!("Filename becomes empty after sanitization");
    }

    let upper = sanitized.to_uppercase();
    let name_no_ext = upper.split('.').next().unwrap_or(&upper);
    if RESERVED_NAMES.contains(&name_no_ext) {
        bail!("Reserved filename: {}", sanitized);
    }

    Ok(sanitized)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_safe_join_normal() {
        let temp = TempDir::new().unwrap();
        let result = safe_join(temp.path(), "subdir/file.txt").unwrap();
        assert!(result.starts_with(temp.path().canonicalize().unwrap()));
        assert!(result.ends_with("subdir/file.txt"));
    }

    #[test]
    fn test_safe_join_traversal() {
        let temp = TempDir::new().unwrap();
        let result = safe_join(temp.path(), "../etc/passwd");
        assert!(result.is_err());
    }

    #[test]
    fn test_safe_join_symlink() {
        // На Windows симлинки без прав администратора не создать — проверка только для unix
        let _temp = TempDir::new().unwrap();
        let _target = TempDir::new().unwrap();

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(_target.path(), _temp.path().join("link")).unwrap();
            let result = safe_join(_temp.path(), "link/../etc/passwd");
            assert!(result.is_err());
        }
    }

    #[test]
    fn test_safe_child_reserved() {
        let temp = TempDir::new().unwrap();
        let result = safe_child(temp.path(), "CON.txt");
        assert!(result.is_err());
    }

    #[test]
    fn test_safe_file_name() {
        assert_eq!(safe_file_name("normal.txt").unwrap(), "normal.txt");
        assert_eq!(safe_file_name("path/traversal.txt").unwrap(), "path_traversal.txt");
        assert_eq!(safe_file_name("CON").is_err(), true);
        assert_eq!(safe_file_name("file..").unwrap(), "file");
    }
}