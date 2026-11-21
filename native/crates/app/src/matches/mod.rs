//! Matches screen: a searchable, sortable grid of map cards (Electron `MatchListPanel`);
//! clicking a card opens that match with its tabs.

mod chat;
mod overview;
mod players;
mod rounds;
mod selection;
mod viewer2d;

use std::cmp::Ordering;
use std::collections::HashSet;
use std::path::PathBuf;

use cs2da_core::{MatchInfo, MatchSummary, paths};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::{IconName, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::format;
use crate::i18n::{t, tf};
use crate::theme;
use crate::ui::{self, centered_note};
use gpui_kit::component::scroll::ScrollableElement as _;

/// Things the shell acts on.
pub enum MatchesEvent {
    /// Right-click → "Show in DB": switch to the DB viewer with this match selected.
    ShowInDb(String),
}

impl EventEmitter<MatchesEvent> for MatchesScreen {}

/// Target card width; the grid fits as many columns as this allows.
const CARD_MIN_WIDTH: f32 = 270.;
const CARD_IMAGE_HEIGHT: f32 = 256.;
/// Width of the app sidebar plus this screen's horizontal padding.
const CHROME_WIDTH: f32 = 232. + 48.;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Tab {
    Overview,
    Players,
    Rounds,
    Viewer2D,
    Chat,
}

impl Tab {
    const ALL: [Tab; 5] = [Tab::Overview, Tab::Players, Tab::Rounds, Tab::Viewer2D, Tab::Chat];
    fn label(self) -> String {
        match self {
            Tab::Overview => t("matches.tabs.overview"),
            Tab::Players => t("matches.tabs.players"),
            Tab::Rounds => t("matches.tabs.rounds"),
            Tab::Viewer2D => "2D Viewer".into(),
            Tab::Chat => t("matches.tabs.chat"),
        }
    }
    fn id(self) -> &'static str {
        match self {
            Tab::Overview => "tab-overview",
            Tab::Players => "tab-players",
            Tab::Rounds => "tab-rounds",
            Tab::Viewer2D => "tab-2d",
            Tab::Chat => "tab-chat",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum SortField {
    Date,
    Id,
    Length,
    Map,
}

impl SortField {
    const ALL: [SortField; 4] = [SortField::Date, SortField::Id, SortField::Length, SortField::Map];
    fn from_key(key: &str) -> Self {
        match key {
            "id" => SortField::Id,
            "length" => SortField::Length,
            "map" => SortField::Map,
            _ => SortField::Date,
        }
    }
    fn label(self) -> String {
        match self {
            SortField::Date => t("settings.date"),
            SortField::Id => t("settings.id"),
            SortField::Length => t("matches.duration"),
            SortField::Map => t("settings.map"),
        }
    }
}

enum Load<T> {
    Loading,
    Ready(T),
    Failed(String),
}

pub struct MatchesScreen {
    matches: Load<Vec<MatchInfo>>,
    search: Entity<InputState>,
    sort: SortField,
    descending: bool,
    /// The open match; `None` shows the card grid.
    open: Option<String>,
    summary: Option<Load<MatchSummary>>,
    tab: Tab,
    collapsed_rounds: HashSet<i64>,
    chat_filter: Option<String>,
    overview: overview::OverviewState,
    /// The 2D tab's viewer, built the first time it's shown for this match.
    viewer2d: Option<Entity<viewer2d::Viewer2D>>,
    /// The match's map has a radar image (Electron hides the 2D tab otherwise).
    has_radar: bool,
    /// Card selection, right-click menu and its dialogs.
    grid: selection::GridSelection,
    focus: FocusHandle,
    _list_task: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl MatchesScreen {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let search = cx.new(|cx| InputState::new(window, cx).placeholder(t("matches.searchPlaceholder")));
        let subscription = cx.subscribe(&search, |_, _, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) {
                cx.notify();
            }
        });
        // Settings → Display → Default match sort (Electron `default_sort_field` / `_direction`).
        let (sort, descending) = cs2da_core::settings::Settings::open()
            .map(|s| (s.get_or("default_sort_field", "date"), s.get_or("default_sort_direction", "desc")))
            .map(|(f, d)| (SortField::from_key(&f), d != "asc"))
            .unwrap_or((SortField::Date, true));
        let mut this = Self {
            matches: Load::Loading,
            search,
            sort,
            descending,
            open: None,
            summary: None,
            tab: Tab::Overview,
            collapsed_rounds: HashSet::new(),
            chat_filter: None,
            overview: overview::OverviewState::default(),
            viewer2d: None,
            has_radar: false,
            grid: selection::GridSelection::default(),
            focus: cx.focus_handle(),
            _list_task: None,
            _subscriptions: vec![
                subscription,
                // A finished parse adds (or replaces) a match: refresh the grid.
                cx.subscribe(&crate::parsing::queue(cx), |this, _, e: &crate::parsing::ParseQueueEvent, cx| {
                    if let crate::parsing::ParseQueueEvent::MatchParsed = e {
                        this.reload(cx);
                    }
                }),
            ],
        };
        this.reload(cx);
        this
    }

    fn reload(&mut self, cx: &mut Context<Self>) {
        self.matches = Load::Loading;
        let task = cx.spawn(async move |this, cx| {
            let started = std::time::Instant::now();
            let result = cx.background_spawn(async { cs2da_core::matches::list_matches() }).await;
            eprintln!("[matches] listed in {} ms", started.elapsed().as_millis());
            this.update(cx, |this, cx| {
                this.matches = match result {
                    Ok(list) => Load::Ready(list),
                    Err(e) => Load::Failed(e.to_string()),
                };
                cx.notify();
            })
            .ok();
        });
        self._list_task = Some(task);
        cx.notify();
    }

    fn open_match(&mut self, id: String, cx: &mut Context<Self>) {
        self.open = Some(id.clone());
        self.summary = Some(Load::Loading);
        self.tab = Tab::Overview;
        self.collapsed_rounds.clear();
        self.chat_filter = None;
        self.overview = overview::OverviewState::for_new_match();
        self.viewer2d = None;
        self.has_radar = false;
        cx.spawn(async move |this, cx| {
            let wanted = id.clone();
            let result = cx.background_spawn(async move { cs2da_core::matches::match_summary(&id) }).await;
            this.update(cx, |this, cx| {
                // Ignore a slow load that finished after the user moved on.
                if this.open.as_deref() == Some(wanted.as_str()) {
                    this.summary = Some(match result {
                        Ok(s) => {
                            this.has_radar = viewer2d::has_radar_image(&s.info.map);
                            Load::Ready(s)
                        }
                        Err(e) => Load::Failed(format!("{e:#}")),
                    });
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    fn close_match(&mut self, cx: &mut Context<Self>) {
        self.open = None;
        self.summary = None;
        cx.notify();
    }

    // ---------- selection & right-click menu (selection.rs) ----------

    fn delete_selected(&mut self, cx: &mut Context<Self>) {
        let ids: Vec<String> = self.grid.selected.drain().collect();
        cs2da_core::matches::delete_matches(&ids);
        if let (Load::Ready(list), ids) = (&mut self.matches, &ids) {
            list.retain(|m| !ids.contains(&m.id));
        }
        if self.open.as_ref().is_some_and(|o| ids.contains(o)) {
            self.close_match(cx);
        }
        self.grid.confirm_delete = false;
        cx.notify();
    }

    fn reparse(&mut self, demo: PathBuf, cx: &mut Context<Self>) {
        self.grid.menu = None;
        crate::parsing::parse_demos(vec![demo], cx);
        cx.notify();
    }

    fn on_key(&mut self, event: &KeyDownEvent, cx: &mut Context<Self>) {
        match event.keystroke.key.as_str() {
            "escape" => {
                self.grid.menu = None;
                if self.grid.confirm_delete {
                    self.grid.confirm_delete = false;
                } else if self.grid.logs.is_some() {
                    self.grid.logs = None;
                } else {
                    self.grid.selected.clear();
                }
            }
            "delete" if !self.grid.selected.is_empty() && self.open.is_none() => self.grid.confirm_delete = true,
            "enter" if self.grid.confirm_delete => return self.delete_selected(cx),
            _ => return,
        }
        cx.notify();
    }

    /// Context menu, delete confirmation, parser logs and the rubber band, over the grid.
    fn grid_overlays(&self, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let mut out = Vec::new();
        if let Some(rect) = self.grid.drag_rect() {
            out.push(
                deferred(
                    anchored().position(rect.origin).child(
                        div()
                            .w(rect.size.width)
                            .h(rect.size.height)
                            .rounded_sm()
                            .border_2()
                            .border_dashed()
                            .border_color(rgb(0x3b82f6))
                            .bg(rgba(0x3b82f614)),
                    ),
                )
                .into_any_element(),
            );
        }
        if let Some(menu) = &self.grid.menu {
            let id = menu.match_id.clone();
            let has_demo = menu.demo_path.is_some();
            let selected = self.grid.selected.contains(&id);
            let (open_demo, reparse_demo) = (menu.demo_path.clone(), menu.demo_path.clone());
            let (db_id, logs_id, sel_id, del_id) = (id.clone(), id.clone(), id.clone(), id.clone());
            let db_enabled = cs2da_core::settings::Settings::open().is_ok_and(|s| s.get_bool("enable_db_viewer", false));
            let panel = v_flex()
                .id("card-menu")
                .min_w(px(200.))
                .py_1()
                .rounded_lg()
                .bg(theme::secondary())
                .border_1()
                .border_color(theme::border())
                .shadow_lg()
                .occlude()
                .child(
                    selection::menu_item("menu-open", IconName::FolderOpen, t("matches.openFolder"), has_demo).on_click(
                        cx.listener(move |this, _, _, cx| {
                            this.grid.menu = None;
                            if let Some(p) = &open_demo {
                                ui::show_in_folder(p);
                            }
                            cx.notify();
                        }),
                    ),
                )
                .child(
                    selection::menu_item("menu-reparse", IconName::RefreshCw, t("matches.reparseDemo"), has_demo).on_click(
                        cx.listener(move |this, _, _, cx| {
                            if let Some(p) = reparse_demo.clone() {
                                this.reparse(p, cx);
                            }
                        }),
                    ),
                )
                .when(db_enabled, |d| {
                    d.child(selection::menu_item("menu-db", IconName::HardDrive, t("matches.showInDb"), true).on_click(
                        cx.listener(move |this, _, _, cx| {
                            this.grid.menu = None;
                            cx.emit(MatchesEvent::ShowInDb(db_id.clone()));
                            cx.notify();
                        }),
                    ))
                })
                .child(
                    selection::menu_item("menu-logs", IconName::FileText, "Show Parser Logs".into(), true)
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.grid.show_logs(&logs_id);
                            cx.notify();
                        })),
                )
                .child(
                    selection::menu_item(
                        "menu-select",
                        if selected { IconName::Close } else { IconName::Check },
                        if selected { t("matches.deselect") } else { format!("{} (CTRL + Click)", t("matches.select")) },
                        true,
                    )
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.grid.menu = None;
                        this.grid.toggle(&sel_id);
                        cx.notify();
                    })),
                )
                .child(div().my_1().h_px().bg(theme::border()))
                .child(
                    selection::menu_item("menu-delete", IconName::Delete, "Delete".into(), true)
                        .text_color(rgb(0xf87171))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.grid.delete_from_menu(&del_id);
                            cx.notify();
                        })),
                );
            out.push(
                deferred(anchored().position(menu.position).snap_to_window_with_margin(px(8.)).child(panel))
                    .with_priority(1)
                    .into_any_element(),
            );
        }
        if self.grid.confirm_delete {
            let (cancel, delete) = (cx.entity().downgrade(), cx.entity().downgrade());
            out.push(
                selection::delete_dialog(
                    self.grid.selected.len(),
                    move |_, cx| {
                        cancel
                            .update(cx, |this, cx| {
                                this.grid.confirm_delete = false;
                                cx.notify();
                            })
                            .ok();
                    },
                    move |_, cx| {
                        delete.update(cx, |this, cx| this.delete_selected(cx)).ok();
                    },
                )
                .into_any_element(),
            );
        }
        if let Some(logs) = &self.grid.logs {
            let (copy, close) = (cx.entity().downgrade(), cx.entity().downgrade());
            let text = logs.text.clone().unwrap_or_default();
            out.push(
                selection::logs_dialog(
                    logs,
                    move |_, cx| {
                        ui::copy_to_clipboard(text.clone(), cx);
                        copy.update(cx, |this, cx| {
                            if let Some(l) = &mut this.grid.logs {
                                l.copied = true;
                            }
                            cx.notify();
                        })
                        .ok();
                    },
                    move |_, cx| {
                        close
                            .update(cx, |this, cx| {
                                this.grid.logs = None;
                                cx.notify();
                            })
                            .ok();
                    },
                )
                .into_any_element(),
            );
        }
        out
    }

    fn set_sort(&mut self, field: SortField, cx: &mut Context<Self>) {
        if self.sort == field {
            self.descending = !self.descending;
        } else {
            self.sort = field;
            // Newest first for dates, A→Z / shortest first for the rest.
            self.descending = field == SortField::Date;
        }
        cx.notify();
    }

    /// Matches after the search filter and sort, like the Electron `sortedMatches`.
    fn visible<'a>(&self, list: &'a [MatchInfo], cx: &App) -> Vec<&'a MatchInfo> {
        let query = self.search.read(cx).value().trim().to_lowercase();
        let mut out: Vec<&MatchInfo> = list
            .iter()
            .filter(|m| {
                query.is_empty()
                    || m.id.to_lowercase().contains(&query)
                    || m.map.to_lowercase().contains(&query)
                    || m.source.as_deref().is_some_and(|s| s.to_lowercase().contains(&query))
            })
            .collect();
        let date = |m: &MatchInfo| m.started_at.clone().or_else(|| m.created_at_iso.clone()).filter(|d| !d.is_empty());
        out.sort_by(|a, b| {
            let ord = match self.sort {
                SortField::Id => a.id.cmp(&b.id),
                SortField::Map => a.map.cmp(&b.map),
                SortField::Length => a.duration_secs.partial_cmp(&b.duration_secs).unwrap_or(Ordering::Equal),
                SortField::Date => match (date(a), date(b)) {
                    // Undated matches always go last.
                    (None, None) => Ordering::Equal,
                    (None, _) => return Ordering::Greater,
                    (_, None) => return Ordering::Less,
                    (Some(x), Some(y)) => x.cmp(&y),
                },
            };
            if self.descending { ord.reverse() } else { ord }
        });
        out
    }

    // ---------- card grid ----------

    fn grid_view(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let list = match &self.matches {
            Load::Loading => return centered_note(t("matches.loading")).into_any_element(),
            Load::Failed(e) => {
                return centered_note(format!("Couldn't read matches: {e}")).into_any_element();
            }
            Load::Ready(list) if list.is_empty() => {
                return v_flex()
                    .size_full()
                    .items_center()
                    .justify_center()
                    .gap_2()
                    .text_color(theme::text_muted())
                    .child(div().text_lg().child(t("matches.noMatches")))
                    .child(div().text_sm().child(t("matches.parseToStart")))
                    .child(
                        ui::button("add-demo-empty", format!("⤒ {}", t("matches.addDemo")), true)
                            .mt_2()
                            .on_click(cx.listener(|this, _, _, cx| this.add_demo(cx))),
                    )
                    .child(
                        v_flex()
                            .mt_4()
                            .p_4()
                            .max_w(px(420.))
                            .rounded_lg()
                            .bg(rgba(0x36393e80))
                            .border_1()
                            .border_color(rgba(0x37415180))
                            .gap_2()
                            .child(div().text_sm().font_weight(FontWeight::MEDIUM).text_color(theme::text_soft()).child(t("matches.dragDrop")))
                            .child(div().text_xs().child(t("matches.dragDropDesc"))),
                    )
                    .into_any_element();
            }
            Load::Ready(list) => list,
        };

        let visible = self.visible(list, cx);
        let query = self.search.read(cx).value().trim().to_string();
        let available = f32::from(window.viewport_size().width) - CHROME_WIDTH;
        let cols = ((available / CARD_MIN_WIDTH).floor() as u16).clamp(1, 6);

        let sort_buttons = SortField::ALL.map(|field| {
            let active = self.sort == field;
            h_flex()
                .id(SharedString::from(format!("sort-{}", field.label())))
                .gap_1p5()
                .px_3()
                .py_1p5()
                .rounded_sm()
                .text_sm()
                .font_weight(FontWeight::MEDIUM)
                .cursor_pointer()
                .when(active, |d| d.bg(theme::accent()).text_color(theme::text()))
                .when(!active, |d| d.bg(theme::surface()).text_color(theme::text_soft()).hover(|s| s.bg(rgba(0x36393ecc))))
                .child(field.label())
                .when(active, |d| d.child(if self.descending { IconName::ArrowDown } else { IconName::ArrowUp }))
                .on_click(cx.listener(move |this, _, _, cx| this.set_sort(field, cx)))
        });

        let controls = v_flex()
            .gap_3()
            .mb_4()
            .child(
                h_flex()
                    .gap_2()
                    .child(
                        div().flex_1().child(
                            Input::new(&self.search)
                                .prefix(div().text_color(rgb(0x6b7280)).child(IconName::Search))
                                .cleanable(true),
                        ),
                    )
                    .child(
                        ui::button("add-demo", format!("⤒ {}", t("matches.addDemo")), true)
                            .on_click(cx.listener(|this, _, _, cx| this.add_demo(cx))),
                    )
                    .child(
                        ui::button("reload", t("matches.refresh"), false)
                            .on_click(cx.listener(|this, _, _, cx| this.reload(cx))),
                    ),
            )
            .when(!query.is_empty(), |d| {
                d.child(div().text_sm().text_color(theme::text_muted()).child(tf(
                    "matches.showingResults",
                    &[("showing", &visible.len().to_string()), ("total", &list.len().to_string())],
                )))
            })
            .child(
                h_flex()
                    .gap_4()
                    .child(div().text_sm().text_color(theme::text_muted()).child(t("matches.sortBy")))
                    .child(h_flex().gap_2().children(sort_buttons))
                    .when(!self.grid.selected.is_empty(), |d| {
                        let n = self.grid.selected.len();
                        d.child(div().flex_1())
                            .child(
                                div()
                                    .text_sm()
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(theme::accent())
                                    .child(tf(
                                        "matches.selected",
                                        &[("count", &n.to_string()), ("plural", crate::i18n::match_plural(n))],
                                    )),
                            )
                            .child(ui::button("deselect-all", t("matches.deselectAll"), false).on_click(cx.listener(
                                |this, _, _, cx| {
                                    this.grid.selected.clear();
                                    cx.notify();
                                },
                            )))
                            .child(
                                h_flex()
                                    .id("delete-selected")
                                    .gap_1p5()
                                    .px_3()
                                    .py_1p5()
                                    .rounded_md()
                                    .bg(rgb(0xdc2626))
                                    .hover(|s| s.bg(rgb(0xb91c1c)))
                                    .text_sm()
                                    .cursor_pointer()
                                    .child(IconName::Delete)
                                    .child(t("matches.deleteSelected"))
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.grid.confirm_delete = true;
                                        cx.notify();
                                    })),
                            )
                    }),
            );

        let grid: AnyElement = if visible.is_empty() {
            v_flex()
                .py_16()
                .items_center()
                .gap_2()
                .text_color(theme::text_muted())
                .child(div().text_lg().child(t("matches.noMatches")))
                .child(div().text_sm().child(tf("matches.noMatchesSearch", &[("query", &query)])))
                .into_any_element()
        } else {
            div()
                .grid()
                .grid_cols(cols)
                .gap_4()
                .children(visible.into_iter().map(|m| self.card(m, cx)))
                .into_any_element()
        };

        div()
            .id("match-grid-scroll")
            .size_full()
            .overflow_y_scrollbar()
            .p_6()
            .child(controls)
            .child(grid)
            .into_any_element()
    }

    fn card(&self, m: &MatchInfo, cx: &mut Context<Self>) -> AnyElement {
        let id = m.id.clone();
        let map_title = if m.map.is_empty() { t("matches.unknownMap") } else { m.map.clone() };
        let source_icon = m.source.as_deref().and_then(paths::source_icon);

        let image = div()
            .relative()
            .w_full()
            .h(px(CARD_IMAGE_HEIGHT))
            .overflow_hidden()
            .bg(theme::surface())
            .child(
                img(paths::map_thumbnail(&m.map))
                    .size_full()
                    .object_fit(ObjectFit::Cover)
                    .with_fallback(|| map_placeholder().into_any_element()),
            )
            // Darken the bottom so the map name stays readable on bright art.
            .child(div().absolute().inset_0().bg(linear_gradient(
                0.,
                linear_color_stop(rgba(0x00000099), 0.),
                linear_color_stop(rgba(0x00000000), 1.),
            )))
            .child(
                h_flex()
                    .absolute()
                    .bottom_3()
                    .left_3()
                    .right_3()
                    .justify_between()
                    .gap_2()
                    .child(div().font_weight(FontWeight::SEMIBOLD).text_color(theme::text()).truncate().child(map_title))
                    .when_some(source_icon, |d, icon| {
                        d.child(img(icon).size_5().flex_shrink_0().object_fit(ObjectFit::Contain))
                    }),
            );

        let stat = |label: String, value: String, accent: bool| {
            h_flex()
                .gap_1p5()
                .items_baseline()
                .child(div().text_color(rgb(0x6b7280)).child(format!("{label}:")))
                .child(
                    div()
                        .text_sm()
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(if accent { theme::accent() } else { theme::text_soft() })
                        .child(value),
                )
        };

        let body = v_flex()
            .p_4()
            .gap_3()
            .bg(theme::secondary())
            .border_t_1()
            .border_color(rgba(0x42454980))
            .child(div().text_sm().font_weight(FontWeight::BOLD).font_family("Consolas").truncate().child(m.id.clone()))
            .child(
                h_flex()
                    .flex_wrap()
                    .gap_x_3()
                    .gap_y_1()
                    .text_xs()
                    .when(m.round_count > 0, |d| d.child(stat(t("matches.rounds"), m.round_count.to_string(), true)))
                    .when(m.duration_secs > 0.0, |d| {
                        d.child(stat(t("matches.duration"), format::duration(m.duration_secs), true))
                    })
                    .when(m.team_a_wins > 0 || m.team_b_wins > 0, |d| {
                        d.child(stat(
                            t("matches.score"),
                            format!(
                                "{} {} - {} {}",
                                t("matches.teamA"),
                                m.team_a_wins,
                                t("matches.teamB"),
                                m.team_b_wins
                            ),
                            false,
                        ))
                    })
                    .child(stat(t("matches.players"), m.player_count.to_string(), false)),
            );

        v_flex()
            .id(SharedString::from(format!("card-{}", m.id)))
            .relative()
            .rounded_lg()
            .overflow_hidden()
            .bg(theme::secondary())
            .border_2()
            .cursor_pointer()
            .map(|d| match self.grid.card_state(&m.id) {
                (true, _) => d.border_color(theme::accent()),
                (false, true) => d.border_color(rgba(0xd07a2dcc)),
                _ => d.border_color(transparent_black()).hover(|s| s.border_color(rgba(0xd07a2d80))),
            })
            .child(image)
            .child(body)
            .map(|d| match self.grid.card_state(&m.id) {
                (true, _) => d.child(selection::check_badge(false)),
                (false, true) => d.child(selection::check_badge(true)),
                _ => d,
            })
            .child(selection::bounds_probe(m.id.clone(), self.grid.card_bounds.clone()))
            .on_mouse_down(MouseButton::Right, {
                let info = m.clone();
                cx.listener(move |this, e: &MouseDownEvent, window, cx| {
                    window.focus(&this.focus, cx);
                    this.grid.open_menu(&info, e.position);
                    cx.notify();
                })
            })
            .on_click(cx.listener(move |this, e: &ClickEvent, window, cx| {
                window.focus(&this.focus, cx);
                this.grid.menu = None;
                // Ctrl/Cmd+click toggles selection instead of opening the match.
                if e.modifiers().control || e.modifiers().platform {
                    this.grid.toggle(&id);
                    cx.notify();
                } else {
                    this.open_match(id.clone(), cx);
                }
            }))
            .into_any_element()
    }

    // ---------- match details ----------

    fn detail_view(&self, cx: &mut Context<Self>) -> AnyElement {
        let back = h_flex()
            .id("back")
            .gap_2()
            .px_4()
            .py_2()
            .rounded_md()
            .bg(theme::surface())
            .border_1()
            .border_color(theme::border())
            .text_sm()
            .cursor_pointer()
            .hover(|s| s.border_color(theme::accent()))
            .child(IconName::ArrowLeft)
            .child("Back to Matches")
            .on_click(cx.listener(|this, _, _, cx| this.close_match(cx)));

        let panel: AnyElement = match &self.summary {
            None | Some(Load::Loading) => centered_note(t("matches.loading")).into_any_element(),
            Some(Load::Failed(e)) => centered_note(format!("Couldn't open match: {e}")).into_any_element(),
            Some(Load::Ready(s)) => {
                let body = match self.tab {
                    Tab::Overview => overview::render(
                        s,
                        &self.overview,
                        |this: &mut Self| &mut this.overview,
                        self.has_radar.then_some(Self::show_in_2d as overview::View2d<Self>),
                        cx,
                    ),
                    Tab::Players => {
                        // The player window's "View in 2D" buttons jump this match's viewer.
                        let view_2d = self.has_radar.then(|| {
                            let this = cx.entity().downgrade();
                            std::rc::Rc::new(move |tick: i64, window: &mut Window, cx: &mut App| {
                                this.update(cx, |this, cx| this.show_in_2d(tick, window, cx)).ok();
                            }) as crate::voice::View2d
                        });
                        players::render(s, view_2d, cx)
                    }
                    Tab::Rounds => rounds::render(
                        s,
                        &self.collapsed_rounds,
                        |index, _, cx: &mut Context<Self>| {
                            cx.update_entity(&cx.entity(), |this, cx| {
                                if !this.collapsed_rounds.remove(&index) {
                                    this.collapsed_rounds.insert(index);
                                }
                                cx.notify();
                            });
                        },
                        self.has_radar.then_some(Self::show_in_2d as fn(&mut Self, i64, &mut Window, &mut Context<Self>)),
                        s.info.demo_path.is_some(),
                        cx,
                    ),
                    Tab::Chat => chat::render(
                        s,
                        self.chat_filter.as_deref(),
                        |filter, _, cx: &mut Context<Self>| {
                            cx.update_entity(&cx.entity(), |this, cx| {
                                this.chat_filter = filter;
                                cx.notify();
                            });
                        },
                        cx,
                    ),
                    Tab::Viewer2D => match &self.viewer2d {
                        Some(v) => v.clone().into_any_element(),
                        None => centered_note(t("matches.loading")).into_any_element(),
                    },
                };
                v_flex()
                    .size_full()
                    .child(self.detail_header(s))
                    .child(self.tabs(cx))
                    // The 2D viewer fills the panel; other tabs scroll inside it (as in Electron).
                    .child(if self.tab == Tab::Viewer2D {
                        div().id("detail-body").flex_1().min_h_0().child(body).into_any_element()
                    } else {
                        div().id("detail-body").flex_1().min_h_0().overflow_y_scrollbar().p_6().child(body).into_any_element()
                    })
                    .into_any_element()
            }
        };

        v_flex()
            .size_full()
            .p_6()
            .gap_4()
            .child(h_flex().child(back))
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .rounded_lg()
                    .overflow_hidden()
                    .bg(theme::secondary())
                    .border_1()
                    .border_color(theme::border())
                    .child(panel),
            )
            .into_any_element()
    }

    fn detail_header(&self, s: &MatchSummary) -> impl IntoElement {
        let date = s
            .info
            .created_at_iso
            .as_deref()
            .or(s.info.started_at.as_deref())
            .map(format::short_date)
            .unwrap_or_default();
        h_flex()
            .gap_4()
            .items_center()
            .px_6()
            .py_4()
            .border_b_1()
            .border_color(theme::border())
            .child(
                img(paths::map_thumbnail(&s.info.map))
                    .w(px(120.))
                    .h(px(68.))
                    .rounded_md()
                    .object_fit(ObjectFit::Cover),
            )
            .child(
                v_flex()
                    .flex_1()
                    .gap_1()
                    .child(div().text_2xl().font_weight(FontWeight::BOLD).child(format::map_name(&s.info.map)))
                    .child(
                        div().text_sm().text_color(theme::text_muted()).child(format!(
                            "{date} · {} rounds · {} · {} players · {} tick{}",
                            s.info.round_count,
                            format::duration(s.info.duration_secs),
                            s.info.player_count,
                            s.tick_rate.round(),
                            s.info.build_num.map(|b| format!(" · build {b}")).unwrap_or_default()
                        )),
                    ),
            )
            .child(
                h_flex()
                    .gap_3()
                    .items_center()
                    .text_3xl()
                    .font_weight(FontWeight::BOLD)
                    .child(div().text_color(theme::accent()).child(s.info.team_a_wins.to_string()))
                    .child(div().text_color(theme::text_muted()).child(":"))
                    .child(div().text_color(theme::team_ct()).child(s.info.team_b_wins.to_string())),
            )
            // Electron's header button, shown when the demo file is known: the demo from the start.
            .when_some(s.info.demo_path.clone(), |d, demo| {
                d.child(
                    ui::button("watch-in-cs2", "Watch in CS2", true)
                        .flex_shrink_0()
                        .tooltip(|window, cx| {
                            gpui_kit::component::tooltip::Tooltip::new("Launch CS2 and watch this demo").build(window, cx)
                        })
                        .on_click(move |_, window, cx| crate::cs2_watch::watch_match(demo.clone(), window, cx)),
                )
            })
    }

    fn tabs(&self, cx: &mut Context<Self>) -> impl IntoElement {
        h_flex()
            .px_6()
            .gap_1()
            .border_b_1()
            .border_color(theme::border())
            .children(Tab::ALL.into_iter().filter(|tab| *tab != Tab::Viewer2D || self.has_radar).map(|tab| {
                let active = self.tab == tab;
                div()
                    .id(tab.id())
                    .px_3()
                    .py_2()
                    .text_sm()
                    .cursor_pointer()
                    .border_b_2()
                    .when(active, |d| d.border_color(theme::accent()).text_color(theme::text()))
                    .when(!active, |d| {
                        d.border_color(transparent_black())
                            .text_color(theme::text_muted())
                            .hover(|s| s.text_color(theme::text()))
                    })
                    .child(tab.label())
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.tab = tab;
                        if tab == Tab::Viewer2D {
                            if let Some(v) = this.ensure_viewer2d(cx) {
                                let handle = v.focus_handle(cx);
                                window.focus(&handle, cx);
                            }
                        }
                        cx.notify();
                    }))
            }))
    }

    fn ensure_viewer2d(&mut self, cx: &mut Context<Self>) -> Option<Entity<viewer2d::Viewer2D>> {
        if self.viewer2d.is_none() {
            if let Some(Load::Ready(s)) = &self.summary {
                let (id, map, events) = (s.info.id.clone(), s.info.map.clone(), s.events.clone());
                let names = s.roster.iter().map(|p| (p.steamid.clone(), p.name.clone())).collect();
                self.viewer2d = Some(cx.new(|cx| viewer2d::Viewer2D::new(id, map, events, names, cx)));
            }
        }
        self.viewer2d.clone()
    }

    /// "View in 2D": switch to the 2D tab with the playhead at `tick`.
    pub fn show_in_2d(&mut self, tick: i64, window: &mut Window, cx: &mut Context<Self>) {
        if !self.has_radar {
            return;
        }
        self.tab = Tab::Viewer2D;
        if let Some(v) = self.ensure_viewer2d(cx) {
            v.update(cx, |v, cx| v.seek_to(tick, cx));
            let handle = v.focus_handle(cx);
                                window.focus(&handle, cx);
        }
        cx.notify();
    }
}

impl MatchesScreen {
    /// "Add Demo": pick a .dem file and parse it (Electron `handleAddDemo`).
    fn add_demo(&mut self, cx: &mut Context<Self>) {
        let picked = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: Some(t("matches.addDemo").into()),
        });
        cx.spawn(async move |_, cx| {
            if let Ok(Ok(Some(paths))) = picked.await {
                let demos: Vec<_> = paths.into_iter().filter(|p| is_demo(p)).collect();
                cx.update(|cx| crate::parsing::parse_demos(demos, cx));
            }
        })
        .detach();
    }
}

fn is_demo(p: &std::path::Path) -> bool {
    p.extension().is_some_and(|e| e.eq_ignore_ascii_case("dem"))
}

impl Render for MatchesScreen {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let on_grid = self.open.is_none();
        let body = if on_grid { self.grid_view(window, cx) } else { self.detail_view(cx) };
        let overlays = if on_grid { self.grid_overlays(cx) } else { Vec::new() };
        // Drop .dem files anywhere on the screen to parse them; the accent outline is Electron's drag highlight.
        div()
            .id("matches-drop")
            .relative()
            .size_full()
            .track_focus(&self.focus)
            .on_key_down(cx.listener(|this, e: &KeyDownEvent, _, cx| this.on_key(e, cx)))
            .drag_over::<ExternalPaths>(|s, _, _, _| s.bg(rgba(0xd07a2d1a)).border_2().border_color(theme::accent()))
            .on_drop(cx.listener(|_, paths: &ExternalPaths, _, cx| {
                let demos: Vec<_> = paths.paths().iter().filter(|p| is_demo(p)).cloned().collect();
                crate::parsing::parse_demos(demos, cx);
            }))
            // Ctrl+drag anywhere on the grid draws a rubber band that adds cards to the selection.
            .when(on_grid, |d| {
                d.on_mouse_down(
                    MouseButton::Left,
                    cx.listener(|this, e: &MouseDownEvent, window, cx| {
                        window.focus(&this.focus, cx);
                        if this.grid.menu.take().is_some() {
                            cx.notify();
                        }
                        if e.modifiers.control || e.modifiers.platform {
                            this.grid.start_drag(e.position);
                            cx.notify();
                        }
                    }),
                )
                .on_mouse_move(cx.listener(|this, e: &MouseMoveEvent, _, cx| {
                    if this.grid.drag.is_some() {
                        this.grid.update_drag(e.position);
                        cx.notify();
                    }
                }))
                .on_mouse_up(
                    MouseButton::Left,
                    cx.listener(|this, _: &MouseUpEvent, _, cx| {
                        if this.grid.drag.is_some() {
                            this.grid.end_drag();
                            cx.notify();
                        }
                    }),
                )
            })
            .child(body)
            .children(overlays)
    }
}

fn map_placeholder() -> impl IntoElement {
    v_flex()
        .size_full()
        .items_center()
        .justify_center()
        .bg(linear_gradient(
            135.,
            linear_color_stop(theme::surface(), 0.),
            linear_color_stop(theme::secondary(), 1.),
        ))
        .text_color(theme::text_muted())
        .child(IconName::Map)
}
