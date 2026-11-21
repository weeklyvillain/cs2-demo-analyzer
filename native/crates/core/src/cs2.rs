//! Finding the Counter-Strike 2 install.
//!
//! Ported from cs23d (`renderer-rs/src/game.rs` and `app/src/backend/tools.js`):
//! Steam's install path from the registry, every library listed in
//! `libraryfolders.vdf`, then the usual library folder names on each drive.
//! The Electron app only tried two fixed `C:\` paths.

use std::path::{Path, PathBuf};

use crate::settings::Settings;

const CS2_SUB: &str = "steamapps/common/Counter-Strike Global Offensive";

/// A CS2 install root contains the game's main archive.
pub fn is_install(dir: &Path) -> bool {
    dir.join("game/csgo/pak01_dir.vpk").exists()
}

/// `cs2.exe` inside an install root.
pub fn exe_in(install: &Path) -> PathBuf {
    install.join("game").join("bin").join("win64").join("cs2.exe")
}

/// The install root for a saved `cs2.exe` path (`…/game/bin/win64/cs2.exe` → `…`).
pub fn install_of_exe(exe: &Path) -> Option<PathBuf> {
    exe.ancestors().nth(4).map(Path::to_path_buf).filter(|d| is_install(d))
}

/// Find the CS2 install root. `CS2DA_CS2` overrides the search.
pub fn find_install() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("CS2DA_CS2") {
        return Some(PathBuf::from(dir)).filter(|d| is_install(d));
    }
    candidate_libraries()
        .into_iter()
        .map(|lib| lib.join(CS2_SUB))
        .find(|d| is_install(d))
        .map(|d| clean(&d))
}

/// Steam's registry value uses `/` and a lowercase drive (`c:/program files (x86)/steam`);
/// show and save paths the way Windows writes them.
fn clean(p: &Path) -> PathBuf {
    if !cfg!(windows) {
        return p.to_path_buf();
    }
    // canonicalize gives the on-disk casing (`\\?\C:\Program Files (x86)\Steam\…`).
    if let Ok(real) = std::fs::canonicalize(p) {
        let s = real.to_string_lossy();
        return PathBuf::from(s.strip_prefix(r"\\?\").unwrap_or(&s));
    }
    let s = p.to_string_lossy().replace('/', "\\");
    let mut chars = s.chars();
    match (chars.next(), chars.next()) {
        (Some(d), Some(':')) => PathBuf::from(format!("{}:{}", d.to_ascii_uppercase(), chars.as_str())),
        _ => PathBuf::from(s),
    }
}

/// Path to `cs2.exe`: the saved `cs2_path` setting if it still exists, otherwise the
/// detected install, which is then saved like the Electron app does.
pub fn resolve_exe(settings: Option<&Settings>) -> Option<PathBuf> {
    if let Some(saved) = settings
        .and_then(|s| s.get("cs2_path").ok().flatten())
        .filter(|p| !p.is_empty())
        .map(PathBuf::from)
        .filter(|p| p.exists())
    {
        return Some(saved);
    }
    let exe = exe_in(&find_install()?);
    if !exe.exists() {
        return None;
    }
    if let Some(s) = settings {
        let path = exe.display().to_string();
        let _ = s.set("cs2_path", &path);
        let _ = s.set("cs2ExePath", &path);
    }
    Some(exe)
}

fn candidate_libraries() -> Vec<PathBuf> {
    let mut steams: Vec<PathBuf> = registry_steam_paths();
    steams.push(
        PathBuf::from(std::env::var("ProgramFiles(x86)").unwrap_or_else(|_| r"C:\Program Files (x86)".into()))
            .join("Steam"),
    );

    let mut libs: Vec<PathBuf> = Vec::new();
    let mut add = |p: PathBuf| {
        if !libs.iter().any(|l| same_path(l, &p)) {
            libs.push(p);
        }
    };
    for steam in &steams {
        add(steam.clone());
        let vdf = std::fs::read_to_string(steam.join("steamapps/libraryfolders.vdf")).unwrap_or_default();
        for lib in library_paths(&vdf) {
            add(lib);
        }
    }
    // Default library folder names on other drives.
    for drive in ['C', 'D', 'E', 'F', 'G', 'H'] {
        for name in ["SteamLibrary", "Steam", "Program Files (x86)/Steam", "Games/Steam"] {
            add(PathBuf::from(format!("{drive}:/{name}")));
        }
    }
    libs
}

/// Library roots listed in `libraryfolders.vdf` (`"path"  "D:\\SteamLibrary"`).
fn library_paths(vdf: &str) -> Vec<PathBuf> {
    vdf.lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.split('"').collect();
            (parts.len() >= 4 && parts[1] == "path").then(|| PathBuf::from(parts[3].replace("\\\\", "\\")))
        })
        .collect()
}

fn same_path(a: &Path, b: &Path) -> bool {
    let norm = |p: &Path| p.to_string_lossy().replace('\\', "/").trim_end_matches('/').to_lowercase();
    norm(a) == norm(b)
}

#[cfg(windows)]
fn registry_steam_paths() -> Vec<PathBuf> {
    use winreg::RegKey;
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    [
        (HKEY_CURRENT_USER, r"Software\Valve\Steam", "SteamPath"),
        (HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Valve\Steam", "InstallPath"),
    ]
    .into_iter()
    .filter_map(|(hive, key, value)| RegKey::predef(hive).open_subkey(key).ok()?.get_value::<String, _>(value).ok())
    .map(PathBuf::from)
    .collect()
}

#[cfg(not(windows))]
fn registry_steam_paths() -> Vec<PathBuf> {
    dirs::home_dir()
        .map(|h| vec![h.join(".steam/steam"), h.join(".local/share/Steam")])
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_library_folders() {
        let vdf = "\"libraryfolders\"\n{\n\t\"0\"\n\t{\n\t\t\"path\"\t\t\"C:\\\\Program Files (x86)\\\\Steam\"\n\t}\n\t\"1\"\n\t{\n\t\t\"path\"\t\t\"D:\\\\SteamLibrary\"\n\t}\n}\n";
        assert_eq!(
            library_paths(vdf),
            vec![PathBuf::from(r"C:\Program Files (x86)\Steam"), PathBuf::from(r"D:\SteamLibrary")]
        );
    }

    #[test]
    fn exe_round_trips_to_install() {
        if let Some(install) = find_install() {
            println!("found CS2 at {}", install.display());
            assert_eq!(install_of_exe(&exe_in(&install)).as_deref(), Some(install.as_path()));
        }
    }
}
