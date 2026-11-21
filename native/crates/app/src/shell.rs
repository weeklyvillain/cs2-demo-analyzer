//! Window chrome: title bar, sidebar navigation and the active screen.

use gpui_kit::component::{IconName, TitleBar, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::db_viewer::DbViewerScreen;
use crate::i18n::t;
use crate::matches::{MatchesEvent, MatchesScreen};
use crate::settings_screen::SettingsScreen;
use crate::stats_screen::StatsScreen;
use crate::unparsed_screen::UnparsedScreen;
use crate::parsing;
use crate::theme;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Screen {
    Matches,
    Unparsed,
    Stats,
    Settings,
    DbViewer,
}

impl Screen {
    /// Sidebar order, as in Electron; DbViewer only when enabled in Settings.
    const ALL: [Screen; 5] = [Screen::Matches, Screen::Unparsed, Screen::Stats, Screen::Settings, Screen::DbViewer];

    fn label(self) -> String {
        t(match self {
            Screen::Matches => "sidebar.matches",
            Screen::Unparsed => "sidebar.unparsedDemos",
            Screen::Stats => "sidebar.statistics",
            Screen::Settings => "sidebar.settings",
            Screen::DbViewer => "sidebar.dbViewer",
        })
    }

    fn id(self) -> &'static str {
        match self {
            Screen::Matches => "nav-matches",
            Screen::Unparsed => "nav-unparsed",
            Screen::Stats => "nav-stats",
            Screen::Settings => "nav-settings",
            Screen::DbViewer => "nav-dbviewer",
        }
    }

    fn icon(self) -> IconName {
        match self {
            Screen::Matches => IconName::Map,
            Screen::Unparsed => IconName::Inbox,
            Screen::Stats => IconName::ChartPie,
            Screen::Settings => IconName::Settings,
            Screen::DbViewer => IconName::HardDrive,
        }
    }
}

pub struct Shell {
    screen: Screen,
    matches: Entity<MatchesScreen>,
    /// Built on first visit so startup only pays for the matches screen.
    settings: Option<Entity<SettingsScreen>>,
    stats: Option<Entity<StatsScreen>>,
    db_viewer: Option<Entity<DbViewerScreen>>,
    unparsed: Option<Entity<UnparsedScreen>>,
    _observe_queue: Subscription,
    _observe_toasts: Subscription,
    _observe_whats_new: Subscription,
    _observe_updater: Subscription,
    logged_first_frame: bool,
}

impl Shell {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let matches = cx.new(|cx| MatchesScreen::new(window, cx));
        // Right-click → "Show in DB" on a match card.
        cx.subscribe_in(&matches, window, |this, _, event: &MatchesEvent, window, cx| match event {
            MatchesEvent::ShowInDb(id) => {
                let id = id.clone();
                let viewer = this.db_viewer.get_or_insert_with(|| cx.new(|cx| DbViewerScreen::new(window, cx))).clone();
                viewer.update(cx, |v, cx| v.open_match(id, cx));
                this.screen = Screen::DbViewer;
                cx.notify();
            }
        })
        .detach();
        Self {
            screen: Screen::Matches,
            matches,
            settings: None,
            stats: None,
            db_viewer: None,
            unparsed: None,
            // Redraw the sidebar status and dialog as parsing progresses.
            _observe_queue: cx.observe(&parsing::queue(cx), |_, _, cx| cx.notify()),
            _observe_toasts: cx.observe(&crate::toast::entity(cx), |_, _, cx| cx.notify()),
            _observe_whats_new: cx.observe(&crate::whats_new::entity(cx), |_, _, cx| cx.notify()),
            _observe_updater: cx.observe(&crate::updater::entity(cx), |_, _, cx| cx.notify()),
            logged_first_frame: false,
        }
    }

    fn nav_item(&self, screen: Screen, cx: &mut Context<Self>) -> AnyElement {
        let active = self.screen == screen;
        h_flex()
            .id(screen.id())
            .gap_3()
            .px_4()
            .py_2()
            .rounded_md()
            .cursor_pointer()
            .text_sm()
            .when(active, |d| d.bg(theme::surface()).text_color(theme::accent()).font_weight(FontWeight::MEDIUM))
            .when(!active, |d| {
                d.text_color(theme::text_muted())
                    .hover(|s| s.bg(theme::surface()).text_color(theme::text()))
            })
            .child(screen.icon())
            .child(screen.label())
            .on_click(cx.listener(move |this, _, _, cx| {
                this.screen = screen;
                cx.notify();
            }))
            .into_any_element()
    }

    fn sidebar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        v_flex()
            .w(px(232.))
            .h_full()
            .flex_shrink_0()
            .bg(theme::secondary())
            .border_r_1()
            .border_color(theme::border())
            .child(
                // Logo + title, as in Electron's sidebar (resources/icon.png).
                h_flex()
                    .gap_3()
                    .p_4()
                    .border_b_1()
                    .border_color(theme::border())
                    .child(
                        img(cs2da_core::paths::resources_dir().join("icon.png"))
                            .size_16()
                            .flex_shrink_0()
                            .object_fit(ObjectFit::Contain),
                    )
                    .child(
                        v_flex()
                            .min_w_0()
                            .child(
                                div()
                                    .text_lg()
                                    .font_weight(FontWeight::BOLD)
                                    .text_color(theme::accent())
                                    .child("CS2 Demo"),
                            )
                            .child(
                                div()
                                    .text_sm()
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .text_color(theme::text_soft())
                                    .child("Analyzer"),
                            ),
                    ),
            )
            .child(
                v_flex()
                    .p_3()
                    .gap_1()
                    .children(
                        Screen::ALL
                            .into_iter()
                            .filter(|s| *s != Screen::DbViewer || db_viewer_enabled())
                            .map(|s| self.nav_item(s, cx)),
                    ),
            )
            .child(div().flex_1())
            .children(parsing::sidebar_status(cx))
            .child(
                div()
                    .p_4()
                    .text_xs()
                    .text_color(theme::text_muted())
                    .child(concat!("v", env!("CARGO_PKG_VERSION"))),
            )
    }

}

impl Render for Shell {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if !self.logged_first_frame {
            self.logged_first_frame = true;
            if let Some(start) = crate::STARTED.get() {
                eprintln!("[startup] first frame after {} ms", start.elapsed().as_millis());
            }
        }

        let content = match self.screen {
            Screen::Matches => self.matches.clone().into_any_element(),
            Screen::Settings => self
                .settings
                .get_or_insert_with(|| cx.new(|cx| SettingsScreen::new(window, cx)))
                .clone()
                .into_any_element(),
            Screen::Stats => self
                .stats
                .get_or_insert_with(|| cx.new(|cx| StatsScreen::new(window, cx)))
                .clone()
                .into_any_element(),
            Screen::DbViewer => self
                .db_viewer
                .get_or_insert_with(|| cx.new(|cx| DbViewerScreen::new(window, cx)))
                .clone()
                .into_any_element(),
            Screen::Unparsed => self
                .unparsed
                .get_or_insert_with(|| cx.new(|cx| UnparsedScreen::new(window, cx)))
                .clone()
                .into_any_element(),
        };
        let dialog = parsing::dialog(cx);

        v_flex()
            .relative()
            .size_full()
            .bg(theme::primary())
            .text_color(theme::text())
            .child(
                TitleBar::new().child(
                    h_flex()
                        .flex_1()
                        .pr_2()
                        .items_center()
                        .justify_between()
                        .child(div().text_xs().text_color(theme::text_muted()).child("CS2 Demo Analyzer"))
                        .children(crate::updater::title_bar_item(cx)),
                ),
            )
            .child(
                h_flex()
                    .flex_1()
                    .min_h_0()
                    .child(self.sidebar(cx))
                    .child(div().flex_1().min_w_0().h_full().child(content)),
            )
            .children(dialog)
            .children(crate::whats_new::render(cx))
            .children(crate::toast::render(cx))
    }
}

/// Settings → Advanced → "Enable DB Viewer" (`enable_db_viewer`).
fn db_viewer_enabled() -> bool {
    cs2da_core::settings::Settings::open().is_ok_and(|s| s.get_bool("enable_db_viewer", false))
}
