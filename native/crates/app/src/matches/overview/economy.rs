//! Economy griefing section (Electron `EconomyGriefSection`), including its
//! "View details" dialog with the flagged player's and team's equipment.

use cs2da_core::MatchEvent;
use gpui_kit::component::{IconName, WindowExt as _, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use super::sections::{Ctx, by_round, event_card, rounds_list};
use super::{Section, icons, section_frame};
use crate::theme;

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

/// `1234567` -> `1,234,567` (JS `toLocaleString` in en-US).
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

fn num(e: &MatchEvent, key: &str) -> f64 {
    e.meta_num(key).unwrap_or(0.0)
}

pub fn section<V: 'static>(ctx: &Ctx<'_, V>, events: &[&MatchEvent], cx: &mut Context<V>) -> AnyElement {
    let body = || {
        rounds_list(by_round(events), |econ| {
            let name = ctx.name(econ.actor.as_deref());
            let kind = econ.meta_str("grief_type").unwrap_or("unknown").to_string();
            let details = Details::new(ctx, econ);
            let info_id: SharedString =
                format!("econ-info-{}-{}-{}", econ.round_index, econ.start_tick, econ.actor.as_deref().unwrap_or("")).into();

            let title = h_flex()
                .w_full()
                .justify_between()
                .child(div().font_weight(FontWeight::MEDIUM).child(name))
                .child(
                    // Electron's order: details, then View in 2D and Watch in CS2.
                    h_flex()
                        .gap_1()
                        .child(
                            div()
                                .id(info_id)
                                .p_1()
                                .rounded_sm()
                                .cursor_pointer()
                                .text_color(theme::text_muted())
                                .hover(|s| s.bg(rgba(0xd07a2d33)).text_color(theme::accent()))
                                .child(IconName::Info)
                                .on_click(move |_, window, cx| details.clone().open(window, cx)),
                        )
                        .children(super::sections::event_buttons(ctx, econ)),
                );

            let row = |label: &'static str, value: String, strong: bool| {
                [
                    div().text_color(theme::text_muted()).font_weight(FontWeight::MEDIUM).child(label).into_any_element(),
                    div()
                        .text_color(if strong { theme::text() } else { theme::text_soft() })
                        .child(value)
                        .into_any_element(),
                ]
            };
            event_card(title, 280.)
                .child(div().mb_2().text_xs().font_weight(FontWeight::MEDIUM).text_color(rgb(0xfacc15)).child(grief_label(&kind)))
                .child(
                    div()
                        .grid()
                        .grid_cols(2)
                        .gap_x_3()
                        .gap_y_1()
                        .text_xs()
                        .children(row("Start money:", format!("${}", money(num(econ, "start_money"))), true))
                        .children(row(
                            "Spent:",
                            format!("${} ({:.1}%)", money(num(econ, "money_spent")), num(econ, "spend_pct")),
                            true,
                        ))
                        .children(row("Team avg money:", format!("${}", money(num(econ, "team_avg_money"))), false))
                        .children(row(
                            "Team avg spent:",
                            format!("${} ({:.1}%)", money(num(econ, "team_avg_spend")), num(econ, "team_spend_pct")),
                            false,
                        )),
                )
                .into_any_element()
        })
    };
    section_frame(ctx, Section::Economy, icons::dollar(), "Economy Griefing".into(), rgb(0xfacc15), None, body, cx)
}

#[derive(Clone)]
struct Weapon {
    name: String,
    purchase: String,
}

#[derive(Clone)]
struct Teammate {
    name: String,
    money: String,
    weapons: Vec<String>,
}

/// Everything the details dialog shows, resolved up front so the dialog
/// doesn't need the match data.
#[derive(Clone)]
struct Details {
    title: String,
    grief: String,
    start_money: f64,
    spent: f64,
    spend_pct: f64,
    remaining: f64,
    team_money: f64,
    team_spent: f64,
    team_spend_pct: f64,
    team_remaining: f64,
    player: String,
    player_remaining: String,
    weapons: Vec<Weapon>,
    teammates: Vec<Teammate>,
}

impl Details {
    fn new<V>(ctx: &Ctx<'_, V>, e: &MatchEvent) -> Self {
        let player = ctx.name(e.actor.as_deref());
        let text = |v: Option<&serde_json::Value>| match v {
            Some(serde_json::Value::String(s)) => s.clone(),
            Some(serde_json::Value::Null) | None => String::new(),
            Some(other) => other.to_string(),
        };
        let weapons = e
            .meta
            .get("weapon_details")
            .and_then(|w| w.as_array())
            .map(|a| {
                a.iter()
                    .map(|w| Weapon { name: text(w.get("name")), purchase: text(w.get("purchase")) })
                    .collect()
            })
            .unwrap_or_default();
        let teammates = e
            .meta
            .get("other_players")
            .and_then(|p| p.as_array())
            .map(|a| {
                a.iter()
                    .map(|p| Teammate {
                        name: ctx.name(p.get("steamid").and_then(|s| s.as_str())),
                        money: text(p.get("money")),
                        weapons: p
                            .get("weapons")
                            .and_then(|w| w.as_array())
                            .map(|w| w.iter().map(|x| text(Some(x))).collect())
                            .unwrap_or_default(),
                    })
                    .collect()
            })
            .unwrap_or_default();
        Self {
            title: format!("{player} - Round {}", e.round_index + 1),
            grief: grief_label(e.meta_str("grief_type").unwrap_or("")),
            start_money: num(e, "start_money"),
            spent: num(e, "money_spent"),
            spend_pct: num(e, "spend_pct"),
            remaining: num(e, "remaining_money"),
            team_money: num(e, "team_avg_money"),
            team_spent: num(e, "team_avg_spend"),
            team_spend_pct: num(e, "team_spend_pct"),
            team_remaining: num(e, "team_avg_remaining"),
            player_remaining: text(e.meta.get("remaining_money")),
            player,
            weapons,
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
        let stat = |label: &'static str, value: String| {
            h_flex()
                .justify_between()
                .text_xs()
                .child(div().text_color(theme::text_muted()).child(label))
                .child(div().font_weight(FontWeight::MEDIUM).child(value))
        };
        let panel = || v_flex().gap_2().p_3().rounded_sm().bg(rgba(0x282b3080));
        let caption = |text: &'static str| div().text_xs().font_weight(FontWeight::MEDIUM).text_color(theme::text_muted()).child(text);
        let equipment = |name: String, remaining: String, chips: Vec<AnyElement>| {
            v_flex()
                .gap_1()
                .p_2()
                .rounded_sm()
                .bg(rgba(0x282b3080))
                .child(
                    h_flex()
                        .justify_between()
                        .child(div().text_sm().font_weight(FontWeight::MEDIUM).child(name))
                        .child(
                            h_flex()
                                .gap_1()
                                .text_xs()
                                .text_color(theme::text_muted())
                                .child(format!("${remaining}"))
                                .child(div().text_color(rgb(0x6b7280)).child("Remaining")),
                        ),
                )
                .child(
                    h_flex()
                        .flex_wrap()
                        .gap_1()
                        .when(chips.is_empty(), |d| d.child(div().text_xs().text_color(rgb(0x6b7280)).child("Nothing bought")))
                        .children(chips),
                )
        };
        let chip = |text: String, bg: Rgba, fg: Rgba| {
            div().px_2().py_1().rounded_sm().text_xs().font_weight(FontWeight::MEDIUM).bg(bg).text_color(fg).child(text).into_any_element()
        };

        let weapon_chips = self
            .weapons
            .iter()
            .map(|w| {
                let (bg, fg) = match w.purchase.as_str() {
                    "bought" => (rgba(0xef444433), rgb(0xf87171)),
                    "saved" => (rgba(0x22c55e33), rgb(0x4ade80)),
                    _ => (rgba(0xeab30833), rgb(0xfacc15)),
                };
                let tilde = if w.purchase == "likely_bought" { "~" } else { "" };
                chip(format!("{} ({tilde}{})", w.name, w.purchase), bg, fg)
            })
            .collect();

        v_flex()
            .gap_4()
            .child(v_flex().gap_1().child(caption("Grief Type:")).child(div().font_weight(FontWeight::MEDIUM).text_color(rgb(0xfacc15)).child(self.grief.clone())))
            .child(
                panel()
                    .child(stat("Start money:", format!("${}", money(self.start_money))))
                    .child(stat("Spent:", format!("${} ({:.1}%)", money(self.spent), self.spend_pct)))
                    .child(stat("Remaining:", format!("${}", money(self.remaining)))),
            )
            .child(
                panel()
                    .child(caption("Team Average:"))
                    .child(stat("Start money:", format!("${}", money(self.team_money))))
                    .child(stat("Spent:", format!("${} ({:.1}%)", money(self.team_spent), self.team_spend_pct)))
                    .child(stat("Remaining:", format!("${}", money(self.team_remaining)))),
            )
            .child(
                v_flex()
                    .gap_2()
                    .child(caption("Flagged Player's Equipment:"))
                    .child(equipment(self.player.clone(), self.player_remaining.clone(), weapon_chips)),
            )
            .when(!self.teammates.is_empty(), |d| {
                d.child(
                    v_flex().gap_2().child(caption("Team Equipment:")).children(self.teammates.iter().map(|p| {
                        let chips = p
                            .weapons
                            .iter()
                            .map(|w| chip(w.clone(), theme::secondary(), theme::text_soft()))
                            .collect();
                        equipment(p.name.clone(), p.money.clone(), chips)
                    })),
                )
            })
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn money_groups_thousands() {
        assert_eq!(super::money(0.0), "0");
        assert_eq!(super::money(950.0), "950");
        assert_eq!(super::money(16000.0), "16,000");
        assert_eq!(super::money(1234567.4), "1,234,567");
    }
}
