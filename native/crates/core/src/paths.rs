use std::path::PathBuf;

/// Folder name Electron used for `app.getPath('userData')` (the package.json `name`).
const APP_DIR: &str = "cs-griefer-electron";

/// Root data folder. `CS2DA_DATA_DIR` overrides it (handy for tests).
pub fn data_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("CS2DA_DATA_DIR") {
        return PathBuf::from(dir);
    }
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(APP_DIR)
}

pub fn matches_dir() -> PathBuf {
    data_dir().join("matches")
}

pub fn match_db(match_id: &str) -> PathBuf {
    matches_dir().join(format!("{match_id}.sqlite"))
}

pub fn settings_db() -> PathBuf {
    data_dir().join("settings.sqlite")
}

/// The bundled `resources/` folder (map art, radars, source logos).
///
/// `CS2DA_RESOURCES` overrides it. Otherwise the first `resources/maps` found next to
/// the executable or in one of its parent folders, which covers both an installed
/// app (`<install>/resources`) and `cargo run` (`<repo>/native/target/<profile>/…`).
pub fn resources_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("CS2DA_RESOURCES") {
        return PathBuf::from(dir);
    }
    let exe = std::env::current_exe().unwrap_or_default();
    exe.ancestors()
        .skip(1)
        .map(|dir| dir.join("resources"))
        .find(|dir| dir.join("maps").is_dir())
        .unwrap_or_else(|| PathBuf::from("resources"))
}

/// The bundled helper binaries (`bin/win`, `bin/mac`, `bin/linux`): parser, voice extractor,
/// audiowaveform. Found next to the executable or in a parent folder, like `resources_dir`.
pub fn bin_dir() -> Option<PathBuf> {
    let platform = if cfg!(windows) {
        "win"
    } else if cfg!(target_os = "macos") {
        "mac"
    } else {
        "linux"
    };
    let exe = std::env::current_exe().ok()?;
    exe.ancestors()
        .skip(1)
        .flat_map(|dir| [dir.join("bin").join(platform), dir.join("resources").join("bin").join(platform)])
        .find(|dir| dir.is_dir())
}

/// Card art for a map, falling back to `unknown_map.png`.
pub fn map_thumbnail(map: &str) -> PathBuf {
    let maps = resources_dir().join("maps");
    let path = maps.join(format!("{}.png", map.to_lowercase()));
    if path.exists() { path } else { maps.join("unknown_map.png") }
}

/// Logo for a match source (faceit, esea, valve, …), if there is one.
pub fn source_icon(source: &str) -> Option<PathBuf> {
    let file = match source.to_lowercase().as_str() {
        "faceit" => "faceit-white.png",
        "cevo" => "cevo-white.png",
        "challengermode" => "challengermode.png",
        "esl" => "esl-white.png",
        "ebot" => "ebot.png",
        "esea" => "esea-white.png",
        "popflash" => "popflash-white.png",
        "esportal" => "esportal-white.png",
        "fastcup" => "fastcup-white.png",
        "gamersclub" => "gamersclub-white.png",
        "renown" => "renown-white.png",
        "matchzy" => "matchzy.png",
        "valve" => "valve-white.png",
        "perfectworld" => "perfectworld-white.png",
        "5eplay" => "5eplay.png",
        "esplay" => "esplay.png",
        _ => return None,
    };
    Some(resources_dir().join("sources").join(file))
}
