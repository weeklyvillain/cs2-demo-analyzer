//! DB Viewer (Electron `DBViewerScreen`): browse a match database's tables and run
//! read-only queries. Shown in the sidebar when Settings → Advanced → DB viewer is on.

use cs2da_core::dbview::{self, QueryResult, TableInfo};
use cs2da_core::matches::list_matches;
use gpui_kit::component::input::{Textarea, TextareaState};
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::format;
use crate::i18n::{t, tf};
use crate::theme;
use crate::ui;
use gpui_kit::component::scroll::ScrollableElement as _;

const CELL_WIDTH: f32 = 160.;

pub struct DbViewerScreen {
    matches: Vec<(String, String)>,
    selected_match: Option<String>,
    tables: Vec<String>,
    selected_table: Option<String>,
    table_info: Option<TableInfo>,
    table_rows: Option<QueryResult>,
    query: Entity<TextareaState>,
    query_result: Option<QueryResult>,
    error: Option<String>,
}

impl DbViewerScreen {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let query = cx.new(|cx| TextareaState::new(window, cx).rows(6).placeholder(t("dbviewer.queryPlaceholder")));
        let mut this = Self {
            matches: Vec::new(),
            selected_match: None,
            tables: Vec::new(),
            selected_table: None,
            table_info: None,
            table_rows: None,
            query,
            query_result: None,
            error: None,
        };
        this.load_matches(cx);
        this
    }

    fn load_matches(&mut self, cx: &mut Context<Self>) {
        match list_matches() {
            Ok(list) => {
                self.matches = list.into_iter().map(|m| (m.id, m.map)).collect();
                if self.selected_match.is_none() {
                    if let Some((id, _)) = self.matches.first().cloned() {
                        self.select_match(id, cx);
                    }
                }
            }
            Err(e) => self.error = Some(format!("{}: {e}", t("dbviewer.failedToLoadMatches"))),
        }
    }

    /// Jump here with a match preselected (match card → "Show in DB").
    pub fn open_match(&mut self, match_id: String, cx: &mut Context<Self>) {
        self.load_matches(cx);
        self.select_match(match_id, cx);
    }

    fn select_match(&mut self, id: String, cx: &mut Context<Self>) {
        self.selected_match = Some(id.clone());
        self.query_result = None;
        self.error = None;
        match dbview::list_tables(&id) {
            Ok(tables) => {
                self.tables = tables;
                let first = self.tables.first().cloned();
                self.selected_table = None;
                if let Some(table) = first {
                    self.select_table(table, cx);
                }
            }
            Err(e) => {
                self.tables.clear();
                self.error = Some(format!("{}: {e}", t("dbviewer.failedToLoadTables")));
            }
        }
        cx.notify();
    }

    fn select_table(&mut self, table: String, cx: &mut Context<Self>) {
        let Some(id) = self.selected_match.clone() else { return };
        self.selected_table = Some(table.clone());
        self.table_info = dbview::table_info(&id, &table)
            .map_err(|e| self.error = Some(format!("{}: {e}", t("dbviewer.failedToLoadTableInfo"))))
            .ok();
        self.table_rows = dbview::preview_rows(&id, &table)
            .map_err(|e| self.error = Some(format!("{}: {e}", t("dbviewer.failedToLoadTableRows"))))
            .ok();
        cx.notify();
    }

    fn run_query(&mut self, cx: &mut Context<Self>) {
        let Some(id) = self.selected_match.clone() else { return };
        let sql = self.query.read(cx).value().to_string();
        if sql.trim().is_empty() {
            return;
        }
        self.error = None;
        self.query_result = None;
        match dbview::run_query(&id, &sql) {
            Ok(r) => self.query_result = Some(r),
            Err(e) => self.error = Some(e.to_string()),
        }
        cx.notify();
    }

    fn panel(title: impl Into<SharedString>) -> Div {
        v_flex()
            .gap_3()
            .p_4()
            .rounded_lg()
            .bg(theme::secondary())
            .border_1()
            .border_color(theme::border())
            .child(div().font_weight(FontWeight::SEMIBOLD).child(title.into()))
    }

    fn match_picker(&self, cx: &mut Context<Self>) -> impl IntoElement {
        Self::panel(t("dbviewer.selectMatch")).child(
            v_flex()
                .id("db-match-list")
                .max_h(px(220.))
                .overflow_y_scrollbar()
                .gap_1()
                .children(self.matches.iter().map(|(id, map)| {
                    let active = self.selected_match.as_deref() == Some(id.as_str());
                    let pick = id.clone();
                    div()
                        .id(SharedString::from(format!("db-match-{id}")))
                        .px_3()
                        .py_1p5()
                        .rounded_sm()
                        .text_sm()
                        .truncate()
                        .cursor_pointer()
                        .when(active, |d| d.bg(theme::accent()).text_color(theme::text()))
                        .when(!active, |d| d.bg(theme::surface()).text_color(theme::text_soft()).hover(|s| s.bg(rgba(0x36393ecc))))
                        .child(format!("{} ({id})", format::map_name(map)))
                        .on_click(cx.listener(move |this, _, _, cx| this.select_match(pick.clone(), cx)))
                })),
        )
    }

    fn table_list(&self, cx: &mut Context<Self>) -> impl IntoElement {
        Self::panel(t("dbviewer.tables")).child(v_flex().gap_1().children(self.tables.iter().map(|table| {
            let active = self.selected_table.as_deref() == Some(table.as_str());
            let pick = table.clone();
            div()
                .id(SharedString::from(format!("db-table-{table}")))
                .px_3()
                .py_2()
                .rounded_sm()
                .text_sm()
                .cursor_pointer()
                .when(active, |d| d.bg(theme::accent()).text_color(theme::text()))
                .when(!active, |d| d.bg(theme::surface()).text_color(theme::text_soft()).hover(|s| s.bg(rgba(0x36393ecc))))
                .child(table.clone())
                .on_click(cx.listener(move |this, _, _, cx| this.select_table(pick.clone(), cx)))
        })))
    }

    fn table_info_panel(&self, info: &TableInfo) -> impl IntoElement {
        Self::panel(t("dbviewer.tableInfo"))
            .child(
                h_flex()
                    .gap_1()
                    .text_sm()
                    .child(div().text_color(theme::text_muted()).child(t("dbviewer.rows")))
                    .child(div().font_weight(FontWeight::SEMIBOLD).child(thousands(info.row_count))),
            )
            .child(div().text_sm().text_color(theme::text_muted()).child(t("dbviewer.schema")))
            .child(
                div()
                    .p_3()
                    .rounded_md()
                    .bg(theme::primary())
                    .text_xs()
                    .font_family("Consolas")
                    .text_color(theme::text_soft())
                    .child(if info.schema.is_empty() { "N/A".to_string() } else { info.schema.clone() }),
            )
    }
}

/// A scrollable grid of query results; NULL cells shown dimmed like Electron.
fn results_table(id: &str, result: &QueryResult) -> impl IntoElement {
    let width = px(CELL_WIDTH * result.columns.len().max(1) as f32);
    let cell = |text: Option<&String>| {
        div()
            .w(px(CELL_WIDTH))
            .flex_shrink_0()
            .px_2()
            .py_1()
            .truncate()
            .map(|d| match text {
                Some(s) => d.child(s.clone()),
                None => d.italic().text_color(rgb(0x6b7280)).child(t("dbviewer.null")),
            })
    };
    div()
        .max_h(px(420.))
        .overflow_scrollbar()
        .id(SharedString::from(id.to_string()))
        .rounded_md()
        .border_1()
        .border_color(theme::border())
        .text_xs()
        .child(
            v_flex()
                .w(width)
                .child(
                    h_flex()
                        .bg(theme::surface())
                        .font_weight(FontWeight::SEMIBOLD)
                        .children(result.columns.iter().map(|c| cell(Some(c)))),
                )
                .children(result.rows.iter().enumerate().map(|(i, row)| {
                    h_flex()
                        .border_t_1()
                        .border_color(rgba(0x42454980))
                        .when(i % 2 == 1, |d| d.bg(rgba(0xffffff05)))
                        .children(row.iter().map(|v| cell(v.as_ref())))
                })),
        )
}

/// `1234567` -> `1,234,567` (Electron `toLocaleString`).
fn thousands(n: i64) -> String {
    let s = n.abs().to_string();
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    if n < 0 { format!("-{out}") } else { out }
}

impl Render for DbViewerScreen {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let left = v_flex()
            .w(px(320.))
            .flex_shrink_0()
            .gap_4()
            .child(self.match_picker(cx))
            .when(self.selected_match.is_some(), |d| d.child(self.table_list(cx)))
            .when_some(self.table_info.clone(), |d, info| d.child(self.table_info_panel(&info)));

        let table_data = self.selected_table.clone().map(|table| {
            let shown = self.table_rows.as_ref().map_or(0, |r| r.rows.len());
            let total = self.table_info.as_ref().map_or(0, |i| i.row_count);
            Self::panel(format!("{} {table}", t("dbviewer.tableData")))
                .child(match &self.table_rows {
                    Some(rows) if rows.rows.is_empty() => {
                        div().text_sm().text_color(theme::text_muted()).child(t("dbviewer.noRows")).into_any_element()
                    }
                    Some(rows) => results_table("db-table-rows", rows).into_any_element(),
                    None => div().text_sm().text_color(theme::text_muted()).child(t("dbviewer.noData")).into_any_element(),
                })
                .when(total > shown as i64, |d| {
                    d.child(div().text_xs().text_color(theme::text_muted()).child(tf(
                        "dbviewer.showingRows",
                        &[("showing", &shown.to_string()), ("total", &thousands(total))],
                    )))
                })
        });

        let runner = Self::panel(t("dbviewer.queryRunner"))
            .child(Textarea::new(&self.query))
            .child(
                h_flex()
                    .gap_3()
                    .child(
                        ui::button("run-query", t("dbviewer.runQuery"), true)
                            .on_click(cx.listener(|this, _, _, cx| this.run_query(cx))),
                    )
                    .child(div().text_xs().text_color(rgb(0x6b7280)).child(t("dbviewer.queryHint"))),
            );

        let results = self.query_result.as_ref().map(|r| {
            Self::panel(t("dbviewer.results")).child(if r.rows.is_empty() {
                div().text_sm().text_color(theme::text_muted()).child(t("dbviewer.noResults")).into_any_element()
            } else {
                results_table("db-query-rows", r).into_any_element()
            })
        });

        div()
            .id("db-viewer-scroll")
            .size_full()
            .overflow_y_scrollbar()
            .p_6()
            .child(
                v_flex()
                    .gap_1()
                    .mb_6()
                    .child(div().text_2xl().font_weight(FontWeight::BOLD).child(t("dbviewer.title")))
                    .child(div().text_color(theme::text_muted()).child(t("dbviewer.subtitle"))),
            )
            .when_some(self.error.clone(), |d, e| {
                d.child(
                    div()
                        .mb_4()
                        .px_4()
                        .py_3()
                        .rounded_md()
                        .border_1()
                        .border_color(rgb(0xb91c1c))
                        .bg(rgba(0x7f1d1d33))
                        .text_sm()
                        .text_color(rgb(0xfca5a5))
                        .child(e),
                )
            })
            .child(
                h_flex()
                    .items_start()
                    .gap_6()
                    .child(left)
                    .child(
                        v_flex()
                            .flex_1()
                            .min_w_0()
                            .gap_4()
                            .children(table_data)
                            .child(runner)
                            .children(results),
                    ),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::thousands;

    #[test]
    fn groups_thousands() {
        assert_eq!(thousands(311431), "311,431");
        assert_eq!(thousands(12), "12");
        assert_eq!(thousands(1000), "1,000");
    }
}
