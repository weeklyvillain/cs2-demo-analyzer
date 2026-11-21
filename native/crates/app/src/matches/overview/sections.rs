//! AFK, Disconnects, Team kills, Team damage, Team flashes and Body block sections.
//! Each mirrors its Electron component in `src/components/overview/`.
//!
//! Event cards carry Electron's "View in 2D" (map has a radar) and "Watch in CS2" buttons,
//! both only when the demo file is known.

use std::collections::BTreeMap;

use cs2da_core::{MatchEvent, MatchSummary, disconnect};
use gpui_kit::component::{IconName, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use super::{OverviewState, Section, StateOf, icons, section_frame};
use crate::i18n::{t, tf};
use crate::theme;

pub struct Ctx<'a, V> {
    pub summary: &'a MatchSummary,
    pub state: &'a OverviewState,
    pub state_of: StateOf<V>,
    pub tick_rate: f64,
    /// Jump the 2D tab to a tick, and the view to call it on. None without a radar.
    pub view_2d: Option<(super::View2d<V>, WeakEntity<V>)>,
    pub has_demo: bool,
}

impl<V> Ctx<'_, V> {
    pub fn name(&self, steamid: Option<&str>) -> String {
        match steamid {
            Some(id) if !id.is_empty() => self.summary.player_name(id).to_string(),
            _ => t("matches.unknown"),
        }
    }
}

/// Events grouped by round (ascending), keeping their order inside a round.
pub fn by_round<'a>(events: &[&'a MatchEvent]) -> BTreeMap<i64, Vec<&'a MatchEvent>> {
    let mut grouped: BTreeMap<i64, Vec<&MatchEvent>> = BTreeMap::new();
    for e in events {
        grouped.entry(e.round_index).or_default().push(e);
    }
    grouped
}

/// "ROUND 3 ───────" followed by the round's cards.
pub fn rounds_list<'a>(
    grouped: BTreeMap<i64, Vec<&'a MatchEvent>>,
    mut card: impl FnMut(&'a MatchEvent) -> AnyElement,
) -> AnyElement {
    v_flex()
        .gap_4()
        .children(grouped.into_iter().map(|(round, events)| {
            v_flex()
                .gap_2()
                .child(
                    h_flex()
                        .gap_2()
                        .child(
                            div()
                                .text_xs()
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(rgb(0x6b7280))
                                .child(format!("{} {}", t("matches.round"), round + 1).to_uppercase()),
                        )
                        .child(div().flex_1().h(px(1.)).bg(rgba(0x42454999))),
                )
                .child(h_flex().flex_wrap().gap_3().children(events.into_iter().map(&mut card)))
        }))
        .into_any_element()
}

/// Electron's map-icon button: the 2D tab, 5 s before the event.
pub fn view_2d_button<V: 'static>(ctx: &Ctx<'_, V>, e: &MatchEvent) -> Option<AnyElement> {
    let (f, view) = ctx.view_2d.clone().filter(|_| ctx.has_demo)?;
    let tick = (e.start_tick - (5.0 * ctx.tick_rate) as i64).max(0);
    let id = format!("v2d-{}-{}-{}-{}", e.kind, e.round_index, e.start_tick, e.actor.as_deref().unwrap_or(""));
    Some(
        div()
            .id(SharedString::from(id))
            .p_1()
            .rounded_sm()
            .cursor_pointer()
            .text_color(theme::text_muted())
            .hover(|s| s.bg(rgba(0xd07a2d33)).text_color(theme::accent()))
            .child(IconName::Map)
            .on_click(move |_, window, cx| {
                view.update(cx, |this, cx| f(this, tick, window, cx)).ok();
            })
            .into_any_element(),
    )
}

/// Electron's play button: watch the event in CS2, spectating its actor. Electron passes the
/// event's start tick; the launcher backs up 5 s from it.
pub fn watch_button<V>(ctx: &Ctx<'_, V>, e: &MatchEvent) -> AnyElement {
    let id = format!("cs2-{}-{}-{}-{}", e.kind, e.round_index, e.start_tick, e.actor.as_deref().unwrap_or(""));
    let (demo, tick, who) = (ctx.summary.info.demo_path.clone(), e.start_tick, ctx.name(e.actor.as_deref()));
    div()
        .id(SharedString::from(id))
        .p_1()
        .rounded_sm()
        .cursor_pointer()
        .text_color(theme::text_muted())
        .hover(|s| s.bg(rgba(0xd07a2d33)).text_color(theme::accent()))
        .child(IconName::Play)
        .on_click(move |_, window, cx| crate::cs2_watch::watch_event(demo.clone(), tick, who.clone(), window, cx))
        .into_any_element()
}

/// The per-event buttons: View in 2D (with a radar) and Watch in CS2, when the demo is known.
pub fn event_buttons<V: 'static>(ctx: &Ctx<'_, V>, e: &MatchEvent) -> Option<AnyElement> {
    ctx.has_demo.then(|| {
        h_flex().gap_1().flex_shrink_0().children(view_2d_button(ctx, e)).child(watch_button(ctx, e)).into_any_element()
    })
}

/// A card title with the event's buttons on the right.
pub fn with_2d<V: 'static>(ctx: &Ctx<'_, V>, e: &MatchEvent, title: impl IntoElement) -> AnyElement {
    h_flex().w_full().justify_between().gap_2().child(title).children(event_buttons(ctx, e)).into_any_element()
}

/// The common event card: player name on top, then the given lines.
pub fn event_card(title: impl IntoElement, min_width: f32) -> Div {
    v_flex()
        .min_w(px(min_width))
        .p_3()
        .rounded_sm()
        .bg(theme::secondary())
        .border_1()
        .border_color(theme::border())
        .child(h_flex().mb_2().justify_between().child(title))
}

fn name_label(name: String) -> Div {
    div().font_weight(FontWeight::MEDIUM).child(name)
}

/// `[−] 10.0 [+] s (3/5)`: Electron's number input, as step buttons.
fn threshold_control<V: 'static>(
    id: &'static str,
    label: String,
    value: f64,
    step: f64,
    decimals: usize,
    unit: String,
    shown: usize,
    total: usize,
    set: fn(&mut OverviewState, f64),
    state_of: StateOf<V>,
    cx: &mut Context<V>,
) -> AnyElement {
    let step_button = |suffix: &str, icon: IconName, delta: f64, cx: &mut Context<V>| {
        div()
            .id(SharedString::from(format!("{id}-{suffix}")))
            .px_1p5()
            .py_1()
            .rounded_sm()
            .bg(theme::secondary())
            .border_1()
            .border_color(theme::border())
            .cursor_pointer()
            .hover(|s| s.border_color(theme::accent()))
            .child(icon)
            .on_click(cx.listener(move |this, _, _, cx| {
                // Like Electron, editing starts from the value shown (the effective threshold).
                let next = ((value + delta) * 10.0).round() / 10.0;
                set(state_of(this), next.max(0.0));
                cx.notify();
            }))
    };
    h_flex()
        .gap_2()
        .text_xs()
        .child(div().text_color(theme::text_muted()).child(label))
        .child(step_button("minus", IconName::Minus, -step, cx))
        .child(
            div()
                .w(px(48.))
                .px_2()
                .py_1()
                .rounded_sm()
                .bg(theme::secondary())
                .border_1()
                .border_color(theme::border())
                .text_center()
                .child(format!("{value:.decimals$}")),
        )
        .child(step_button("plus", IconName::Plus, step, cx))
        .child(div().text_color(rgb(0x6b7280)).child(unit))
        .child(div().text_color(rgb(0x6b7280)).child(format!("({shown}/{total})")))
        .into_any_element()
}

/// Electron's "auto-adjust": if nothing passes the threshold, drop it to the
/// smallest positive value so at least one event shows.
fn effective_threshold(min: f64, values: &[f64]) -> f64 {
    if values.is_empty() || values.iter().any(|v| *v >= min) {
        return min;
    }
    values
        .iter()
        .copied()
        .filter(|v| *v > 0.0)
        .min_by(|a, b| a.total_cmp(b))
        .unwrap_or(min)
}

// ---------- AFK ----------

pub fn afk<V: 'static>(ctx: &Ctx<'_, V>, events: &[&MatchEvent], cx: &mut Context<V>) -> AnyElement {
    let tr = ctx.tick_rate;
    let durations: Vec<f64> = events.iter().map(|e| e.afk_seconds(tr)).collect();
    let threshold = effective_threshold(ctx.state.afk_min_seconds, &durations);
    let filtered: Vec<&MatchEvent> = events.iter().copied().filter(|e| e.afk_seconds(tr) >= threshold).collect();
    let by_duration = ctx.state.afk_sort_by_duration;
    let state_of = ctx.state_of;

    let sort_choice = |id: &'static str, label: String, active: bool, value: bool, cx: &mut Context<V>| {
        div()
            .id(id)
            .px_2()
            .py_1()
            .rounded_sm()
            .border_1()
            .cursor_pointer()
            .when(active, |d| d.bg(theme::accent()).border_color(theme::accent()).text_color(theme::text()))
            .when(!active, |d| d.bg(theme::secondary()).border_color(theme::border()).hover(|s| s.border_color(theme::accent())))
            .child(label)
            .on_click(cx.listener(move |this, _, _, cx| {
                state_of(this).afk_sort_by_duration = value;
                cx.notify();
            }))
    };
    let controls = h_flex()
        .gap_4()
        .child(
            h_flex()
                .gap_2()
                .text_xs()
                .child(div().text_color(theme::text_muted()).child(t("matches.sortBy")))
                .child(sort_choice("afk-sort-round", t("matches.round"), !by_duration, false, cx))
                .child(sort_choice("afk-sort-duration", t("matches.duration"), by_duration, true, cx)),
        )
        .child(threshold_control(
            "afk-min",
            t("matches.minDuration"),
            threshold,
            0.5,
            1,
            t("matches.seconds"),
            filtered.len(),
            events.len(),
            |st, v| st.afk_min_seconds = v,
            state_of,
            cx,
        ))
        .into_any_element();

    let body = || {
        if filtered.is_empty() {
            return div()
                .py_4()
                .text_center()
                .text_color(theme::text_muted())
                .child(tf("matches.noAfkDetections", &[("threshold", &threshold.to_string())]))
                .into_any_element();
        }
        // Group by player, players A→Z; periods by round or longest first.
        let mut players: BTreeMap<String, (String, Vec<&MatchEvent>)> = BTreeMap::new();
        for e in &filtered {
            let id = e.actor.clone().unwrap_or_default();
            players.entry(id.clone()).or_insert_with(|| (ctx.name(Some(&id)), Vec::new())).1.push(e);
        }
        let mut players: Vec<(String, Vec<&MatchEvent>)> = players.into_values().collect();
        players.sort_by(|a, b| a.0.to_lowercase().cmp(&b.0.to_lowercase()));
        for (_, afks) in &mut players {
            if by_duration {
                afks.sort_by(|a, b| b.afk_seconds(tr).total_cmp(&a.afk_seconds(tr)));
            } else {
                afks.sort_by_key(|e| e.round_index);
            }
        }

        v_flex()
            .gap_4()
            .children(players.into_iter().map(|(name, afks)| {
                let count = afks.len();
                v_flex()
                    .p_4()
                    .rounded_sm()
                    .bg(theme::secondary())
                    .border_1()
                    .border_color(theme::border())
                    .child(
                        h_flex()
                            .mb_3()
                            .justify_between()
                            .child(div().font_weight(FontWeight::SEMIBOLD).child(name))
                            .child(div().text_xs().text_color(theme::text_muted()).child(format!(
                                "{count} {}",
                                if count == 1 { t("matches.afkPeriod") } else { t("matches.afkPeriods") }
                            ))),
                    )
                    .child(h_flex().flex_wrap().gap_3().children(afks.into_iter().map(|afk| {
                        let died = afk.meta_bool("diedWhileAFK");
                        let moved = afk.meta.get("timeToFirstMovement").is_some_and(|v| !v.is_null());
                        let stripe = if died { rgb(0xef4444) } else if moved { rgb(0xfacc15) } else { rgb(0x6b7280) };
                        let (ending, ending_color) = if died {
                            (t("matches.endedWhenDied"), rgb(0xf87171))
                        } else if moved {
                            (t("matches.endedWhenMoving"), rgb(0xfacc15))
                        } else {
                            ("Ended when round ended".to_string(), rgb(0x6b7280))
                        };
                        // GPUI has one border color per element, so the colored
                        // left edge (Electron `border-l-4`) is its own bar.
                        h_flex()
                            .items_stretch()
                            .min_w(px(280.))
                            .rounded_sm()
                            .overflow_hidden()
                            .bg(theme::surface())
                            .border_1()
                            .border_color(theme::border())
                            .child(div().w(px(4.)).flex_shrink_0().bg(stripe))
                            .child(v_flex().flex_1().p_3().child(
                                h_flex()
                                    .mb_2()
                                    .justify_between()
                                    .text_xs()
                                    .text_color(theme::text_muted())
                                    .child(format!("{} {}", t("matches.round"), afk.round_index + 1))
                                    .children(event_buttons(ctx, afk)),
                            )
                            .child(
                                v_flex()
                                    .gap_1()
                                    .text_xs()
                                    .text_color(theme::text_muted())
                                    .child(h_flex().gap_2().child(icons::clock()).child(tf(
                                        "matches.afkDuration",
                                        &[("duration", &format!("{:.1}", afk.afk_seconds(tr)))],
                                    )))
                                    .child(
                                        h_flex()
                                            .gap_2()
                                            .text_color(ending_color)
                                            .when(died, |d| d.child(icons::skull()))
                                            .child(ending),
                                    ),
                            ))
                    })))
            }))
            .into_any_element()
    };

    section_frame(ctx, Section::Afk, icons::clock(), t("matches.afkPlayersAtRoundStart"), theme::accent(), Some(controls), body, cx)
}

// ---------- Disconnects ----------

fn mm_ss(seconds: f64) -> String {
    let s = seconds.max(0.0);
    format!("{}:{:02}", (s / 60.0) as u64, (s % 60.0) as u64)
}

pub fn disconnects<V: 'static>(ctx: &Ctx<'_, V>, events: &[&MatchEvent], cx: &mut Context<V>) -> AnyElement {
    let body = || {
        rounds_list(by_round(events), |dc| {
            let line = |label: &'static str, value: String| {
                h_flex().gap_1().mt_1().text_xs().child(div().font_weight(FontWeight::MEDIUM).child(label)).child(value)
            };
            let reason = disconnect::format_reason(dc.meta.get("reason").unwrap_or(&serde_json::Value::Null));
            let disconnected = dc.meta_num("disconnect_time").map_or("N/A".to_string(), mm_ss);
            let reconnected = dc.meta_bool("reconnected");
            event_card(with_2d(ctx, dc, name_label(ctx.name(dc.actor.as_deref()))), 260.)
                .child(line("Reason:", reason).text_color(theme::text_muted()))
                .child(line("Disconnected:", disconnected).text_color(theme::text_muted()))
                .when(reconnected, |d| {
                    let at = dc.meta_num("reconnect_time").map(mm_ss).unwrap_or_default();
                    d.child(line("Reconnected:", at).text_color(rgb(0x4ade80)))
                        .when_some(dc.meta_num("disconnect_duration"), |d, secs| {
                            d.child(line("Duration:", format!("{secs:.1}s")).text_color(theme::text_muted()))
                        })
                })
                .when(!reconnected, |d| d.child(div().mt_1().text_xs().text_color(rgb(0xf87171)).child("Did not reconnect")))
                .into_any_element()
        })
    };
    section_frame(ctx, Section::Disconnects, icons::wifi_off(), "Disconnects".into(), theme::text_muted(), None, body, cx)
}

// ---------- Team kills ----------

pub fn team_kills<V: 'static>(ctx: &Ctx<'_, V>, events: &[&MatchEvent], cx: &mut Context<V>) -> AnyElement {
    let body = || {
        rounds_list(by_round(events), |kill| {
            event_card(with_2d(ctx, kill, name_label(ctx.name(kill.actor.as_deref()))), 260.)
                .child(div().text_sm().text_color(theme::text_soft()).child(format!("→ {}", ctx.name(kill.victim.as_deref()))))
                .when_some(kill.meta_str("weapon").map(str::to_string), |d, w| {
                    d.child(div().mt_1().text_xs().text_color(theme::text_muted()).child(w))
                })
                .into_any_element()
        })
    };
    section_frame(ctx, Section::TeamKills, icons::skull(), "Team Kills".into(), rgb(0xf87171), None, body, cx)
}

// ---------- Team damage ----------

pub fn team_damage<V: 'static>(ctx: &Ctx<'_, V>, events: &[&MatchEvent], cx: &mut Context<V>) -> AnyElement {
    let body = || {
        rounds_list(by_round(events), |dmg| {
            event_card(with_2d(ctx, dmg, name_label(ctx.name(dmg.actor.as_deref()))), 260.)
                .child(div().text_sm().text_color(theme::text_soft()).child(format!("→ {}", ctx.name(dmg.victim.as_deref()))))
                .when_some(dmg.weapon(), |d, w| d.child(div().mt_1().text_xs().text_color(theme::text_muted()).child(w)))
                .child(div().mt_1().text_xs().text_color(theme::accent()).child(format!(
                    "{} {}",
                    dmg.meta_num("total_damage").map_or("0".to_string(), |v| format!("{v:.1}")),
                    t("matches.damage")
                )))
                .into_any_element()
        })
    };
    section_frame(ctx, Section::TeamDamage, icons::zap(), t("matches.sections.teamDamage"), theme::accent(), None, body, cx)
}

// ---------- Team flashes ----------

pub fn team_flashes<V: 'static>(ctx: &Ctx<'_, V>, events: &[&MatchEvent], cx: &mut Context<V>) -> AnyElement {
    let blind = |e: &MatchEvent| e.meta_num("blind_duration").unwrap_or(0.0);
    let values: Vec<f64> = events.iter().map(|e| blind(e)).collect();
    let threshold = effective_threshold(ctx.state.flash_min_seconds, &values);
    let filtered: Vec<&MatchEvent> = events.iter().copied().filter(|e| blind(e) >= threshold).collect();

    let controls = threshold_control(
        "flash-min",
        t("matches.minBlind"),
        threshold,
        0.1,
        1,
        "s".into(),
        filtered.len(),
        events.len(),
        |st, v| st.flash_min_seconds = v,
        ctx.state_of,
        cx,
    );

    let body = || {
        if filtered.is_empty() {
            return div()
                .py_4()
                .text_center()
                .text_color(theme::text_muted())
                .child(tf("matches.noFlashes", &[("threshold", &format!("{threshold:.1}"))]))
                .into_any_element();
        }
        rounds_list(by_round(&filtered), |flash| {
            event_card(with_2d(ctx, flash, name_label(ctx.name(flash.actor.as_deref()))), 260.)
                .child(div().text_sm().text_color(theme::text_soft()).child(format!("→ {}", ctx.name(flash.victim.as_deref()))))
                .child(div().mt_1().text_xs().text_color(theme::accent()).child(format!(
                    "{}s {}",
                    flash.meta_num("blind_duration").map_or("0".to_string(), |v| format!("{v:.1}")),
                    t("matches.blind")
                )))
                .into_any_element()
        })
    };
    section_frame(ctx, Section::TeamFlashes, icons::zap(), t("matches.sections.teamFlashes"), theme::accent(), Some(controls), body, cx)
}

// ---------- Body block ----------

pub fn body_blocks<V: 'static>(ctx: &Ctx<'_, V>, events: &[&MatchEvent], cx: &mut Context<V>) -> AnyElement {
    let body = || {
        rounds_list(by_round(events), |block| {
            let title = h_flex()
                .gap_2()
                .child(name_label(ctx.name(block.actor.as_deref())))
                .child(div().text_xs().text_color(rgb(0x6b7280)).child("on"))
                .child(name_label(ctx.name(block.victim.as_deref())).text_color(rgb(0xd8b4fe)));
            event_card(with_2d(ctx, block, title), 260.)
                .child(div().mb_2().text_xs().font_weight(FontWeight::MEDIUM).text_color(rgb(0xc084fc)).child("Head stacking detected"))
                .child(
                    h_flex()
                        .gap_1()
                        .text_xs()
                        .text_color(theme::text_muted())
                        .child(div().font_weight(FontWeight::MEDIUM).child("Duration:"))
                        .child(div().text_color(theme::text()).child(format!("{:.1}s", block.meta_num("seconds").unwrap_or(0.0)))),
                )
                .into_any_element()
        })
    };
    section_frame(ctx, Section::BodyBlock, icons::body_block(), "Body Block (Head Stacking)".into(), rgb(0xc084fc), None, body, cx)
}
