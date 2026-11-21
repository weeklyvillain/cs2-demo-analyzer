//! Watches the demo folders for `.dem` files appearing or disappearing (Electron
//! `setupDemoFolderWatcher`: non-recursive, 2 s debounce per file) so the Unparsed
//! Demos page refreshes on its own.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::mpsc::{Receiver, channel};
use std::time::{Duration, Instant};

use gpui_kit::*;
use notify::{RecursiveMode, Watcher as _};

const DEBOUNCE: Duration = Duration::from_secs(2);

pub enum DemoFolderEvent {
    /// A `.dem` was added or removed in a watched folder.
    Changed,
}

pub struct DemoWatcher {
    _watcher: Option<notify::RecommendedWatcher>,
    _poll: Option<Task<()>>,
}

impl EventEmitter<DemoFolderEvent> for DemoWatcher {}

struct GlobalWatcher(Entity<DemoWatcher>);
impl Global for GlobalWatcher {}

pub fn init(cx: &mut App) {
    let w = cx.new(|cx| {
        let mut w = DemoWatcher { _watcher: None, _poll: None };
        w.watch_configured(cx);
        w
    });
    cx.set_global(GlobalWatcher(w));
}

pub fn entity(cx: &App) -> Entity<DemoWatcher> {
    cx.global::<GlobalWatcher>().0.clone()
}

/// Re-read `demo_folders` and watch those folders (Settings calls this after a change).
pub fn rewatch(cx: &mut App) {
    entity(cx).update(cx, |w, cx| w.watch_configured(cx));
}

impl DemoWatcher {
    fn watch_configured(&mut self, cx: &mut Context<Self>) {
        let folders: Vec<PathBuf> = cs2da_core::settings::Settings::open()
            .map(|s| s.demo_folders())
            .unwrap_or_default()
            .into_iter()
            .map(PathBuf::from)
            .filter(|f| f.is_dir())
            .collect();
        self._watcher = None;
        self._poll = None;
        if folders.is_empty() {
            return;
        }
        let (tx, rx) = channel::<PathBuf>();
        let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if let Ok(event) = res {
                for path in event.paths {
                    if path.extension().is_some_and(|e| e.eq_ignore_ascii_case("dem")) {
                        let _ = tx.send(path);
                    }
                }
            }
        });
        let Ok(mut watcher) = watcher else { return };
        for folder in &folders {
            let _ = watcher.watch(folder, RecursiveMode::NonRecursive);
        }
        self._watcher = Some(watcher);
        self._poll = Some(cx.spawn(async move |this, cx| poll(rx, this, cx).await));
    }
}

/// Collect file events and emit once a file has been quiet for the debounce period,
/// so a demo that's still being written isn't reported until it's done.
async fn poll(rx: Receiver<PathBuf>, this: WeakEntity<DemoWatcher>, cx: &mut AsyncApp) {
    let mut pending: HashMap<PathBuf, Instant> = HashMap::new();
    loop {
        cx.background_executor().timer(Duration::from_millis(250)).await;
        while let Ok(path) = rx.try_recv() {
            pending.insert(path, Instant::now());
        }
        let before = pending.len();
        pending.retain(|_, at| at.elapsed() < DEBOUNCE);
        if pending.len() < before && this.update(cx, |_, cx| cx.emit(DemoFolderEvent::Changed)).is_err() {
            break;
        }
    }
}
