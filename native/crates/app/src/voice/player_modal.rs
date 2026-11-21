//! Player details modal (Electron `PlayerModal`): the events a player caused, as
//! summary cards and collapsible per-type sections, with an economy details dialog.

use std::collections::{HashMap, HashSet};

use cs2da_core::{MatchEvent, MatchSummary, RosterPlayer};
use gpui_kit::component::{IconName, WindowExt as _, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::format;
use crate::i18n::t;
use crate::theme;
use gpui_kit::component::scroll::ScrollableElement as _;

#[derive(Clone, Copy, PartialEq, Eq)]
enum AfkSort {
    Round,
    Duration,
}

pub struct PlayerModal {
    player: RosterPlayer,
    events: Vec<MatchEvent>,
    names: HashMap<String, String>,
    tick_rate: f64,
    collapsed: HashSet<String>,
    afk_min: f64,
    flash_min: f64,
    afk_sort: AfkSort,
    /// The match's demo; Electron shows the per-event buttons only when it's known.
    demo: Option<std::path::PathBuf>,
    /// Jump the match's 2D viewer to a tick; `None` when the map has no radar (Electron `show2DViewer`).
    view_2d: Option<View2d>,
    /// Round index → freeze-end tick (or start tick), for Economy cards.
    round_ticks: HashMap<i64, i64>,
}

pub type View2d = std::rc::Rc<dyn Fn(i64, &mut Window, &mut App)>;

/// Section title per event type: Electron's `eventTypeLabels`, raw type otherwise.
fn label(kind: &str) -> String {
    match kind {
        "TEAM_KILL" => t("matches.sections.teamKills"),
        "TEAM_DAMAGE" => t("matches.sections.teamDamage"),
        "TEAM_FLASH" => t("matches.sections.teamFlashes"),
        "AFK_STILLNESS" => t("matches.sections.afk"),
        "DISCONNECT" => t("matches.sections.disconnects"),
        "ECONOMY_GRIEF" => "Economy Griefing".into(),
        other => other.into(),
    }
}

fn grief_label(kind: &str) -> String {
    match kind {
        "equipment_mismatch" => "Wrong weapon choice",
        "no_buy_with_team" => "Not buying with team",
        "excessive_saving" => "Excessive saving",
        "full_save_high_money" => "Full save with high money",
        other => other,
    }
    .to_string()
}

/// `toLocaleString()` grouping.
fn money(v: f64) -> String {
    let n = v.round() as i64;
    let digits = n.abs().to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    if n < 0 { format!("-{out}") } else { out }
}

impl PlayerModal {
    /// "Watch this event in CS2" (Electron `handleCopyCommand`: event start, its actor).
    /// Electron: shown with the demo known and a radar for the map; Economy events jump to the
    /// round's freeze end (or start), everything else to the event's start tick.
    fn view_2d_button(&self, e: &MatchEvent) -> Option<AnyElement> {
        self.demo.as_ref()?;
        let view = self.view_2d.clone()?;
        let tick = if e.kind == "ECONOMY_GRIEF" {
            self.round_ticks.get(&e.round_index).copied().unwrap_or(e.start_tick)
        } else {
            e.start_tick
        };
        Some(
            div()
                .id(SharedString::from(format!("pm-2d-{}-{}-{}", e.kind, e.round_index, e.start_tick)))
                .p_1()
                .rounded_sm()
                .cursor_pointer()
                .text_color(theme::text_muted())
                .hover(|s| s.bg(rgba(0xd07a2d33)).text_color(theme::accent()))
                .child(IconName::Map)
                .on_click(move |_, window, cx| {
                    window.close_dialog(cx);
                    view(tick, window, cx);
                })
                .into_any_element(),
        )
    }

    fn watch_button(&self, e: &MatchEvent) -> Option<AnyElement> {
        let demo = self.demo.clone()?;
        let (tick, who) = (e.start_tick, self.name(e.actor.as_deref()));
        Some(
            div()
                .id(SharedString::from(format!("pm-cs2-{}-{}-{}", e.kind, e.round_index, e.start_tick)))
                .p_1()
                .rounded_sm()
                .cursor_pointer()
                .text_color(theme::text_muted())
                .hover(|s| s.bg(rgba(0xd07a2d33)).text_color(theme::accent()))
                .child(IconName::Play)
                .on_click(move |_, window, cx| crate::cs2_watch::watch_event(Some(demo.clone()), tick, who.clone(), window, cx))
                .into_any_element(),
        )
    }

    fn name(&self, id: Option<&str>) -> String {
        match id {
            Some(id) => self.names.get(id).cloned().unwrap_or_else(|| id.to_string()),
            None => t("matches.unknown"),
        }
    }

    /// AFK duration as the modal computes it (`meta.seconds`, else ticks / 64).
    fn afk_secs(e: &MatchEvent, tick_rate: f64) -> f64 {
        e.meta_num("seconds")
            .unwrap_or_else(|| e.end_tick.map_or(0.0, |end| (end - e.start_tick) as f64 / tick_rate))
    }

    /// Electron's `filteredEvents`: no KILL events, AFK below the minimum hidden.
    fn filtered(&self) -> Vec<&MatchEvent> {
        self.events
            .iter()
            .filter(|e| e.kind != "KILL" && e.kind != "KILLS")
            .filter(|e| e.kind != "AFK_STILLNESS" || Self::afk_secs(e, 64.0) >= self.afk_min)
            .collect()
    }

    fn summary_cards(&self, events: &[&MatchEvent]) -> impl IntoElement {
        let count = |k: &str| events.iter().filter(|e| e.kind == k).count();
        let card = |title: &'static str, n: usize, sub: &'static str, color: Rgba| {
            (n > 0).then(|| {
                v_flex()
                    .p_4()
                    .gap_1()
                    .rounded_lg()
                    .bg(theme::surface())
                    .border_1()
                    .border_color(theme::border())
                    .child(div().text_sm().font_weight(FontWeight::MEDIUM).text_color(theme::text_muted()).child(title))
                    .child(div().text_3xl().font_weight(FontWeight::BOLD).text_color(color).child(n.to_string()))
                    .child(div().text_xs().text_color(rgb(0x6b7280)).child(sub))
            })
        };
        div()
            .grid()
            .grid_cols(3)
            .gap_3()
            .children(card("Economy Grief", count("ECONOMY_GRIEF"), "Buy phase / economy griefing", rgb(0xfacc15)))
            .children(card("Team Kills", count("TEAM_KILL"), "Friendly fire kills", rgb(0xf87171)))
            .children(card("Team Damage", count("TEAM_DAMAGE"), "Friendly fire damage events", theme::accent()))
            .children(card("AFK Detections", count("AFK_STILLNESS"), "No movement after freezetime", theme::text()))
            .children(card("Team Flashes", count("TEAM_FLASH"), "Friendly flashbang detonations", theme::accent()))
            .children(card("Disconnects", count("DISCONNECT"), "Player disconnection events", theme::text_muted()))
    }

    fn stepper(id: &'static str, value: f64, step: f64, decimals: usize, cx: &mut Context<Self>, set: fn(&mut Self, f64)) -> impl IntoElement {
        let btn = |suffix: &'static str, icon: IconName, delta: f64, cx: &mut Context<Self>| {
            div()
                .id(SharedString::from(format!("{id}-{suffix}")))
                .px_1p5()
                .cursor_pointer()
                .text_color(theme::text_muted())
                .hover(|s| s.text_color(theme::accent()))
                .child(icon)
                .on_click(cx.listener(move |this, _, _, cx| {
                    set(this, ((value + delta) / step).round() * step);
                    cx.notify();
                }))
        };
        h_flex()
            .items_center()
            .rounded_sm()
            .bg(theme::secondary())
            .border_1()
            .border_color(theme::border())
            .child(btn("dec", IconName::Minus, -step, cx))
            .child(div().w(px(44.)).text_center().text_xs().child(format!("{:.*}", decimals, value.max(0.0))))
            .child(btn("inc", IconName::Plus, step, cx))
    }

    fn event_row(&self, e: &MatchEvent) -> AnyElement {
        let tr = self.tick_rate;
        let mut details: Vec<String> = Vec::new();
        if let Some(w) = e.weapon() {
            details.push(w);
        }
        if let Some(d) = e.meta_num("total_damage") {
            details.push(format!("{d:.1} damage"));
        }
        if let Some(b) = e.meta.get("blind_duration").and_then(|v| v.as_f64()) {
            details.push(format!("{b:.1}s blind"));
        }
        if let Some(s) = e.meta.get("seconds").and_then(|v| v.as_f64()) {
            details.push(format!("{s:.1}s AFK"));
        }
        let reason = (e.kind == "DISCONNECT")
            .then(|| e.meta.get("reason").filter(|r| !r.is_null()).map(cs2da_core::disconnect::format_reason))
            .flatten();
        let time = match e.end_tick {
            Some(end) => format!(
                "{} - {} ({:.1}s)",
                format::clock(e.start_tick, tr),
                format::clock(end, tr),
                (end - e.start_tick) as f64 / tr
            ),
            None => format::clock(e.start_tick, tr),
        };
        v_flex()
            .gap_1()
            .p_3()
            .rounded_md()
            .bg(theme::secondary())
            .border_1()
            .border_color(rgba(0x42454980))
            .child(
                h_flex()
                    .justify_between()
                    .text_sm()
                    .child(div().font_weight(FontWeight::MEDIUM).child(format!("Round {}", e.round_index + 1)))
                    .child(
                        h_flex()
                            .gap_2()
                            .items_center()
                            .children(self.view_2d_button(e))
                            .children(self.watch_button(e))
                            .child(div().text_xs().text_color(theme::text_muted()).child(time)),
                    ),
            )
            .when_some(e.victim.as_deref(), |d, v| {
                d.child(div().text_sm().text_color(theme::text_soft()).child(format!("→ {}", self.name(Some(v)))))
            })
            .when(!details.is_empty(), |d| {
                d.child(h_flex().gap_3().text_xs().text_color(theme::text_muted()).children(details))
            })
            .when_some(reason, |d, r| {
                d.child(
                    h_flex()
                        .gap_1()
                        .text_xs()
                        .child(div().text_color(theme::text_muted()).child("Reason:"))
                        .child(div().text_color(theme::text_soft()).child(r)),
                )
            })
            .into_any_element()
    }

    fn economy_row(&self, e: &MatchEvent, cx: &mut Context<Self>) -> AnyElement {
        let n = |k: &str| e.meta_num(k).unwrap_or(0.0);
        let row = |label: &'static str, value: String| {
            [
                div().text_color(theme::text_muted()).child(label).into_any_element(),
                div().text_color(theme::text_soft()).child(value).into_any_element(),
            ]
        };
        let details = EconomyDetails::new(self, e);
        v_flex()
            .gap_2()
            .p_3()
            .rounded_md()
            .bg(theme::secondary())
            .border_1()
            .border_color(rgba(0xfacc1540))
            .child(
                h_flex()
                    .justify_between()
                    .child(div().font_weight(FontWeight::MEDIUM).child(self.name(e.actor.as_deref())))
                    .child(
                        h_flex()
                            .gap_2()
                            .items_center()
                            .child(
                                div()
                                    .id(SharedString::from(format!("econ-{}-{}", e.round_index, e.start_tick)))
                                    .p_1()
                                    .rounded_sm()
                                    .cursor_pointer()
                                    .text_color(theme::text_muted())
                                    .hover(|s| s.bg(rgba(0xd07a2d33)).text_color(theme::accent()))
                                    .child(IconName::Info)
                                    .on_click(cx.listener(move |_, _, window, cx| details.clone().open(window, cx))),
                            )
                            .children(self.view_2d_button(e))
                            .children(self.watch_button(e))
                            .child(div().text_xs().text_color(theme::text_muted()).child(format!("Round {}", e.round_index + 1))),
                    ),
            )
            .child(div().text_xs().font_weight(FontWeight::MEDIUM).text_color(rgb(0xfacc15)).child(grief_label(e.meta_str("grief_type").unwrap_or("unknown"))))
            .child(
                div()
                    .grid()
                    .grid_cols(2)
                    .gap_x_3()
                    .gap_y_1()
                    .text_xs()
                    .children(row("Start money:", format!("${}", money(n("start_money")))))
                    .children(row("Spent:", format!("${} ({:.1}%)", money(n("money_spent")), n("spend_pct"))))
                    .children(row("Team avg money:", format!("${}", money(n("team_avg_money")))))
                    .children(row("Team avg spent:", format!("${} ({:.1}%)", money(n("team_avg_spend")), n("team_spend_pct")))),
            )
            .into_any_element()
    }
}

impl Render for PlayerModal {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let events = self.filtered();
        if events.is_empty() {
            return v_flex()
                .py_10()
                .items_center()
                .gap_1()
                .child(div().text_color(theme::text_soft()).child("No events found for this player"))
                .child(div().text_sm().text_color(theme::text_muted()).child("This player has no griefing events recorded."))
                .into_any_element();
        }

        // Group by type in first-seen order (JS object key order).
        let mut order: Vec<String> = Vec::new();
        let mut groups: HashMap<String, Vec<&MatchEvent>> = HashMap::new();
        for e in &events {
            if !groups.contains_key(&e.kind) {
                order.push(e.kind.clone());
            }
            groups.entry(e.kind.clone()).or_default().push(e);
        }
        let tr = self.tick_rate;
        for (kind, list) in groups.iter_mut() {
            if kind == "TEAM_DAMAGE" {
                list.sort_by(|a, b| b.meta_num("total_damage").unwrap_or(0.0).total_cmp(&a.meta_num("total_damage").unwrap_or(0.0)));
            } else if kind == "AFK_STILLNESS" && self.afk_sort == AfkSort::Duration {
                list.sort_by(|a, b| Self::afk_secs(b, tr).total_cmp(&Self::afk_secs(a, tr)));
            } else {
                list.sort_by_key(|e| (e.round_index, e.start_tick));
            }
        }

        let summary = self.summary_cards(&events);
        let mut sections: Vec<AnyElement> = Vec::new();
        for kind in order {
            let list = &groups[&kind];
            let collapsed = self.collapsed.contains(&kind);
            let toggle_kind = kind.clone();
            let header = h_flex()
                .id(SharedString::from(format!("pm-sec-{kind}")))
                .justify_between()
                .px_4()
                .py_3()
                .cursor_pointer()
                .hover(|s| s.bg(rgba(0x36393e80)))
                .child(
                    h_flex()
                        .gap_2()
                        .child(div().font_weight(FontWeight::SEMIBOLD).child(label(&kind)))
                        .child(div().text_sm().text_color(theme::text_muted()).child(format!(
                            "({} {})",
                            list.len(),
                            if list.len() == 1 { "event" } else { "events" }
                        ))),
                )
                .child(if collapsed { IconName::ChevronDown } else { IconName::ChevronUp })
                .on_click(cx.listener(move |this, _, _, cx| {
                    if !this.collapsed.remove(&toggle_kind) {
                        this.collapsed.insert(toggle_kind.clone());
                    }
                    cx.notify();
                }));

            let controls: Option<AnyElement> = match kind.as_str() {
                "AFK_STILLNESS" => {
                    let sort_btn = |id: &'static str, text: &'static str, sort: AfkSort, cx: &mut Context<Self>| {
                        let active = self.afk_sort == sort;
                        div()
                            .id(id)
                            .px_2()
                            .py_0p5()
                            .rounded_sm()
                            .text_xs()
                            .cursor_pointer()
                            .when(active, |d| d.bg(theme::accent()))
                            .when(!active, |d| d.bg(theme::secondary()))
                            .child(text)
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.afk_sort = sort;
                                cx.notify();
                            }))
                    };
                    Some(
                        h_flex()
                            .gap_2()
                            .items_center()
                            .text_xs()
                            .text_color(theme::text_muted())
                            .child("Sort by:")
                            .child(sort_btn("pm-afk-round", "Round", AfkSort::Round, cx))
                            .child(sort_btn("pm-afk-dur", "Duration", AfkSort::Duration, cx))
                            .child(div().ml_3().child("Min duration:"))
                            .child(Self::stepper("pm-afk-min", self.afk_min, 0.5, 1, cx, |m, v| m.afk_min = v.max(0.0)))
                            .child("s")
                            .into_any_element(),
                    )
                }
                // Electron shows this input but doesn't filter the list with it.
                "TEAM_FLASH" => Some(
                    h_flex()
                        .gap_2()
                        .items_center()
                        .text_xs()
                        .text_color(theme::text_muted())
                        .child("Min blind:")
                        .child(Self::stepper("pm-flash-min", self.flash_min, 0.1, 1, cx, |m, v| m.flash_min = v.max(0.0)))
                        .child("s")
                        .into_any_element(),
                ),
                _ => None,
            };

            let rows: Vec<AnyElement> = list
                .iter()
                .map(|e| if kind == "ECONOMY_GRIEF" { self.economy_row(e, cx) } else { self.event_row(e) })
                .collect();

            sections.push(
                v_flex()
                    .rounded_lg()
                    .bg(rgba(0x36393e66))
                    .border_1()
                    .border_color(theme::border())
                    .child(header)
                    .when(!collapsed, |d| {
                        d.child(
                            v_flex()
                                .gap_2()
                                .px_4()
                                .pb_4()
                                .children(controls)
                                .child(div().grid().grid_cols(2).gap_2().children(rows)),
                        )
                    })
                    .into_any_element(),
            );
        }

        v_flex()
            .id("player-modal-body")
            .max_h(px(640.))
            .overflow_y_scrollbar()
            .gap_4()
            .child(summary)
            .children(sections)
            .into_any_element()
    }
}

#[derive(Clone)]
struct EconomyDetails {
    title: String,
    grief: String,
    meta: serde_json::Value,
    player: String,
    teammates: Vec<(String, String, Vec<String>)>,
}

impl EconomyDetails {
    fn new(m: &PlayerModal, e: &MatchEvent) -> Self {
        let teammates = e
            .meta
            .get("other_players")
            .and_then(|v| v.as_array())
            .map(|list| {
                list.iter()
                    .map(|p| {
                        let id = p.get("steamid").and_then(|v| v.as_str());
                        let money = p.get("money").map(|v| v.to_string()).unwrap_or_default();
                        let weapons = p
                            .get("weapons")
                            .and_then(|v| v.as_array())
                            .map(|w| w.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
                            .unwrap_or_default();
                        (m.name(id), money, weapons)
                    })
                    .collect()
            })
            .unwrap_or_default();
        Self {
            title: format!("{} - Round {}", m.name(e.actor.as_deref()), e.round_index + 1),
            grief: grief_label(e.meta_str("grief_type").unwrap_or("unknown")),
            meta: e.meta.clone(),
            player: m.name(e.actor.as_deref()),
            teammates,
        }
    }

    fn open(self, window: &mut Window, cx: &mut App) {
        window.open_dialog(cx, move |dialog, _, _| {
            let d = self.clone();
            dialog.w(px(448.)).overlay_closable(true).title(d.title.clone()).child(d.body())
        });
    }

    fn body(&self) -> impl IntoElement {
        let n = |k: &str| self.meta.get(k).and_then(|v| v.as_f64()).unwrap_or(0.0);
        let stat = |label: &'static str, value: String| {
            h_flex()
                .justify_between()
                .text_xs()
                .child(div().text_color(theme::text_muted()).child(label))
                .child(div().font_weight(FontWeight::MEDIUM).child(value))
        };
        let panel = || v_flex().gap_2().p_3().rounded_sm().bg(rgba(0x282b3080));
        let caption = |text: &'static str| div().text_xs().font_weight(FontWeight::MEDIUM).text_color(theme::text_muted()).child(text);
        let chip = |text: String, bg: Rgba, fg: Rgba| div().px_2().py_1().rounded_sm().text_xs().bg(bg).text_color(fg).child(text);

        let weapons: Vec<AnyElement> = self
            .meta
            .get("weapon_details")
            .and_then(|v| v.as_array())
            .map(|list| {
                list.iter()
                    .map(|w| {
                        let name = w.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        let purchase = w.get("purchase").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        let (bg, fg) = match purchase.as_str() {
                            "bought" => (rgba(0xef444433), rgb(0xf87171)),
                            "saved" => (rgba(0x22c55e33), rgb(0x4ade80)),
                            _ => (rgba(0xeab30833), rgb(0xfacc15)),
                        };
                        let tag = if purchase == "likely_bought" { format!("~{purchase}") } else { purchase };
                        chip(format!("{name} ({tag})"), bg, fg).into_any_element()
                    })
                    .collect()
            })
            .unwrap_or_default();

        v_flex()
            .gap_3()
            .child(caption("Grief Type:"))
            .child(div().font_weight(FontWeight::SEMIBOLD).text_color(rgb(0xfacc15)).child(self.grief.clone()))
            .child(
                panel()
                    .child(stat("Start money:", format!("${}", money(n("start_money")))))
                    .child(stat("Spent:", format!("${} ({:.1}%)", money(n("money_spent")), n("spend_pct"))))
                    .child(stat("Remaining:", format!("${}", money(n("remaining_money"))))),
            )
            .child(caption("Team Average:"))
            .child(
                panel()
                    .child(stat("Start money:", format!("${}", money(n("team_avg_money")))))
                    .child(stat("Spent:", format!("${} ({:.1}%)", money(n("team_avg_spend")), n("team_spend_pct"))))
                    .child(stat("Remaining:", format!("${}", money(n("team_avg_remaining"))))),
            )
            .child(caption("Flagged Player's Equipment:"))
            .child(
                panel()
                    .child(
                        h_flex()
                            .justify_between()
                            .text_sm()
                            .child(div().font_weight(FontWeight::MEDIUM).child(self.player.clone()))
                            .child(div().text_xs().text_color(theme::text_muted()).child(format!("${} Remaining", n("remaining_money")))),
                    )
                    .child(if weapons.is_empty() {
                        div().text_xs().text_color(theme::text_muted()).child("Nothing bought").into_any_element()
                    } else {
                        h_flex().flex_wrap().gap_1().children(weapons).into_any_element()
                    }),
            )
            .when(!self.teammates.is_empty(), |d| {
                d.child(caption("Team Equipment:")).children(self.teammates.iter().map(|(name, money, weapons)| {
                    panel()
                        .child(
                            h_flex()
                                .justify_between()
                                .text_sm()
                                .child(div().font_weight(FontWeight::MEDIUM).child(name.clone()))
                                .child(div().text_xs().text_color(theme::text_muted()).child(format!("${money} Remaining"))),
                        )
                        .child(if weapons.is_empty() {
                            div().text_xs().text_color(theme::text_muted()).child("Nothing bought").into_any_element()
                        } else {
                            h_flex()
                                .flex_wrap()
                                .gap_1()
                                .children(weapons.iter().map(|w| chip(w.clone(), theme::surface(), theme::text_soft())))
                                .into_any_element()
                        })
                }))
            })
    }
}

/// Open the details modal for `player` with the events they caused.
pub fn open(s: &MatchSummary, player: &RosterPlayer, view_2d: Option<View2d>, window: &mut Window, cx: &mut App) {
    let names = s.roster.iter().map(|p| (p.steamid.clone(), p.name.clone())).collect();
    let events = s.events.iter().filter(|e| e.actor.as_deref() == Some(player.steamid.as_str())).cloned().collect();
    let modal = PlayerModal {
        player: player.clone(),
        events,
        names,
        tick_rate: if s.tick_rate > 0.0 { s.tick_rate } else { 64.0 },
        collapsed: HashSet::new(),
        afk_min: 10.0,
        flash_min: 1.5,
        afk_sort: AfkSort::Round,
        demo: s.info.demo_path.clone(),
        view_2d,
        round_ticks: s.rounds.iter().map(|r| (r.index, r.freeze_end_tick.unwrap_or(r.start_tick))).collect(),
    };
    let view = cx.new(|_| modal);
    let steam_id = player.steamid.clone();
    window.open_dialog(cx, move |dialog, _, cx| {
        let p = &view.read(cx).player;
        let name = if p.name.is_empty() { p.steamid.clone() } else { p.name.clone() };
        let id = steam_id.clone();
        dialog
            .w(px(980.))
            .overlay_closable(true)
            .title(
                v_flex()
                    .gap_1()
                    .child(div().text_xl().font_weight(FontWeight::BOLD).child(name))
                    .child(
                        h_flex()
                            .gap_1()
                            .text_sm()
                            .text_color(theme::text_muted())
                            .child("Steam ID:")
                            .child(
                                div()
                                    .id("pm-steam")
                                    .text_color(theme::accent())
                                    .cursor_pointer()
                                    .child(id.clone())
                                    .on_click(move |_, _, cx| cx.open_url(&format!("https://steamcommunity.com/profiles/{id}"))),
                            ),
                    ),
            )
            .child(view.clone())
    });
}
