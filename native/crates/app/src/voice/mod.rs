//! Voice chat: per-player playback, team comms and the player details modal.

mod audio;
pub(crate) mod icons;
mod playback;
mod player_modal;
mod team_comms;
mod waveform;

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use gpui_kit::*;

pub use playback::open as open_voice;
pub use player_modal::{View2d, open as open_player};
pub use team_comms::open as open_team;

enum Speakers {
    Loading,
    Ready(HashMap<String, f64>),
    Failed,
}

#[derive(Default)]
struct SpeakerCache(HashMap<PathBuf, Speakers>);
impl Global for SpeakerCache {}

/// Who talked in `demo` (SteamID64 → seconds), from `cs2-voice-extractor --list`.
/// `None` while the scan runs or if it failed; like Electron, callers then leave
/// voice buttons enabled. Windows refresh when the scan finishes.
pub fn speakers(demo: &Path, cx: &mut App) -> Option<HashMap<String, f64>> {
    let cache = cx.default_global::<SpeakerCache>();
    match cache.0.get(demo) {
        Some(Speakers::Ready(map)) => return Some(map.clone()),
        Some(Speakers::Loading | Speakers::Failed) => return None,
        None => {}
    }
    cache.0.insert(demo.to_path_buf(), Speakers::Loading);
    let path = demo.to_path_buf();
    cx.spawn(async move |cx| {
        let scan_path = path.clone();
        let result = cx.background_spawn(async move { cs2da_core::voice::list_speakers(&scan_path) }).await;
        cx.update(|cx| {
            let entry = match result {
                Ok(map) => Speakers::Ready(map),
                Err(_) => Speakers::Failed,
            };
            cx.default_global::<SpeakerCache>().0.insert(path, entry);
            cx.refresh_windows();
        });
    })
    .detach();
    None
}

/// `formatVoiceSeconds` from the Players tab tooltips.
pub fn voice_seconds(secs: f64) -> String {
    if secs >= 60.0 {
        format!("{}m {}s", (secs / 60.0).floor(), (secs % 60.0).round())
    } else {
        format!("{}s", secs.round().max(1.0))
    }
}
