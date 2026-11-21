//! Rounds tab: one collapsible card per round listing its grief events
//! (Electron `MatchesRoundsTab`; KILL events are left out, as there).

use std::collections::HashSet;

use cs2da_core::MatchSummary;
use gpui_kit::component::{IconName, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::format;
use crate::i18n::t;
use crate::theme;
use crate::ui::centered_note;

pub fn render<V: 'static>(
    s: &MatchSummary,
    collapsed: &HashSet<i64>,
    on_toggle: impl Fn(i64, &mut Window, &mut Context<V>) + Clone + 'static,
    // "View in 2D": jump the 2D tab to a tick. None when the map has no radar.
    view_2d: Option<fn(&mut V, i64, &mut Window, &mut Context<V>)>,
    // The match's demo file is known (Electron shows the per-event buttons only then).
    has_demo: bool,
    cx: &mut Context<V>,
) -> AnyElement {
    if s.rounds.is_empty() {
        return centered_note("No rounds available").into_any_element();
    }
    let tick_rate = if s.tick_rate > 0.0 { s.tick_rate } else { 64.0 };

    v_flex()
        .gap_3()
        .children(s.rounds.iter().map(|r| {
            let events: Vec<_> = s
                .events
                .iter()
                .filter(|e| e.round_index == r.index && e.kind != "KILL")
                .collect();
            let expanded = !collapsed.contains(&r.index);
            let index = r.index;
            let toggle = on_toggle.clone();

            let winner = match r.winner.as_deref() {
                Some("T") => div().text_color(rgb(0xff6b35)).font_weight(FontWeight::MEDIUM).child("T"),
                Some("CT") => div().text_color(rgb(0x4a9eff)).font_weight(FontWeight::MEDIUM).child("CT"),
                _ => div().text_color(rgb(0x6b7280)).child("—"),
            };
            let label = |l: &'static str| div().text_color(rgb(0x6b7280)).child(l);

            let header = h_flex()
                .id(SharedString::from(format!("round-{index}")))
                .justify_between()
                .gap_3()
                .px_4()
                .py_3()
                .cursor_pointer()
                .child(
                    h_flex()
                        .gap_4()
                        .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).child(format!("Round {}", index + 1)))
                        .child(
                            h_flex()
                                .gap_3()
                                .text_xs()
                                .text_color(theme::text_muted())
                                .child(h_flex().gap_1().child(label("Winner:")).child(winner))
                                .child(
                                    h_flex()
                                        .gap_1()
                                        .child(label("Score:"))
                                        .child(div().text_color(theme::text_soft()).child(format!("{} – {}", r.t_wins, r.ct_wins))),
                                )
                                .child(
                                    h_flex().gap_1().child(label("Duration:")).child(
                                        div()
                                            .text_color(theme::text_soft())
                                            .child(format::duration((r.end_tick - r.start_tick) as f64 / tick_rate)),
                                    ),
                                ),
                        ),
                )
                .child(
                    h_flex()
                        .gap_3()
                        .text_xs()
                        .text_color(theme::text_muted())
                        .child(format!("{} event{}", events.len(), if events.len() == 1 { "" } else { "s" }))
                        .when_some(view_2d, |d, f| {
                            let start = r.start_tick;
                            d.child(
                                div()
                                    .id(SharedString::from(format!("round-{index}-2d")))
                                    .px_2()
                                    .py_1()
                                    .rounded_sm()
                                    .bg(rgba(0xd07a2dcc))
                                    .hover(|s| s.bg(theme::accent()))
                                    .text_color(theme::text())
                                    .child(t("matches.roundsTab.view2d"))
                                    .on_click(cx.listener(move |this, _, window, cx| {
                                        cx.stop_propagation();
                                        f(this, start, window, cx);
                                    })),
                            )
                        })
                        .child(if expanded { IconName::ChevronUp } else { IconName::ChevronDown }),
                )
                .on_click(cx.listener(move |_, _, window, cx| toggle(index, window, cx)));

            v_flex()
                .rounded_lg()
                .overflow_hidden()
                .bg(rgba(0x36393e99))
                .border_1()
                .border_color(theme::border())
                .child(header)
                .when(expanded, |d| {
                    d.child(
                        v_flex()
                            .border_t_1()
                            .border_color(rgba(0x42454999))
                            .bg(rgba(0x36393e66))
                            .when(events.is_empty(), |d| {
                                d.child(div().px_4().py_3().text_xs().text_color(rgb(0x6b7280)).child("No events in this round"))
                            })
                            .children(events.iter().enumerate().map(|(i, e)| {
                                let actor = e.actor.as_deref().map_or("Unknown", |a| s.player_name(a)).to_string();
                                let victim = e.victim.as_deref().map(|v| s.player_name(v).to_string());
                                let damage = if e.kind == "TEAM_DAMAGE" { e.damage() } else { 0.0 };
                                h_flex()
                                    .items_start()
                                    .gap_3()
                                    .px_4()
                                    .py_2p5()
                                    .when(i > 0, |d| d.border_t_1().border_color(rgba(0x42454966)))
                                    .child(
                                        div()
                                            .w(px(48.))
                                            .flex_shrink_0()
                                            .text_xs()
                                            .text_color(rgb(0x6b7280))
                                            .child(format::clock(e.start_tick - r.start_tick, tick_rate)),
                                    )
                                    .child(
                                        v_flex()
                                            .flex_1()
                                            .min_w_0()
                                            .gap_0p5()
                                            .child(
                                                h_flex()
                                                    .justify_between()
                                                    .gap_3()
                                                    .child(div().text_xs().font_weight(FontWeight::SEMIBOLD).child(format::event_label(&e.kind)))
                                                    .when(has_demo, |d| {
                                                        // 5 s of lead-in, never before the round starts.
                                                        let tick = (e.start_tick - (5.0 * tick_rate) as i64).max(r.start_tick);
                                                        let (demo, who) = (s.info.demo_path.clone(), actor.clone());
                                                        d.child(
                                                            h_flex()
                                                                .gap_1()
                                                                .flex_shrink_0()
                                                                .when_some(view_2d, |d, f| {
                                                                    d.child(
                                                                        crate::ui::icon_button(SharedString::from(format!("ev-2d-{index}-{i}")), IconName::Map)
                                                                            .on_click(cx.listener(move |this, _, window, cx| f(this, tick, window, cx))),
                                                                    )
                                                                })
                                                                // "Watch this event in CS2" (Electron passes the same lead-in tick).
                                                                .child(
                                                                    crate::ui::icon_button(SharedString::from(format!("ev-cs2-{index}-{i}")), IconName::Play)
                                                                        .on_click(move |_, window, cx| {
                                                                            crate::cs2_watch::watch_event(demo.clone(), tick, who.clone(), window, cx)
                                                                        }),
                                                                ),
                                                        )
                                                    }),
                                            )
                                            .child(
                                                h_flex()
                                                    .gap_1()
                                                    .text_xs()
                                                    .text_color(theme::text_soft())
                                                    .child(div().font_weight(FontWeight::MEDIUM).child(actor))
                                                    .when_some(victim, |d, v| {
                                                        d.child(div().text_color(rgb(0x6b7280)).child("→"))
                                                            .child(div().font_weight(FontWeight::MEDIUM).child(v))
                                                    })
                                                    .when(damage > 0.0, |d| {
                                                        d.child(
                                                            div()
                                                                .ml_1()
                                                                .text_color(theme::text_muted())
                                                                .child(format!("· {} dmg", damage.round())),
                                                        )
                                                    }),
                                            ),
                                    )
                            })),
                    )
                })
        }))
        .into_any_element()
}
