//! Self-update from GitHub releases, using the same `latest.yml` feed the Electron updater
//! reads (written by `native/installer/build.py`, or by electron-builder for 1.0.x).
//!
//! Flow: [`check`] reads the feed → [`download`] fetches the installer next to it and checks
//! its size and SHA-512 → [`launch_installer`] runs it the way electron-updater did
//! (`--updated /S --force-run`); the caller then quits so the installer can replace the exe.
//! Blocking; call off the UI thread. Requests carry no user data.
//!
//! `CS2DA_UPDATE_FEED` points the feed somewhere else for testing: a folder holding
//! `latest.yml` and the installer, or a URL prefix.

use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context as _, Result, bail};
use base64::Engine as _;
use sha2::{Digest, Sha512};

const RELEASES: &str = "https://github.com/weeklyvillain/cs2-demo-analyzer/releases";

/// One entry of `latest.yml`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Update {
    pub version: String,
    /// Installer file name (also its name in the release / feed folder).
    pub file: String,
    /// Base64 SHA-512, as electron-builder writes it.
    pub sha512: String,
    pub size: u64,
    /// Where the feed lives (URL prefix ending in `/`, or a local folder).
    source: Source,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Source {
    Url(String),
    Dir(PathBuf),
}

fn agent(timeout: Duration) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        .user_agent("CS2-Demo-Analyzer")
        .build()
        .new_agent()
}

/// Feed for the latest release, or for one `version` (any release, also Electron ones).
fn source(version: Option<&str>) -> Source {
    if let Ok(feed) = std::env::var("CS2DA_UPDATE_FEED") {
        let path = PathBuf::from(&feed);
        if path.is_dir() {
            return Source::Dir(path);
        }
        return Source::Url(if feed.ends_with('/') { feed } else { format!("{feed}/") });
    }
    match version {
        None => Source::Url(format!("{RELEASES}/latest/download/")),
        Some(v) => Source::Url(format!("{RELEASES}/download/v{}/", v.trim_start_matches('v'))),
    }
}

/// Parse electron-builder's `latest.yml` (flat keys; the top-level `path`/`sha512` describe
/// the installer, `files[0]` has its size).
pub fn parse_feed(text: &str) -> Option<(String, String, String, u64)> {
    let mut version = None;
    let mut path = None;
    let mut sha = None;
    let mut size = None;
    for line in text.lines() {
        let top = !line.starts_with(' ');
        let line = line.trim().trim_start_matches("- ");
        let Some((key, value)) = line.split_once(':') else { continue };
        let value = value.trim().trim_matches('\'').trim_matches('"').to_string();
        match (top, key.trim()) {
            (true, "version") => version = Some(value),
            (true, "path") => path = Some(value),
            (true, "sha512") => sha = Some(value),
            (false, "size") if size.is_none() => size = value.parse().ok(),
            (false, "url") if path.is_none() => path = Some(value),
            (false, "sha512") if sha.is_none() => sha = Some(value),
            _ => {}
        }
    }
    Some((version?, path?, sha?, size.unwrap_or(0)))
}

fn read_feed(source: Source) -> Result<Update> {
    let text = match &source {
        Source::Dir(dir) => std::fs::read_to_string(dir.join("latest.yml")).context("read latest.yml")?,
        Source::Url(base) => agent(Duration::from_secs(15))
            .get(&format!("{base}latest.yml"))
            .call()
            .context("fetch latest.yml")?
            .body_mut()
            .read_to_string()?,
    };
    let (version, file, sha512, size) = parse_feed(&text).context("latest.yml has no version/path/sha512")?;
    if file.contains(['/', '\\']) || !file.to_ascii_lowercase().ends_with(".exe") {
        bail!("unexpected installer name in latest.yml: {file}");
    }
    Ok(Update { version: version.trim_start_matches('v').to_string(), file, sha512, size, source })
}

/// The latest release, when it is newer than `current`.
pub fn check(current: &str) -> Result<Option<Update>> {
    let update = read_feed(source(None))?;
    Ok((crate::releases::compare_versions(&update.version, current) == std::cmp::Ordering::Greater)
        .then_some(update))
}

/// A specific release (Settings → "Download and Install Version").
pub fn for_version(version: &str) -> Result<Update> {
    read_feed(source(Some(version)))
}

/// `%LOCALAPPDATA%\cs2-demo-analyzer-updater`.
fn download_dir() -> PathBuf {
    dirs::data_local_dir().unwrap_or_else(std::env::temp_dir).join("cs2-demo-analyzer-updater")
}

fn sha512_of(path: &Path) -> Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha512::new();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(base64::engine::general_purpose::STANDARD.encode(hasher.finalize()))
}

/// Download the installer (reusing an earlier, verified download) and check it against the
/// feed. `progress(done, total)` is called as bytes arrive; return false from it to cancel.
pub fn download(update: &Update, mut progress: impl FnMut(u64, u64) -> bool) -> Result<PathBuf> {
    let dir = download_dir();
    std::fs::create_dir_all(&dir)?;
    let target = dir.join(&update.file);
    if target.exists() && sha512_of(&target).is_ok_and(|h| h == update.sha512) {
        return Ok(target);
    }
    // Only the installer being fetched lives here.
    for entry in std::fs::read_dir(&dir)?.flatten() {
        let _ = std::fs::remove_file(entry.path());
    }

    let partial = dir.join(format!("{}.part", update.file));
    let mut reader: Box<dyn Read> = match &update.source {
        Source::Dir(feed) => Box::new(File::open(feed.join(&update.file)).context("open installer")?),
        Source::Url(base) => Box::new(
            agent(Duration::from_secs(30 * 60))
                .get(&format!("{base}{}", update.file))
                .call()
                .context("download installer")?
                .into_body()
                .into_reader(),
        ),
    };
    let mut out = File::create(&partial)?;
    let mut hasher = Sha512::new();
    let mut buf = vec![0u8; 1 << 16];
    let mut done = 0u64;
    loop {
        let n = reader.read(&mut buf).context("download installer")?;
        if n == 0 {
            break;
        }
        out.write_all(&buf[..n])?;
        hasher.update(&buf[..n]);
        done += n as u64;
        if !progress(done, update.size) {
            drop(out);
            let _ = std::fs::remove_file(&partial);
            bail!("cancelled");
        }
    }
    out.flush()?;
    drop(out);

    let hash = base64::engine::general_purpose::STANDARD.encode(hasher.finalize());
    if (update.size != 0 && done != update.size) || hash != update.sha512 {
        let _ = std::fs::remove_file(&partial);
        bail!("the downloaded installer doesn't match latest.yml (size {done}, expected {})", update.size);
    }
    std::fs::rename(&partial, &target)?;
    Ok(target)
}

/// Remove downloaded installers. Called on startup: by then the installer that started this
/// version has finished (if it's still running, its file is locked and stays until next time).
pub fn clean_downloads() {
    if let Ok(entries) = std::fs::read_dir(download_dir()) {
        for entry in entries.flatten() {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Start the installer detached, as electron-updater did. The app must quit right after:
/// the installer waits for the exe to be released.
pub fn launch_installer(installer: &Path) -> Result<()> {
    let mut cmd = std::process::Command::new(installer);
    cmd.args(["--updated", "/S", "--force-run"]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    cmd.spawn().with_context(|| format!("start {}", installer.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{Source, Update, parse_feed, sha512_of};
    use std::path::PathBuf;

    #[test]
    fn rejects_tampered_installer() {
        let feed = std::env::temp_dir().join(format!("cs2da-feed-{}", std::process::id()));
        std::fs::create_dir_all(&feed).unwrap();
        let file = "CS2-Demo-Analyzer-Setup-9.9.9.exe";
        std::fs::write(feed.join(file), b"real installer").unwrap();
        let good = sha512_of(&feed.join(file)).unwrap();
        let update = |sha512: String| Update {
            version: "9.9.9".into(),
            file: file.into(),
            sha512,
            size: 14,
            source: Source::Dir(PathBuf::from(&feed)),
        };
        assert!(super::download(&update("AAAA".into()), |_, _| true).is_err());
        let path = super::download(&update(good), |_, _| true).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"real installer");
        super::clean_downloads();
        let _ = std::fs::remove_dir_all(feed);
    }

    #[test]
    fn parses_electron_builder_feed() {
        let yml = "version: 1.0.72\nfiles:\n  - url: CS2-Demo-Analyzer-Setup-1.0.72.exe\n    sha512: abc==\n    size: 136193966\npath: CS2-Demo-Analyzer-Setup-1.0.72.exe\nsha512: abc==\nreleaseDate: '2026-11-17T17:29:42.696Z'\n";
        assert_eq!(
            parse_feed(yml),
            Some(("1.0.72".into(), "CS2-Demo-Analyzer-Setup-1.0.72.exe".into(), "abc==".into(), 136193966))
        );
    }
}
