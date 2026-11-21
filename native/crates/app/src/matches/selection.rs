//! Match grid selection and the card right-click menu (Electron `MatchListPanel`):
//! Ctrl+click / Ctrl+drag rubber-band selection, Esc / Delete / Enter keys,
//! Open folder, Reparse, Show in DB, Parser logs, Select/Deselect, Delete.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::rc::Rc;

use cs2da_core::MatchInfo;
use gpui_kit::component::{IconName, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::i18n::{t, tf};
use crate::theme;
use crate::ui;
use gpui_kit::component::scroll::ScrollableElement as _;

/// Pixels the mouse has to move before a Ctrl+drag counts as a rubber band.
const DRAG_THRESHOLD: f32 = 5.;

pub struct ContextMenu {
    pub position: Point<Pixels>,
    pub match_id: String,
    pub demo_path: Option<PathBuf>,
}

pub struct ParserLogs {
    pub match_id: String,
    pub text: Result<String, String>,
    pub copied: bool,
}

#[derive(Default)]
pub struct GridSelection {
    pub selected: HashSet<String>,
    pub menu: Option<ContextMenu>,
    pub confirm_delete: bool,
    pub logs: Option<ParserLogs>,
    /// Ctrl+drag rubber band: start and current mouse position.
    pub drag: Option<(Point<Pixels>, Point<Pixels>)>,
    /// Cards touched by the current drag (kept even after they scroll away, like Electron).
    pub drag_hits: HashSet<String>,
    /// Each card's on-screen bounds from the last frame, for hit-testing the rubber band.
    pub card_bounds: Rc<RefCell<HashMap<String, Bounds<Pixels>>>>,
}

impl GridSelection {
    pub fn toggle(&mut self, id: &str) {
        if !self.selected.remove(id) {
            self.selected.insert(id.to_string());
        }
    }

    pub fn open_menu(&mut self, m: &MatchInfo, position: Point<Pixels>) {
        self.menu = Some(ContextMenu { position, match_id: m.id.clone(), demo_path: m.demo_path.clone() });
    }

    /// Context-menu Delete: a selected card deletes the whole selection, otherwise just that card.
    pub fn delete_from_menu(&mut self, id: &str) {
        if !self.selected.contains(id) {
            self.selected = HashSet::from([id.to_string()]);
        }
        self.menu = None;
        self.confirm_delete = true;
    }

    pub fn show_logs(&mut self, id: &str) {
        self.menu = None;
        let text = match cs2da_core::matches::parser_logs(id) {
            Ok(Some(logs)) => Ok(logs),
            Ok(None) => Ok("No logs available for this demo".into()),
            Err(e) => Err(format!("Failed to load parser logs: {e}")),
        };
        self.logs = Some(ParserLogs { match_id: id.to_string(), text, copied: false });
    }

    pub fn start_drag(&mut self, at: Point<Pixels>) {
        self.drag = Some((at, at));
        self.drag_hits.clear();
    }

    pub fn drag_rect(&self) -> Option<Bounds<Pixels>> {
        let (a, b) = self.drag?;
        let moved = (f32::from(b.x - a.x)).abs() > DRAG_THRESHOLD || (f32::from(b.y - a.y)).abs() > DRAG_THRESHOLD;
        moved.then(|| Bounds::from_corners(point(a.x.min(b.x), a.y.min(b.y)), point(a.x.max(b.x), a.y.max(b.y))))
    }

    pub fn update_drag(&mut self, to: Point<Pixels>) {
        let Some((start, _)) = self.drag else { return };
        self.drag = Some((start, to));
        if let Some(rect) = self.drag_rect() {
            for (id, b) in self.card_bounds.borrow().iter() {
                if b.intersects(&rect) {
                    self.drag_hits.insert(id.clone());
                }
            }
        }
    }

    pub fn end_drag(&mut self) {
        if self.drag.take().is_some() {
            self.selected.extend(self.drag_hits.drain());
        }
    }

    /// Selection state of a card for drawing: (selected, previewed by the current drag).
    pub fn card_state(&self, id: &str) -> (bool, bool) {
        (self.selected.contains(id), self.drag_hits.contains(id))
    }
}

/// The ✓ badge in a selected card's corner.
pub fn check_badge(preview: bool) -> impl IntoElement {
    div()
        .absolute()
        .top_2()
        .left_2()
        .size_6()
        .rounded_sm()
        .border_2()
        .flex()
        .items_center()
        .justify_center()
        .when(!preview, |d| d.bg(theme::accent()).border_color(theme::accent()))
        .when(preview, |d| d.bg(rgba(0xd07a2d99)).border_color(rgba(0xd07a2dcc)))
        .text_color(theme::text())
        .child(IconName::Check)
}

/// Records a card's window bounds each frame so the rubber band can hit-test it.
pub fn bounds_probe(id: String, store: Rc<RefCell<HashMap<String, Bounds<Pixels>>>>) -> impl IntoElement {
    canvas(
        move |bounds, _, _| {
            store.borrow_mut().insert(id.clone(), bounds);
        },
        |_, _, _, _| {},
    )
    .absolute()
    .inset_0()
}

pub fn menu_item(id: &'static str, icon: IconName, label: String, enabled: bool) -> Stateful<Div> {
    h_flex()
        .id(id)
        .gap_2()
        .px_4()
        .py_2()
        .text_sm()
        .when(enabled, |d| d.cursor_pointer().hover(|s| s.bg(theme::surface())))
        .when(!enabled, |d| d.opacity(0.5))
        .child(icon)
        .child(label)
}

/// Electron's "Delete Matches" confirmation.
pub fn delete_dialog(count: usize, on_cancel: impl Fn(&mut Window, &mut App) + 'static, on_delete: impl Fn(&mut Window, &mut App) + 'static) -> impl IntoElement {
    let plural = crate::i18n::match_plural(count);
    let count_s = count.to_string();
    div()
        .id("delete-matches-backdrop")
        .absolute()
        .inset_0()
        .bg(rgba(0x000000aa))
        .occlude()
        .flex()
        .items_center()
        .justify_center()
        .child(
            v_flex()
                .w(px(460.))
                .gap_4()
                .p_6()
                .rounded_lg()
                .bg(theme::secondary())
                .border_1()
                .border_color(theme::border())
                .child(div().text_lg().font_weight(FontWeight::SEMIBOLD).child(t("matches.deleteMatches")))
                .child(
                    h_flex()
                        .gap_3()
                        .child(div().text_color(rgb(0xf87171)).child(IconName::Delete))
                        .child(div().font_weight(FontWeight::MEDIUM).child(t("matches.deleteConfirmTitle"))),
                )
                .child(div().text_sm().text_color(theme::text_soft()).child(tf(
                    "matches.deleteConfirmDesc",
                    &[("count", &count_s), ("plural", plural)],
                )))
                .child(div().text_sm().text_color(rgb(0xf87171)).child(t("matches.deleteConfirmWarning")))
                .child(
                    h_flex()
                        .justify_end()
                        .gap_2()
                        .child(ui::button("delete-cancel", t("settings.cancel"), false).on_click(move |_, w, cx| on_cancel(w, cx)))
                        .child(
                            div()
                                .id("delete-confirm")
                                .px_3()
                                .py_1p5()
                                .rounded_md()
                                .bg(rgb(0xdc2626))
                                .hover(|s| s.bg(rgb(0xb91c1c)))
                                .text_sm()
                                .font_weight(FontWeight::MEDIUM)
                                .cursor_pointer()
                                .child(tf("matches.deleteButton", &[("count", &count_s), ("plural", plural)]))
                                .on_click(move |_, w, cx| on_delete(w, cx)),
                        ),
                ),
        )
}

/// Electron `ParserLogsModal`.
pub fn logs_dialog(
    logs: &ParserLogs,
    on_copy: impl Fn(&mut Window, &mut App) + 'static,
    on_close: impl Fn(&mut Window, &mut App) + 'static,
) -> impl IntoElement {
    let body: AnyElement = match &logs.text {
        Err(e) => div().text_sm().text_color(rgb(0xfca5a5)).child(e.clone()).into_any_element(),
        Ok(text) => v_flex()
            .gap_3()
            .child(
                h_flex().justify_end().child(
                    ui::button("copy-logs", if logs.copied { "✓ Copied!" } else { "Copy to Clipboard" }, false)
                        .on_click(move |_, w, cx| on_copy(w, cx)),
                ),
            )
            .child(
                v_flex()
                    .id("parser-logs-text")
                    .h(px(520.))
                    .overflow_y_scrollbar()
                    .p_3()
                    .rounded_md()
                    .bg(rgb(0x111214))
                    .font_family("Consolas")
                    .text_xs()
                    .text_color(theme::text_soft())
                    .children(text.lines().map(|l| div().child(l.to_string()))),
            )
            .into_any_element(),
    };
    div()
        .id("parser-logs-backdrop")
        .absolute()
        .inset_0()
        .bg(rgba(0x000000aa))
        .occlude()
        .flex()
        .items_center()
        .justify_center()
        .child(
            v_flex()
                .w(px(900.))
                .gap_4()
                .p_6()
                .rounded_lg()
                .bg(theme::secondary())
                .border_1()
                .border_color(theme::border())
                .child(
                    h_flex()
                        .justify_between()
                        .child(div().text_lg().font_weight(FontWeight::SEMIBOLD).child(format!("Parser Logs · {}", logs.match_id)))
                        .child(ui::icon_button("close-logs", IconName::Close).on_click(move |_, w, cx| on_close(w, cx))),
                )
                .child(body),
        )
}
