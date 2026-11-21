//! Self-update (replaces electron-updater). Unlike Electron, startup never waits on it and
//! nothing installs by itself: when `autoUpdateEnabled` is on (default), a background check
//! reads the release feed, and a newer version only shows an "Update to vX" button in the
//! title bar (and in Settings). Clicking it downloads and verifies the installer, runs it
//! silently and quits; the installer starts the new version. Settings can also install any
//! release by version. The work itself is in `cs2da_core::updater`.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use cs2da_core::updater::{self as core, Update};
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::component::{IconName, h_flex};
use gpui_kit::*;

use crate::i18n::t;
use crate::theme;
use crate::ui;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Clone)]
pub enum Status {
    Idle,
    /// Found by the startup check; nothing downloaded yet.
    Available(Update),
    Downloading { version: String, done: u64, total: u64 },
    /// Verified and handed to the installer; the app is quitting.
    Installing { version: String },
    Failed(String),
}

pub struct Updater {
    pub status: Status,
    cancel: Arc<AtomicBool>,
}

struct GlobalUpdater(Entity<Updater>);
impl Global for GlobalUpdater {}

pub fn init(cx: &mut App) {
    let e = cx.new(|_| Updater { status: Status::Idle, cancel: Arc::new(AtomicBool::new(false)) });
    cx.set_global(GlobalUpdater(e.clone()));
    cx.background_spawn(async { core::clean_downloads() }).detach();
    let enabled = cs2da_core::settings::Settings::open().map_or(true, |s| s.get_or("autoUpdateEnabled", "true") != "false");
    if !enabled || std::env::var_os("CS2DA_NO_UPDATE").is_some() {
        return;
    }
    e.update(cx, |_, cx| {
        cx.spawn(async move |this, cx| {
            let found = cx.background_spawn(async { core::check(VERSION) }).await;
            match found {
                Ok(Some(update)) => {
                    eprintln!("[update] {} available", update.version);
                    this.update(cx, |u, cx| {
                        if matches!(u.status, Status::Idle) {
                            u.status = Status::Available(update);
                            cx.notify();
                        }
                    })
                    .ok();
                }
                Ok(None) => eprintln!("[update] up to date"),
                // Offline or no feed: say nothing, as Electron's splash did after 2 s.
                Err(e) => eprintln!("[update] check failed: {e:#}"),
            }
        })
        .detach();
    });
}

pub fn entity(cx: &App) -> Entity<Updater> {
    cx.global::<GlobalUpdater>().0.clone()
}

pub fn status(cx: &App) -> Status {
    entity(cx).read(cx).status.clone()
}

impl Updater {
    fn busy(&self) -> bool {
        matches!(self.status, Status::Downloading { .. } | Status::Installing { .. })
    }

    /// Download and verify `update`, then run it and quit.
    fn fetch(&mut self, update: Update, cx: &mut Context<Self>) {
        let version = update.version.clone();
        self.status = Status::Downloading { version: version.clone(), done: 0, total: update.size };
        self.cancel = Arc::new(AtomicBool::new(false));
        cx.notify();

        let done = Arc::new(AtomicU64::new(0));
        let finished = Arc::new(AtomicBool::new(false));
        let cancel = self.cancel.clone();
        cx.spawn(async move |this, cx| {
            let task = cx.background_spawn({
                let (done, finished) = (done.clone(), finished.clone());
                async move {
                    let r = core::download(&update, |n, _| {
                        done.store(n, Ordering::Relaxed);
                        !cancel.load(Ordering::Relaxed)
                    });
                    finished.store(true, Ordering::Relaxed);
                    r
                }
            });
            while !finished.load(Ordering::Relaxed) {
                cx.background_executor().timer(Duration::from_millis(200)).await;
                let n = done.load(Ordering::Relaxed);
                let alive = this
                    .update(cx, |u, cx| {
                        if let Status::Downloading { done, .. } = &mut u.status {
                            *done = n;
                            cx.notify();
                        }
                    })
                    .is_ok();
                if !alive {
                    return;
                }
            }
            let result = task.await;
            this.update(cx, |u, cx| {
                match result {
                    Ok(installer) => {
                        eprintln!("[update] installing {version}: {}", installer.display());
                        match core::launch_installer(&installer) {
                            Ok(()) => {
                                u.status = Status::Installing { version };
                                cx.quit();
                            }
                            Err(e) => u.status = Status::Failed(format!("{e:#}")),
                        }
                    }
                    Err(e) => {
                        eprintln!("[update] download failed: {e:#}");
                        u.status = Status::Failed(format!("{e:#}"));
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }
}

/// The title-bar / Settings "Update to vX" button.
pub fn update_now(cx: &mut App) {
    entity(cx).update(cx, |u, cx| {
        if let Status::Available(update) = u.status.clone() {
            u.fetch(update, cx);
        }
    });
}

/// Settings → "Download and Install Version": fetch that release's installer and run it.
pub fn install_version(version: String, cx: &mut App) {
    let e = entity(cx);
    if e.read(cx).busy() {
        return;
    }
    e.update(cx, |u, cx| {
        u.status = Status::Downloading { version: version.clone(), done: 0, total: 0 };
        cx.notify();
        cx.spawn(async move |this, cx| {
            let feed = cx.background_spawn({
                let version = version.clone();
                async move { core::for_version(&version) }
            })
            .await;
            this.update(cx, |u, cx| match feed {
                Ok(update) => u.fetch(update, cx),
                Err(e) => {
                    u.status = Status::Failed(format!("{version}: {e:#}"));
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    });
}

/// Title-bar item: "Update to vX" when the startup check found one, then download progress.
pub fn title_bar_item(cx: &mut App) -> Option<AnyElement> {
    match status(cx) {
        Status::Available(update) => Some(
            ui::button("update-now", format!("{} v{}", t("update.updateTo"), update.version), true)
                .py_0p5()
                .text_xs()
                .child(IconName::ArrowDown)
                .tooltip(|window, cx| Tooltip::new(t("update.updateToDesc")).build(window, cx))
                // Inside the title bar: block its drag area (Windows caption hit test) and
                // keep the press from turning into a window move.
                .occlude()
                .on_mouse_down(MouseButton::Left, |_, window, _| window.prevent_default())
                .on_click(|_, _, cx| update_now(cx))
                .into_any_element(),
        ),
        Status::Downloading { version, done, total } => {
            let pct = if total > 0 { format!(" {}%", done * 100 / total) } else { String::new() };
            Some(
                h_flex()
                    .gap_1()
                    .text_xs()
                    .text_color(theme::text_muted())
                    .child(IconName::ArrowDown)
                    .child(format!("{} v{version}{pct}", t("update.downloading")))
                    .into_any_element(),
            )
        }
        Status::Installing { version } => Some(
            div().text_xs().text_color(theme::text_muted()).child(format!("{} v{version}", t("settings.installing"))).into_any_element(),
        ),
        _ => None,
    }
}
