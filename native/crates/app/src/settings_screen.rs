//! Settings screen (Electron `SettingsScreen`). Every value lives in `settings.sqlite`
//! under the same keys the Electron app uses, so both apps share one configuration.

use std::collections::HashMap;

use cs2da_core::matches::{self, StorageUsage};
use cs2da_core::settings::Settings;
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::switch::Switch;
use gpui_kit::component::{IconName, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::i18n::{self, Language, t};
use crate::theme;
use crate::ui;
use gpui_kit::component::scroll::ScrollableElement as _;

/// Defaults for every key this screen shows, as in Electron's initial `settings` state.
const DEFAULTS: &[(&str, &str)] = &[
    ("cs2_path", ""),
    ("auto_cleanup_missing_demos", "true"),
    ("match_cap_enabled", "false"),
    ("match_cap_value", "10"),
    ("enable_db_viewer", "false"),
    ("default_afk_threshold", "10"),
    ("default_flash_threshold", "1.5"),
    ("default_sort_field", "date"),
    ("default_sort_direction", "desc"),
    ("voice_skip_time", "10"),
    ("position_extraction_interval", "4"),
    ("parallel_parsing_enabled", "false"),
    ("parallel_parsing_count", "2"),
    ("debugMode", "false"),
    ("overlayEnabled", "false"),
    ("autoplayAfterSpectate", "true"),
    ("language", "en"),
    ("autoUpdateEnabled", "true"),
];

pub struct SettingsScreen {
    store: Option<Settings>,
    values: HashMap<String, String>,
    demo_folders: Vec<String>,
    cs2_path: Entity<InputState>,
    storage: StorageUsage,
    confirm_delete_all: bool,
    notice: Option<(String, bool)>,
    /// Releases for "Download and Install Version"; None while loading.
    versions: Option<Vec<String>>,
    picked_version: Option<String>,
    _subscriptions: Vec<Subscription>,
}

impl SettingsScreen {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let store = Settings::open().ok();
        let mut values: HashMap<String, String> =
            DEFAULTS.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        if let Some(store) = &store {
            for (k, v) in values.iter_mut() {
                if let Ok(Some(saved)) = store.get(k) {
                    *v = saved;
                }
            }
        }
        let demo_folders = store.as_ref().map(|s| s.demo_folders()).unwrap_or_default();

        let initial_path = values["cs2_path"].clone();
        let cs2_path = cx.new(|cx| {
            let mut state = InputState::new(window, cx).placeholder(
                "C:\\Program Files\\Steam\\steamapps\\common\\Counter-Strike Global Offensive\\game\\bin\\win64\\cs2.exe",
            );
            state.set_value(initial_path, window, cx);
            state
        });
        // Electron saves the path when the field loses focus, to both keys.
        let sub = cx.subscribe(&cs2_path, |this, input, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Blur) {
                let value = input.read(cx).value().to_string();
                this.set("cs2_path", value.clone(), cx);
                this.set("cs2ExePath", value, cx);
            }
        });

        cx.spawn(async move |this, cx| {
            let versions = cx.background_spawn(async { cs2da_core::releases::available_versions() }).await;
            this.update(cx, |s, cx| {
                s.versions = Some(versions);
                cx.notify();
            })
            .ok();
        })
        .detach();
        let updater_sub = cx.observe(&crate::updater::entity(cx), |_, _, cx| cx.notify());

        Self {
            store,
            values,
            demo_folders,
            cs2_path,
            storage: matches::storage_usage(),
            confirm_delete_all: false,
            notice: None,
            versions: None,
            picked_version: None,
            _subscriptions: vec![sub, updater_sub],
        }
    }

    fn get(&self, key: &str) -> &str {
        self.values.get(key).map_or("", String::as_str)
    }

    fn flag(&self, key: &str) -> bool {
        self.get(key) == "true"
    }

    fn set(&mut self, key: &str, value: String, cx: &mut Context<Self>) {
        if let Some(store) = &self.store {
            if let Err(e) = store.set(key, &value) {
                self.notice = Some((format!("Couldn't save {key}: {e}"), true));
            }
        }
        self.values.insert(key.to_string(), value);
        self.after_change(key, cx);
        cx.notify();
    }

    /// Side effects Electron runs when certain settings change.
    fn after_change(&mut self, key: &str, cx: &mut Context<Self>) {
        match key {
            "language" => {
                i18n::set_language(Language::from_code(self.get("language")));
                cx.refresh_windows();
            }
            "match_cap_enabled" | "match_cap_value" if self.flag("match_cap_enabled") => {
                let cap: usize = self.get("match_cap_value").parse().unwrap_or(10).max(1);
                match matches::trim_to_cap(cap) {
                    Ok(deleted) if !deleted.is_empty() => {
                        self.notice = Some((format!("Deleted {} old matches to stay under the limit", deleted.len()), false));
                        self.storage = matches::storage_usage();
                    }
                    Ok(_) => {}
                    Err(e) => self.notice = Some((format!("Couldn't apply match limit: {e}"), true)),
                }
            }
            _ => {}
        }
    }

    fn browse_cs2(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let picked = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: None,
        });
        cx.spawn_in(window, async move |this, cx| {
            if let Ok(Ok(Some(paths))) = picked.await {
                if let Some(path) = paths.first() {
                    let path = path.display().to_string();
                    this.update_in(cx, |this, window, cx| {
                        this.cs2_path.update(cx, |s, cx| s.set_value(path.clone(), window, cx));
                        this.set("cs2_path", path.clone(), cx);
                        this.set("cs2ExePath", path, cx);
                    })
                    .ok();
                }
            }
        })
        .detach();
    }

    /// Search Steam's libraries for CS2 (`cs2da_core::cs2`, ported from cs23d).
    fn detect_cs2(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let found = cs2da_core::cs2::find_install()
            .map(|dir| cs2da_core::cs2::exe_in(&dir))
            .filter(|exe| exe.exists());
        match found {
            Some(exe) => {
                let path = exe.display().to_string();
                self.cs2_path.update(cx, |s, cx| s.set_value(path.clone(), window, cx));
                self.set("cs2_path", path.clone(), cx);
                self.set("cs2ExePath", path.clone(), cx);
                self.notice = Some((format!("Found CS2: {path}"), false));
            }
            None => {
                self.notice = Some((
                    "Couldn't find CS2 in any Steam library. Use Browse to pick cs2.exe.".into(),
                    true,
                ));
            }
        }
        cx.notify();
    }

    fn add_demo_folder(&mut self, cx: &mut Context<Self>) {
        let picked = cx.prompt_for_paths(PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some("Select a demo folder to add".into()),
        });
        cx.spawn(async move |this, cx| {
            if let Ok(Ok(Some(paths))) = picked.await {
                if let Some(folder) = paths.first() {
                    let folder = folder.display().to_string();
                    this.update(cx, |this, cx| {
                        if !this.demo_folders.contains(&folder) {
                            this.demo_folders.push(folder);
                            this.save_demo_folders(cx);
                        }
                    })
                    .ok();
                }
            }
        })
        .detach();
    }

    fn save_demo_folders(&mut self, cx: &mut Context<Self>) {
        if let Some(store) = &self.store {
            let _ = store.set_demo_folders(&self.demo_folders);
        }
        crate::watcher::rewatch(cx);
        cx.notify();
    }

    // ---------- building blocks ----------

    fn section(title: String) -> Div {
        v_flex()
            .gap_4()
            .p_6()
            .rounded_lg()
            .bg(theme::secondary())
            .border_1()
            .border_color(theme::border())
            .child(div().text_lg().font_weight(FontWeight::SEMIBOLD).child(title))
    }

    fn label_block(label: String, desc: Option<String>) -> Div {
        v_flex()
            .flex_1()
            .min_w_0()
            .gap_1()
            .child(div().text_sm().font_weight(FontWeight::MEDIUM).text_color(theme::text_soft()).child(label))
            .when_some(desc, |d, desc| d.child(div().text_xs().text_color(rgb(0x6b7280)).child(desc)))
    }

    fn toggle(&self, key: &'static str, label: String, desc: String, cx: &mut Context<Self>) -> impl IntoElement {
        let checked = self.flag(key);
        let entity = cx.entity();
        h_flex()
            .gap_4()
            .items_center()
            .child(Self::label_block(label, Some(desc)))
            .child(Switch::new(key).checked(checked).on_click(move |value, _, cx| {
                let value = *value;
                entity.update(cx, |this, cx| this.set(key, value.to_string(), cx));
            }))
    }

    /// Number with −/+ buttons (Electron uses number inputs with the same bounds).
    #[allow(clippy::too_many_arguments)]
    fn stepper(
        &self,
        key: &'static str,
        label: String,
        desc: Option<String>,
        step: f64,
        min: f64,
        max: f64,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let value: f64 = self.get(key).parse().unwrap_or(min);
        let decimals = if step.fract() == 0.0 { 0 } else { 1 };
        let shown = format!("{value:.decimals$}");
        let mk = |id: &'static str, icon: IconName, delta: f64, cx: &mut Context<Self>| {
            div()
                .id(SharedString::from(format!("{key}-{id}")))
                .px_2()
                .py_1()
                .cursor_pointer()
                .text_color(theme::text_muted())
                .hover(|s| s.text_color(theme::accent()))
                .child(icon)
                .on_click(cx.listener(move |this, _, _, cx| {
                    let current: f64 = this.get(key).parse().unwrap_or(min);
                    let next = ((current + delta) / step).round() * step;
                    let next = next.clamp(min, max);
                    this.set(key, format!("{next:.decimals$}"), cx);
                }))
        };
        v_flex()
            .gap_2()
            .child(Self::label_block(label, desc))
            .child(
                h_flex()
                    .w(px(160.))
                    .items_center()
                    .justify_between()
                    .rounded_md()
                    .bg(theme::primary())
                    .border_1()
                    .border_color(theme::border())
                    .child(mk("dec", IconName::Minus, -step, cx))
                    .child(div().text_sm().child(shown))
                    .child(mk("inc", IconName::Plus, step, cx)),
            )
    }

    /// One-of-several picker shown as segmented buttons (Electron uses `<select>`).
    fn choice(
        &self,
        key: &'static str,
        options: Vec<(&'static str, String)>,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let current = self.get(key).to_string();
        h_flex().gap_1().flex_wrap().children(options.into_iter().map(|(value, label)| {
            let active = current == value;
            div()
                .id(SharedString::from(format!("{key}={value}")))
                .px_3()
                .py_1p5()
                .rounded_md()
                .text_sm()
                .cursor_pointer()
                .border_1()
                .when(active, |d| d.bg(theme::accent()).border_color(theme::accent()).text_color(theme::text()))
                .when(!active, |d| {
                    d.bg(theme::primary())
                        .border_color(theme::border())
                        .text_color(theme::text_soft())
                        .hover(|s| s.border_color(theme::accent()))
                })
                .child(label)
                .on_click(cx.listener(move |this, _, _, cx| this.set(key, value.to_string(), cx)))
        }))
    }

    // ---------- sections ----------

    fn cs2_section(&self, cx: &mut Context<Self>) -> impl IntoElement {
        Self::section(t("settings.cs2Config")).child(
            v_flex()
                .gap_2()
                .child(Self::label_block(t("settings.cs2Path"), None))
                .child(
                    h_flex()
                        .gap_2()
                        .child(div().flex_1().child(Input::new(&self.cs2_path)))
                        .child(
                            ui::button("detect-cs2", "Detect", false)
                                .on_click(cx.listener(|this, _, window, cx| this.detect_cs2(window, cx))),
                        )
                        .child(
                            ui::button("browse-cs2", "Browse", false)
                                .on_click(cx.listener(|this, _, window, cx| this.browse_cs2(window, cx))),
                        ),
                )
                .child(div().text_xs().text_color(rgb(0x6b7280)).child(t("settings.cs2PathDesc"))),
        )
    }

    fn demo_folders_section(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let folders = self.demo_folders.clone();
        Self::section(t("settings.demoFolders"))
            .child(
                h_flex()
                    .gap_4()
                    .child(Self::label_block(t("settings.demoFoldersDesc"), None))
                    .child(
                        ui::button("add-folder", format!("+ {}", t("settings.addFolder")), true)
                            .on_click(cx.listener(|this, _, _, cx| this.add_demo_folder(cx))),
                    ),
            )
            .when(folders.is_empty(), |d| {
                d.child(div().text_sm().text_color(rgb(0x6b7280)).child(t("settings.noDemoFoldersSelected")))
            })
            .when(!folders.is_empty(), |d| {
                d.child(div().text_sm().text_color(theme::text_muted()).child(format!("{}:", t("settings.watchedFolders"))))
                    .children(folders.into_iter().enumerate().map(|(i, folder)| {
                        let remove = folder.clone();
                        h_flex()
                            .justify_between()
                            .gap_2()
                            .px_3()
                            .py_2()
                            .rounded_md()
                            .bg(theme::primary())
                            .border_1()
                            .border_color(theme::border())
                            .text_sm()
                            .child(div().truncate().child(folder))
                            .child(
                                ui::icon_button(SharedString::from(format!("rm-folder-{i}")), IconName::Close)
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        this.demo_folders.retain(|f| f != &remove);
                                        this.save_demo_folders(cx);
                                    })),
                            )
                    }))
            })
    }

    fn parsing_section(&self, cx: &mut Context<Self>) -> impl IntoElement {
        Self::section(t("settings.parsingSettings"))
            .child(
                v_flex()
                    .gap_2()
                    .child(Self::label_block(t("settings.positionExtractionFrequency"), Some(t("settings.positionExtractionDesc"))))
                    .child(self.choice(
                        "position_extraction_interval",
                        vec![
                            ("1", t("settings.positionExtractionAll")),
                            ("2", t("settings.positionExtractionHalf")),
                            ("4", t("settings.positionExtractionQuarter")),
                        ],
                        cx,
                    )),
            )
            .child(self.toggle(
                "parallel_parsing_enabled",
                t("settings.parallelParsing"),
                t("settings.parallelParsingDesc"),
                cx,
            ))
            .when(self.flag("parallel_parsing_enabled"), |d| {
                d.child(self.stepper(
                    "parallel_parsing_count",
                    t("settings.parallelParsingCount"),
                    Some(t("settings.parallelParsingCountDesc")),
                    1.0,
                    1.0,
                    8.0,
                    cx,
                ))
            })
    }

    fn display_section(&self, cx: &mut Context<Self>) -> impl IntoElement {
        Self::section(t("settings.displaySettings"))
            .child(self.stepper(
                "default_afk_threshold",
                t("settings.defaultAfkThreshold"),
                Some(t("settings.defaultAfkThresholdDesc")),
                0.5,
                0.0,
                300.0,
                cx,
            ))
            .child(self.stepper(
                "default_flash_threshold",
                t("settings.defaultFlashThreshold"),
                Some(t("settings.defaultFlashThresholdDesc")),
                0.1,
                0.0,
                60.0,
                cx,
            ))
            .child(
                v_flex()
                    .gap_2()
                    .child(Self::label_block(t("settings.defaultMatchSort"), Some(t("settings.defaultMatchSortDesc"))))
                    .child(
                        h_flex()
                            .gap_4()
                            .child(self.choice(
                                "default_sort_field",
                                vec![
                                    ("date", t("settings.date")),
                                    ("id", t("settings.id")),
                                    ("length", t("settings.length")),
                                    ("map", t("settings.map")),
                                ],
                                cx,
                            ))
                            .child(self.choice(
                                "default_sort_direction",
                                vec![("asc", t("settings.ascending")), ("desc", t("settings.descending"))],
                                cx,
                            )),
                    ),
            )
            .child(self.stepper(
                "voice_skip_time",
                t("settings.voicePlaybackSkipTime"),
                Some(t("settings.voicePlaybackSkipTimeDesc")),
                0.5,
                0.5,
                60.0,
                cx,
            ))
    }

    fn storage_section(&self, cx: &mut Context<Self>) -> impl IntoElement {
        Self::section(t("settings.storageSettings"))
            .child(self.toggle(
                "auto_cleanup_missing_demos",
                t("settings.cleanupMissingDemos"),
                t("settings.cleanupMissingDemosDesc"),
                cx,
            ))
            .child(self.toggle("match_cap_enabled", t("settings.limitMatches"), t("settings.limitMatchesDesc"), cx))
            .when(self.flag("match_cap_enabled"), |d| {
                d.child(self.stepper("match_cap_value", t("settings.maxMatches"), None, 1.0, 1.0, 1000.0, cx))
            })
    }

    fn overlay_section(&self, cx: &mut Context<Self>) -> impl IntoElement {
        // Same switches as `toggle`, but they also tell the overlay (Electron closes it when
        // disabled and shows the command log right away in debug mode).
        let overlay_switch = |key: &'static str, label: String, desc: String, cx: &mut Context<Self>| {
            let entity = cx.entity();
            h_flex()
                .gap_4()
                .items_center()
                .child(Self::label_block(label, Some(desc)))
                .child(Switch::new(key).checked(self.flag(key)).on_click(move |value, _, cx| {
                    let value = *value;
                    entity.update(cx, |this, cx| this.set(key, value.to_string(), cx));
                    #[cfg(windows)]
                    match key {
                        "overlayEnabled" => crate::overlay::set_enabled(value, cx),
                        _ => crate::overlay::set_debug_mode(value, cx),
                    }
                }))
        };
        // Electron treats anything but "false" as enabled for this one key.
        let section = Self::section(t("settings.overlaySettings"))
            .child(overlay_switch("overlayEnabled", t("settings.enableOverlay"), t("settings.enableOverlayDesc"), cx));
        #[cfg(windows)]
        let section = section.child(crate::overlay::hotkey_settings(cx));
        section.child(overlay_switch("debugMode", t("settings.debugMode"), t("settings.debugModeDesc"), cx))
    }

    fn playback_section(&self, cx: &mut Context<Self>) -> impl IntoElement {
        Self::section(t("settings.playbackSettings")).child(self.toggle(
            "autoplayAfterSpectate",
            t("settings.autoplayAfterSpectate"),
            t("settings.autoplayAfterSpectateDesc"),
            cx,
        ))
    }

    fn language_section(&self, cx: &mut Context<Self>) -> impl IntoElement {
        Self::section(t("settings.language")).child(
            v_flex()
                .gap_2()
                .child(Self::label_block(t("settings.language"), Some(t("settings.languageDesc"))))
                .child(self.choice(
                    "language",
                    vec![("en", t("settings.english")), ("sv", t("settings.swedish"))],
                    cx,
                )),
        )
    }

    fn advanced_section(&self, cx: &mut Context<Self>) -> impl IntoElement {
        Self::section(t("settings.advanced")).child(self.toggle(
            "enable_db_viewer",
            t("settings.enableDbViewer"),
            t("settings.enableDbViewerDesc"),
            cx,
        ))
    }

    fn danger_section(&self, cx: &mut Context<Self>) -> impl IntoElement {
        v_flex()
            .gap_4()
            .p_6()
            .rounded_lg()
            .bg(theme::secondary())
            .border_1()
            .border_color(rgba(0xef44447f))
            .child(div().text_lg().font_weight(FontWeight::SEMIBOLD).text_color(rgb(0xf87171)).child(t("settings.dangerZone")))
            .child(
                h_flex()
                    .gap_4()
                    .child(Self::label_block(t("settings.deleteAllMatches"), Some(t("settings.deleteAllMatchesDesc"))))
                    .child(
                        div()
                            .id("delete-all")
                            .px_4()
                            .py_2()
                            .rounded_md()
                            .bg(rgb(0xdc2626))
                            .hover(|s| s.bg(rgb(0xb91c1c)))
                            .text_sm()
                            .font_weight(FontWeight::MEDIUM)
                            .cursor_pointer()
                            .child(t("settings.deleteAllMatches"))
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.confirm_delete_all = true;
                                cx.notify();
                            })),
                    ),
            )
    }

    fn app_info(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let row = |label: String, value: String| {
            h_flex()
                .justify_between()
                .gap_4()
                .text_sm()
                .child(div().text_color(theme::text_muted()).child(label))
                .child(div().text_color(theme::text_soft()).child(value))
        };
        let s = &self.storage;
        let total = s.match_bytes + s.settings_bytes;
        Self::section(t("settings.appInfo"))
            .child(row(t("settings.version"), env!("CARGO_PKG_VERSION").to_string()))
            .child(
                h_flex()
                    .justify_end()
                    .gap_2()
                    .child(
                        ui::button("whats-new", t("settings.whatsNew"), false)
                            .on_click(|_, _, cx| crate::whats_new::show_dialog(cx)),
                    )
                    .when_some(
                        match crate::updater::status(cx) {
                            crate::updater::Status::Available(u) => Some(u.version),
                            _ => None,
                        },
                        |d, version| {
                            d.child(
                                ui::button("settings-update-now", format!("{} v{version}", t("update.updateTo")), true)
                                    .on_click(|_, _, cx| crate::updater::update_now(cx)),
                            )
                        },
                    ),
            )
            .child(row(
                t("settings.platform"),
                format!("{} {}", std::env::consts::OS, std::env::consts::ARCH),
            ))
            .child(row("UI".into(), "GPUI (gpui-kit 0.10)".into()))
            .child(
                v_flex()
                    .gap_2()
                    .pt_3()
                    .border_t_1()
                    .border_color(theme::border())
                    .child(
                        h_flex()
                            .justify_between()
                            .child(div().text_sm().font_weight(FontWeight::MEDIUM).child(t("settings.storageUsage")))
                            .child(
                                ui::icon_button("refresh-storage", IconName::RefreshCw).on_click(cx.listener(|this, _, _, cx| {
                                    this.storage = matches::storage_usage();
                                    cx.notify();
                                })),
                            ),
                    )
                    .child(row(
                        format!("{} ({} {})", t("settings.matches"), s.match_count, t("settings.files")),
                        human_bytes(s.match_bytes),
                    ))
                    .child(row(t("settings.settings"), human_bytes(s.settings_bytes)))
                    .child(row(t("settings.total"), human_bytes(total))),
            )
    }

    /// Electron's "Update Settings" card.
    fn update_section(&self, cx: &mut Context<Self>) -> impl IntoElement {
        use crate::updater::Status;
        let status = crate::updater::status(cx);
        let busy = matches!(status, Status::Downloading { .. } | Status::Installing { .. });
        let picked = self.picked_version.clone();
        let current = crate::updater::VERSION;

        let picker: AnyElement = match &self.versions {
            None => div().text_xs().text_color(theme::text_muted()).child(t("settings.loadingVersions")).into_any_element(),
            Some(versions) => div()
                .id("version-list")
                .max_h(px(140.))
                .overflow_y_scrollbar()
                .child(h_flex().flex_wrap().gap_1().children(versions.iter().map(|v| {
                    let active = picked.as_deref() == Some(v.as_str());
                    let v = v.clone();
                    div()
                        .id(SharedString::from(format!("ver-{v}")))
                        .px_2()
                        .py_1()
                        .rounded_md()
                        .text_xs()
                        .cursor_pointer()
                        .border_1()
                        .when(active, |d| d.bg(theme::accent()).border_color(theme::accent()).text_color(theme::text()))
                        .when(!active, |d| {
                            d.bg(theme::primary())
                                .border_color(theme::border())
                                .text_color(theme::text_soft())
                                .hover(|s| s.border_color(theme::accent()))
                        })
                        .child(if v == current { format!("{v} \u{2713}") } else { v.clone() })
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.picked_version = if this.picked_version.as_deref() == Some(v.as_str()) { None } else { Some(v.clone()) };
                            cx.notify();
                        }))
                })))
                .into_any_element(),
        };

        let line = match &status {
            Status::Downloading { version, done, total } => Some((
                if *total > 0 {
                    format!("{} {version}: {}%", t("update.downloading"), done * 100 / total)
                } else {
                    format!("{} {version}...", t("update.downloading"))
                },
                false,
            )),
            Status::Failed(e) => Some((format!("{}: {e}", t("update.failed")), true)),
            _ => None,
        };

        Self::section(t("settings.updateSettings"))
            .child(self.toggle("autoUpdateEnabled", t("settings.enableAutoUpdate"), t("settings.enableAutoUpdateDesc"), cx))
            .child(
                v_flex()
                    .gap_2()
                    .child(Self::label_block(t("settings.downloadAndInstallVersion"), Some(t("settings.downloadAndInstallDesc"))))
                    .child(picker)
                    .when_some(picked.filter(|_| !busy), |d, version| {
                        d.child(
                            h_flex().justify_end().child(
                                ui::button("install-version", format!("{} {version}", t("settings.install")), true)
                                    .on_click(move |_, _, cx| crate::updater::install_version(version.clone(), cx)),
                            ),
                        )
                    })
                    .when(busy, |d| d.child(div().text_xs().text_color(theme::text_muted()).child(t("settings.installing"))))
                    .when_some(line, |d, (text, err)| {
                        d.child(div().text_xs().text_color(if err { rgb(0xf87171) } else { rgb(0x60a5fa) }).child(text))
                    }),
            )
    }

    fn delete_dialog(&self, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .id("delete-dialog-backdrop")
            .absolute()
            .inset_0()
            .bg(rgba(0x000000aa))
            .occlude()
            .flex()
            .items_center()
            .justify_center()
            .child(
                v_flex()
                    .w(px(480.))
                    .gap_4()
                    .p_6()
                    .rounded_lg()
                    .bg(theme::secondary())
                    .border_1()
                    .border_color(theme::border())
                    .child(
                        h_flex()
                            .gap_3()
                            .child(div().text_color(rgb(0xf87171)).child(IconName::TriangleAlert))
                            .child(div().text_lg().font_weight(FontWeight::SEMIBOLD).child(t("settings.deleteConfirmTitle"))),
                    )
                    .child(div().text_sm().text_color(theme::text_soft()).child(t("settings.deleteConfirmDesc")))
                    .child(div().text_sm().text_color(rgb(0xf87171)).child(t("settings.deleteConfirmWarning")))
                    .child(
                        h_flex()
                            .justify_end()
                            .gap_2()
                            .child(ui::button("cancel-delete", t("settings.cancel"), false).on_click(cx.listener(
                                |this, _, _, cx| {
                                    this.confirm_delete_all = false;
                                    cx.notify();
                                },
                            )))
                            .child(
                                div()
                                    .id("confirm-delete")
                                    .px_3()
                                    .py_1p5()
                                    .rounded_md()
                                    .bg(rgb(0xdc2626))
                                    .hover(|s| s.bg(rgb(0xb91c1c)))
                                    .text_sm()
                                    .font_weight(FontWeight::MEDIUM)
                                    .cursor_pointer()
                                    .child(t("settings.yesDeleteAll"))
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        let deleted = matches::delete_all_matches();
                                        this.confirm_delete_all = false;
                                        this.storage = matches::storage_usage();
                                        this.notice = Some((format!("Deleted {deleted} matches"), false));
                                        cx.notify();
                                    })),
                            ),
                    ),
            )
    }
}

impl Render for SettingsScreen {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let notice = self.notice.clone();
        div()
            .relative()
            .size_full()
            .child(
                div()
                    .id("settings-scroll")
                    .size_full()
                    .overflow_y_scrollbar()
                    .p_6()
                    .child(
                        v_flex()
                            .gap_1()
                            .mb_6()
                            .child(div().text_2xl().font_weight(FontWeight::BOLD).child(t("settings.title")))
                            .child(div().text_color(theme::text_muted()).child(t("settings.subtitle"))),
                    )
                    .when_some(notice, |d, (text, is_error)| {
                        d.child(
                            div()
                                .mb_4()
                                .px_4()
                                .py_3()
                                .rounded_md()
                                .border_1()
                                .text_sm()
                                .when(is_error, |d| d.bg(rgba(0x7f1d1d33)).border_color(rgb(0xb91c1c)).text_color(rgb(0xfca5a5)))
                                .when(!is_error, |d| d.bg(rgba(0x14532d33)).border_color(rgb(0x15803d)).text_color(rgb(0x86efac)))
                                .child(text),
                        )
                    })
                    .child(
                        h_flex()
                            .items_start()
                            .gap_6()
                            .child(
                                v_flex()
                                    .flex_1()
                                    .min_w_0()
                                    .gap_6()
                                    .child(self.cs2_section(cx))
                                    .child(self.demo_folders_section(cx))
                                    .child(self.parsing_section(cx))
                                    .child(self.display_section(cx))
                                    .child(self.storage_section(cx))
                                    .child(self.overlay_section(cx))
                                    .child(self.playback_section(cx))
                                    .child(self.language_section(cx))
                                    .child(self.advanced_section(cx))
                                    .child(self.danger_section(cx)),
                            )
                            .child(
                                v_flex()
                                    .w(px(360.))
                                    .flex_shrink_0()
                                    .gap_6()
                                    .child(self.app_info(cx))
                                    .child(self.update_section(cx)),
                            ),
                    ),
            )
            .when(self.confirm_delete_all, |d| d.child(self.delete_dialog(cx)))
    }
}

fn human_bytes(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["B", "KB", "MB", "GB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 { format!("{bytes} B") } else { format!("{value:.2} {}", UNITS[unit]) }
}
