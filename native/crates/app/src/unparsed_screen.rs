//! Unparsed Demos (Electron `UnparsedDemosPage`): `.dem` files in the watched folders
//! that haven't been parsed yet, with search, sort, multi-select and parse buttons.

use std::collections::HashSet;
use std::path::PathBuf;

use cs2da_core::parser::{UnparsedDemo, unparsed_demos};
use gpui_kit::component::checkbox::Checkbox;
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::{IconName, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::i18n::t;
use crate::parsing::{self, ParseQueueEvent};
use crate::theme;
use crate::ui;
use gpui_kit::component::scroll::ScrollableElement as _;

#[derive(Clone, Copy, PartialEq, Eq)]
enum SortBy {
    Name,
    Date,
    Size,
}

pub struct UnparsedScreen {
    demos: Option<Vec<UnparsedDemo>>,
    search: Entity<InputState>,
    selected: HashSet<PathBuf>,
    sort: SortBy,
    ascending: bool,
    _subscriptions: Vec<Subscription>,
}

impl UnparsedScreen {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let search = cx.new(|cx| InputState::new(window, cx).placeholder(t("unparsedDemos.searchPlaceholder")));
        let subs = vec![
            cx.subscribe(&search, |_, _, e: &InputEvent, cx| {
                if matches!(e, InputEvent::Change) {
                    cx.notify();
                }
            }),
            // New or removed .dem files in the watched folders (Electron reloads 1 s after an add).
            cx.subscribe(&crate::watcher::entity(cx), |this, _, _: &crate::watcher::DemoFolderEvent, cx| this.reload(cx)),
            // Electron refreshes the list when the parsing modal closes.
            cx.subscribe(&parsing::queue(cx), |this, _, e: &ParseQueueEvent, cx| {
                if matches!(e, ParseQueueEvent::QueueFinished) {
                    this.reload(cx);
                }
            }),
        ];
        let mut this = Self {
            demos: None,
            search,
            selected: HashSet::new(),
            sort: SortBy::Date,
            ascending: false,
            _subscriptions: subs,
        };
        this.reload(cx);
        this
    }

    pub fn reload(&mut self, cx: &mut Context<Self>) {
        self.demos = None;
        self.selected.clear();
        cx.spawn(async move |this, cx| {
            let demos = cx.background_spawn(async { unparsed_demos() }).await;
            this.update(cx, |this, cx| {
                this.demos = Some(demos);
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    fn visible(&self, cx: &App) -> Vec<UnparsedDemo> {
        let query = self.search.read(cx).value().to_lowercase();
        let mut v: Vec<UnparsedDemo> = self
            .demos
            .iter()
            .flatten()
            .filter(|d| d.file_name.to_lowercase().contains(&query))
            .cloned()
            .collect();
        v.sort_by(|a, b| {
            let ord = match self.sort {
                SortBy::Name => a.file_name.cmp(&b.file_name),
                SortBy::Date => a.created.cmp(&b.created),
                SortBy::Size => a.file_size.cmp(&b.file_size),
            };
            if self.ascending { ord } else { ord.reverse() }
        });
        v
    }

    fn parse(&mut self, paths: Vec<PathBuf>, cx: &mut Context<Self>) {
        if paths.is_empty() {
            crate::toast::push(crate::toast::Kind::Info, t("unparsedDemos.selectDemosFirst"), 3000, cx);
            return;
        }
        parsing::parse_demos(paths, cx);
    }
}

impl Render for UnparsedScreen {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let visible = self.visible(cx);
        let all_selected = !visible.is_empty() && visible.iter().all(|d| self.selected.contains(&d.file_path));
        let visible_paths: Vec<PathBuf> = visible.iter().map(|d| d.file_path.clone()).collect();
        let selected_count = self.selected.len();

        let sort_button = |id: &'static str, label: String, sort: SortBy, cx: &mut Context<Self>| {
            let active = self.sort == sort;
            div()
                .id(id)
                .px_3()
                .py_1p5()
                .rounded_md()
                .text_sm()
                .cursor_pointer()
                .when(active, |d| d.bg(theme::accent()).text_color(theme::text()))
                .when(!active, |d| d.bg(theme::surface()).text_color(theme::text_soft()).hover(|s| s.bg(rgba(0x36393ecc))))
                .child(label)
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.sort = sort;
                    cx.notify();
                }))
        };

        let controls = v_flex()
            .gap_3()
            .p_4()
            .rounded_lg()
            .bg(theme::secondary())
            .border_1()
            .border_color(theme::border())
            .child(
                h_flex()
                    .gap_3()
                    .child(
                        div()
                            .flex_1()
                            .child(Input::new(&self.search).prefix(div().text_color(rgb(0x6b7280)).child(IconName::Search))),
                    )
                    .child(
                        ui::button("parse-selected", format!("▶ {} ({selected_count})", t("unparsedDemos.parseSelected")), true)
                            .when(selected_count == 0, |d| d.opacity(0.5))
                            .on_click(cx.listener(|this, _, _, cx| {
                                let paths: Vec<PathBuf> = this.selected.iter().cloned().collect();
                                this.parse(paths, cx);
                            })),
                    )
                    .child(
                        ui::button("unparsed-refresh", t("unparsedDemos.refresh"), false)
                            .on_click(cx.listener(|this, _, _, cx| this.reload(cx))),
                    ),
            )
            .child(
                h_flex()
                    .gap_2()
                    .items_center()
                    .child(div().text_sm().text_color(theme::text_muted()).child(format!("{}:", t("unparsedDemos.sortBy"))))
                    .child(sort_button("sort-name", t("unparsedDemos.sortByName"), SortBy::Name, cx))
                    .child(sort_button("sort-date", t("unparsedDemos.sortByDate"), SortBy::Date, cx))
                    .child(sort_button("sort-size", t("unparsedDemos.sortBySize"), SortBy::Size, cx))
                    .child(
                        div()
                            .id("sort-dir")
                            .px_3()
                            .py_1p5()
                            .rounded_md()
                            .bg(theme::surface())
                            .cursor_pointer()
                            .child(if self.ascending { "↑" } else { "↓" })
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.ascending = !this.ascending;
                                cx.notify();
                            })),
                    ),
            );

        let content: AnyElement = match &self.demos {
            None => ui::centered_note(t("matches.loading")).into_any_element(),
            Some(all) if all.is_empty() => v_flex()
                .py_16()
                .items_center()
                .gap_2()
                .text_color(theme::text_muted())
                .child(t("unparsedDemos.noDemosFound"))
                .child(div().text_sm().child(t("unparsedDemos.checkFolderSettings")))
                .into_any_element(),
            Some(_) if visible.is_empty() => ui::centered_note(t("unparsedDemos.noMatches")).into_any_element(),
            Some(_) => {
                let header = h_flex()
                    .gap_4()
                    .px_4()
                    .py_3()
                    .bg(theme::surface())
                    .text_xs()
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(theme::text_muted())
                    .child(Checkbox::new("select-all").checked(all_selected).on_click(cx.listener(move |this, checked: &bool, _, cx| {
                        if *checked {
                            this.selected.extend(visible_paths.iter().cloned());
                        } else {
                            this.selected.clear();
                        }
                        cx.notify();
                    })))
                    .child(div().flex_1().child(t("unparsedDemos.fileName")))
                    .child(div().w(px(110.)).child(t("unparsedDemos.fileSize")))
                    .child(div().w(px(170.)).child(t("unparsedDemos.created")))
                    .child(div().w(px(80.)).child(t("unparsedDemos.actions")));
                let rows = visible.iter().enumerate().map(|(i, d)| {
                    let checked = self.selected.contains(&d.file_path);
                    let (toggle, parse, show) = (d.file_path.clone(), d.file_path.clone(), d.file_path.clone());
                    h_flex()
                        .gap_4()
                        .px_4()
                        .py_2p5()
                        .border_t_1()
                        .border_color(theme::border())
                        .text_sm()
                        .hover(|s| s.bg(rgba(0x36393e80)))
                        .child(Checkbox::new(SharedString::from(format!("demo-{i}"))).checked(checked).on_click(cx.listener(
                            move |this, _, _, cx| {
                                if !this.selected.remove(&toggle) {
                                    this.selected.insert(toggle.clone());
                                }
                                cx.notify();
                            },
                        )))
                        .child(div().flex_1().min_w_0().truncate().child(d.file_name.clone()))
                        .child(div().w(px(110.)).text_color(theme::text_muted()).child(file_size(d.file_size)))
                        .child(div().w(px(170.)).text_color(theme::text_muted()).child(created(d.created)))
                        .child(
                            h_flex()
                                .w(px(80.))
                                .gap_1()
                                .child(ui::icon_button(SharedString::from(format!("parse-{i}")), IconName::Play).on_click(
                                    cx.listener(move |this, _, _, cx| this.parse(vec![parse.clone()], cx)),
                                ))
                                .child(
                                    ui::icon_button(SharedString::from(format!("show-{i}")), IconName::FolderOpen)
                                        .on_click(move |_, _, _| ui::show_in_folder(&show)),
                                ),
                        )
                });
                v_flex()
                    .rounded_lg()
                    .overflow_hidden()
                    .border_1()
                    .border_color(theme::border())
                    .bg(theme::secondary())
                    .child(header)
                    .children(rows)
                    .into_any_element()
            }
        };

        div()
            .id("unparsed-scroll")
            .size_full()
            .overflow_y_scrollbar()
            .p_6()
            .child(
                v_flex()
                    .gap_1()
                    .mb_6()
                    .child(div().text_2xl().font_weight(FontWeight::BOLD).child(t("unparsedDemos.title")))
                    .child(div().text_color(theme::text_muted()).child(t("unparsedDemos.description"))),
            )
            .child(v_flex().gap_4().child(controls).child(content))
    }
}

/// Electron `formatFileSize`: two decimals at most.
fn file_size(bytes: u64) -> String {
    if bytes == 0 {
        return "0 B".into();
    }
    const SIZES: [&str; 4] = ["B", "KB", "MB", "GB"];
    let i = ((bytes as f64).ln() / 1024f64.ln()).floor().min(3.0) as usize;
    let v = (bytes as f64 / 1024f64.powi(i as i32) * 100.0).round() / 100.0;
    format!("{v} {}", SIZES[i])
}

/// Electron's `toLocaleDateString(…, {year, month: 'short', day, hour, minute})`, e.g. "Sep 24, 2026, 12:53 PM".
fn created(secs: u64) -> String {
    use chrono::TimeZone as _;
    chrono::Local
        .timestamp_opt(secs as i64, 0)
        .single()
        .map_or_else(String::new, |d| d.format("%b %-d, %Y, %I:%M %p").to_string())
}
