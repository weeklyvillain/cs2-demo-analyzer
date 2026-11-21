// No console window in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cs2_watch;
mod db_viewer;
mod format;
mod i18n;
mod instance;
mod matches;
#[cfg(windows)]
mod overlay;
mod parsing;
mod ui;
mod settings_screen;
mod shell;
mod stats_screen;
mod theme;
mod toast;
mod watcher;
mod updater;
mod whats_new;
#[cfg(windows)]
mod win_install;
mod unparsed_screen;
mod voice;

use std::sync::OnceLock;
use std::time::Instant;

use gpui_kit::component::TitleBar;
use gpui_kit::*;

/// Process start, for the startup-time log line.
pub static STARTED: OnceLock<Instant> = OnceLock::new();

fn main() {
    STARTED.get_or_init(Instant::now);

    // Installer helper modes (shortcuts carrying the app ID); they exit right away.
    #[cfg(windows)]
    if win_install::run_installer_mode() {
        return;
    }
    // Same AppUserModelID as the Electron app, so existing taskbar pins stay grouped with us.
    #[cfg(windows)]
    win_install::set_app_id();

    // Single instance: a second launch (e.g. double-clicking a .dem) hands its demos to the
    // running app and exits, like Electron's second-instance handler.
    // CS2DA_MULTI_INSTANCE=1 turns this off (for running several test copies side by side).
    let launch = instance::launch_args();
    let single = std::env::var_os("CS2DA_MULTI_INSTANCE").is_none();
    if single && instance::forward_to_running(&launch) {
        return;
    }
    let later_launches = if single { instance::listen() } else { None };

    // The Electron app kept the language in browser localStorage, which we can't read;
    // the native app keeps it in settings.sqlite under `language`.
    if let Ok(settings) = cs2da_core::settings::Settings::open() {
        i18n::set_language(i18n::Language::from_code(&settings.get_or("language", "en")));
    }
    // Electron's startup integrity check: drop unreadable match databases and, when
    // auto_cleanup_missing_demos is on, ones whose demo file is gone.
    for (id, reason) in cs2da_core::matches::startup_integrity_check() {
        eprintln!("[startup] deleted {id}: {reason}");
    }
    // Fill in cs2_path if it's empty or stale, off the UI thread (registry + a few file checks).
    std::thread::spawn(|| {
        let settings = cs2da_core::settings::Settings::open().ok();
        cs2da_core::cs2::resolve_exe(settings.as_ref());
    });

    gpui_kit::application()
        .with_assets(gpui_kit::assets::Assets)
        .run(move |cx| {
            gpui_kit::init(cx);
            theme::apply(cx);
            parsing::init(cx);
            toast::init(cx);
            watcher::init(cx);
            #[cfg(windows)]
            overlay::init(cx);
            whats_new::init(cx);
            updater::init(cx);

            let bounds = Bounds::centered(None, size(px(1400.), px(900.)), cx);
            let options = WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                window_min_size: Some(size(px(960.), px(600.))),
                ..TitleBar::window_options()
            };
            let main_window = gpui_kit::open_window(options, cx, |window, cx| {
                window.set_window_title("CS2 Demo Analyzer");
                cx.new(|cx| shell::Shell::new(window, cx))
            })
            .expect("failed to open the main window");
            cx.activate(true);

            // .dem files the app was launched with (file association / "Open with"), or
            // "Play in CS2" from Explorer's right-click menu.
            handle_launch(launch, cx);
            // ...and ones from later launches: parse them and bring the window to the front.
            if let Some(rx) = later_launches {
                cx.spawn(async move |cx| loop {
                    cx.background_executor().timer(std::time::Duration::from_millis(200)).await;
                    while let Ok(launch) = rx.try_recv() {
                        cx.update(|cx| {
                            handle_launch(launch, cx);
                            cx.activate(true);
                            main_window.0.update(cx, |_, window, _| window.activate_window()).ok();
                        });
                    }
                })
                .detach();
            }
        });
}

/// Act on a launch: play a demo in CS2 (`--play-demo`, no analysis, like Electron's
/// `playDemoInCS2`) or parse the opened demos.
fn handle_launch(launch: instance::Launch, cx: &mut App) {
    if let Some(demo) = launch.play {
        std::thread::spawn(move || {
            if let Err(e) = cs2da_core::cs2_launch::play_demo(&demo) {
                eprintln!("[play-demo] {e:#}");
            }
        });
    }
    parsing::parse_demos(launch.open, cx);
}
