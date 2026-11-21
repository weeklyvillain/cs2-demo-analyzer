//! Statistics screen (Electron `StatsScreen`), backed by `stats.sqlite`.

use std::collections::BTreeMap;

use cs2da_core::stats::Stats;
use gpui_kit::component::{IconName, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::i18n::t;
use crate::theme;
use crate::ui;
use gpui_kit::component::scroll::ScrollableElement as _;

pub struct StatsScreen {
    stats: BTreeMap<String, i64>,
    confirm_reset: bool,
    notice: Option<(String, bool)>,
}

impl StatsScreen {
    pub fn new(_window: &mut Window, _cx: &mut Context<Self>) -> Self {
        let mut this = Self { stats: BTreeMap::new(), confirm_reset: false, notice: None };
        this.load();
        this
    }

    fn load(&mut self) {
        match Stats::open() {
            Ok(s) => self.stats = s.all(),
            Err(_) => self.notice = Some((t("stats.loadFailed"), true)),
        }
    }

    fn get(&self, key: &str) -> i64 {
        self.stats.get(key).copied().unwrap_or(0)
    }

    fn reset(&mut self, cx: &mut Context<Self>) {
        let ok = Stats::open().and_then(|s| s.reset()).is_ok();
        self.load();
        self.confirm_reset = false;
        self.notice = Some(if ok { (t("stats.resetSuccess"), false) } else { (t("stats.resetFailed"), true) });
        cx.notify();
    }

    fn card(icon: Option<IconName>, title: String) -> Div {
        v_flex()
            .gap_4()
            .p_6()
            .rounded_lg()
            .bg(theme::secondary())
            .border_1()
            .border_color(theme::border())
            .child(
                h_flex()
                    .gap_2()
                    .when_some(icon, |d, i| d.child(div().text_color(theme::accent()).child(i)))
                    .child(div().text_lg().font_weight(FontWeight::SEMIBOLD).child(title)),
            )
    }

    fn row(label: String, value: String, big: bool) -> impl IntoElement {
        h_flex()
            .justify_between()
            .items_center()
            .child(div().text_color(theme::text_muted()).child(label))
            .child(
                div()
                    .when(big, |d| d.text_2xl().font_weight(FontWeight::BOLD).text_color(theme::accent()))
                    .when(!big, |d| d.font_weight(FontWeight::SEMIBOLD))
                    .child(value),
            )
    }

    fn confirm_dialog(&self, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .id("reset-backdrop")
            .absolute()
            .inset_0()
            .bg(rgba(0x000000aa))
            .occlude()
            .flex()
            .items_center()
            .justify_center()
            .child(
                v_flex()
                    .w(px(440.))
                    .gap_4()
                    .p_6()
                    .rounded_lg()
                    .bg(theme::secondary())
                    .border_1()
                    .border_color(theme::border())
                    .child(div().text_lg().font_weight(FontWeight::SEMIBOLD).child(t("stats.resetConfirmTitle")))
                    .child(div().text_sm().text_color(theme::text_soft()).child(t("stats.resetConfirmMessage")))
                    .child(
                        h_flex()
                            .justify_end()
                            .gap_2()
                            .child(ui::button("reset-cancel", t("settings.cancel"), false).on_click(cx.listener(
                                |this, _, _, cx| {
                                    this.confirm_reset = false;
                                    cx.notify();
                                },
                            )))
                            .child(
                                div()
                                    .id("reset-confirm")
                                    .px_3()
                                    .py_1p5()
                                    .rounded_md()
                                    .bg(rgb(0xdc2626))
                                    .hover(|s| s.bg(rgb(0xb91c1c)))
                                    .text_sm()
                                    .font_weight(FontWeight::MEDIUM)
                                    .cursor_pointer()
                                    .child(t("stats.resetStats"))
                                    .on_click(cx.listener(|this, _, _, cx| this.reset(cx))),
                            ),
                    ),
            )
    }
}

impl Render for StatsScreen {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let parsed = self.get("total_demos_parsed");
        let avg_size = if parsed > 0 { self.get("total_demo_size") as f64 / parsed as f64 } else { 0.0 };
        let avg_time = if parsed > 0 { self.get("total_parsing_time_ms") as f64 / parsed as f64 } else { 0.0 };

        let mut maps: Vec<(String, i64)> = self
            .stats
            .iter()
            .filter_map(|(k, v)| k.strip_prefix("map_parsed_").map(|m| (m.to_string(), *v)))
            .collect();
        maps.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));

        let header = h_flex()
            .gap_3()
            .mb_6()
            .items_center()
            .child(div().text_color(theme::accent()).child(IconName::ChartPie))
            .child(div().flex_1().text_2xl().font_weight(FontWeight::BOLD).child(t("stats.title")))
            .child(
                ui::button("stats-refresh", t("stats.refresh"), false).on_click(cx.listener(|this, _, _, cx| {
                    this.load();
                    cx.notify();
                })),
            )
            .child(
                ui::button("stats-reset", t("stats.resetStats"), false).on_click(cx.listener(|this, _, _, cx| {
                    this.confirm_reset = true;
                    cx.notify();
                })),
            );

        let overall = Self::card(None, t("stats.overallStatistics"))
            .child(Self::row(t("stats.totalDemosParsed"), parsed.to_string(), true))
            .child(Self::row(t("stats.totalVoicesExtracted"), self.get("voice_files_generated").to_string(), true));
        let performance = Self::card(Some(IconName::HardDrive), t("stats.performanceStats"))
            .child(Self::row(t("stats.largestDemo"), format_bytes(self.get("largest_demo_parsed") as f64), false))
            .child(Self::row(t("stats.smallestDemo"), format_bytes(self.get("smallest_demo_parsed") as f64), false))
            .child(Self::row(t("stats.averageDemo"), format_bytes(avg_size), false));
        let time = Self::card(Some(IconName::Loader), t("stats.timeStats"))
            .child(Self::row(t("stats.totalParsingTime"), format_ms(self.get("total_parsing_time_ms") as f64), false))
            .child(Self::row(t("stats.averageParsingTime"), format_ms(avg_time), false))
            .child(Self::row(t("stats.fastestParsingTime"), format_ms(self.get("fastest_parsing_time_ms") as f64), false))
            .child(Self::row(t("stats.slowestParsingTime"), format_ms(self.get("slowest_parsing_time_ms") as f64), false));
        let voice = Self::card(Some(IconName::Mic), t("stats.extractionStats"))
            .child(Self::row(t("stats.voiceFilesGenerated"), self.get("voice_files_generated").to_string(), false))
            .child(Self::row(
                t("stats.totalVoiceExtracted"),
                format!("{:.2} h", self.get("total_voice_extraction_ms") as f64 / 3_600_000.0),
                false,
            ))
            .child(Self::row(t("stats.shortestVoiceExtraction"), format_ms(self.get("shortest_voice_extraction_ms") as f64), false))
            .child(Self::row(t("stats.longestVoiceExtraction"), format_ms(self.get("longest_voice_extraction_ms") as f64), false));
        let maps_card = Self::card(Some(IconName::Map), t("stats.mapsParsed")).child(if maps.is_empty() {
            div().text_color(theme::text_muted()).child(t("stats.noMapStatistics")).into_any_element()
        } else {
            div()
                .grid()
                .grid_cols(2)
                .gap_3()
                .children(maps.into_iter().map(|(map, count)| {
                    h_flex()
                        .justify_between()
                        .px_4()
                        .py_3()
                        .rounded_md()
                        .bg(theme::surface())
                        .child(map_label(&map))
                        .child(div().font_weight(FontWeight::BOLD).text_color(theme::accent()).child(count.to_string()))
                }))
                .into_any_element()
        });

        div()
            .relative()
            .size_full()
            .child(
                div()
                    .id("stats-scroll")
                    .size_full()
                    .overflow_y_scrollbar()
                    .p_6()
                    .child(header)
                    .when_some(self.notice.clone(), |d, (text, is_error)| {
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
                        v_flex()
                            .gap_6()
                            .child(div().grid().grid_cols(2).gap_6().child(overall).child(performance).child(time).child(voice))
                            .child(maps_card),
                    ),
            )
            .when(self.confirm_reset, |d| d.child(self.confirm_dialog(cx)))
    }
}

/// `de_dust2` -> `Dust2`, `aim_redline_carton` -> `Aim Redline Carton` (Electron `formatMapName`).
fn map_label(map: &str) -> String {
    map.strip_prefix("de_")
        .unwrap_or(map)
        .split('_')
        .map(|w| {
            let mut c = w.chars();
            c.next().map(|f| f.to_uppercase().chain(c).collect::<String>()).unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Electron `formatBytes`: up to two decimals, trailing zeros dropped.
fn format_bytes(bytes: f64) -> String {
    if bytes <= 0.0 {
        return "0 B".into();
    }
    const SIZES: [&str; 4] = ["B", "KB", "MB", "GB"];
    let i = ((bytes.ln() / 1024f64.ln()).floor() as usize).min(SIZES.len() - 1);
    let value = (bytes / 1024f64.powi(i as i32) * 100.0).round() / 100.0;
    format!("{value} {}", SIZES[i])
}

/// Electron `formatTime` for milliseconds: `1h 2m 3s`, `2m 3s`, `3s`.
fn format_ms(ms: f64) -> String {
    let total = (ms / 1000.0).floor() as u64;
    let (h, m, s) = (total / 3600, (total / 60) % 60, total % 60);
    if h > 0 {
        format!("{h}h {m}m {s}s")
    } else if m > 0 {
        format!("{m}m {s}s")
    } else {
        format!("{s}s")
    }
}

#[cfg(test)]
mod tests {
    // Not `super::*`: that brings in gpui-kit's `test` macro and shadows Rust's.
    use super::{format_bytes, format_ms, map_label};

    #[test]
    fn formats_like_electron() {
        assert_eq!(map_label("de_dust2"), "Dust2");
        assert_eq!(map_label("aim_redline_carton"), "Aim Redline Carton");
        assert_eq!(format_bytes(365653248.0), "348.71 MB");
        assert_eq!(format_bytes(1024.0), "1 KB");
        assert_eq!(format_ms(60482.0), "1m 0s");
        assert_eq!(format_ms(1804440.0), "30m 4s");
    }
}
