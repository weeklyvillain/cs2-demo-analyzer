//! Chat tab: all-chat messages with a player filter and copy buttons (Electron `MatchesChatTab`).

use cs2da_core::{ChatMessage, MatchSummary};
use gpui_kit::component::{IconName, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::theme;
use crate::ui::{centered_note, copy_to_clipboard, icon_button};

fn line(m: &ChatMessage) -> String {
    format!("{}: {}", m.name.as_deref().unwrap_or(&m.steamid), m.message)
}

pub fn render<V: 'static>(
    s: &MatchSummary,
    filter: Option<&str>,
    on_filter: impl Fn(Option<String>, &mut Window, &mut Context<V>) + Clone + 'static,
    cx: &mut Context<V>,
) -> AnyElement {
    let messages: Vec<&ChatMessage> = s
        .chat
        .iter()
        .filter(|m| filter.is_none_or(|f| m.steamid == f))
        .collect();

    let chip = |id: String, label: String, active: bool, value: Option<String>, cx: &mut Context<V>| {
        let on_filter = on_filter.clone();
        div()
            .id(SharedString::from(id))
            .px_2p5()
            .py_1()
            .rounded_md()
            .text_xs()
            .cursor_pointer()
            .border_1()
            .when(active, |d| d.bg(theme::accent()).border_color(theme::accent()).text_color(theme::text()))
            .when(!active, |d| {
                d.bg(theme::secondary())
                    .border_color(theme::border())
                    .text_color(theme::text_soft())
                    .hover(|s| s.border_color(theme::accent()))
            })
            .child(label)
            .on_click(cx.listener(move |_, _, window, cx| on_filter(value.clone(), window, cx)))
    };

    let mut chips = vec![chip("chat-all".into(), "All players".into(), filter.is_none(), None, cx)];
    for p in &s.players {
        chips.push(chip(
            format!("chat-{}", p.steamid),
            p.name.clone(),
            filter == Some(p.steamid.as_str()),
            Some(p.steamid.clone()),
            cx,
        ));
    }

    let all_text = messages.iter().map(|m| line(m)).collect::<Vec<_>>().join("\n");
    let controls = v_flex()
        .gap_3()
        .p_4()
        .rounded_lg()
        .bg(theme::surface())
        .border_1()
        .border_color(theme::border())
        .child(
            h_flex()
                .justify_between()
                .child(div().text_sm().font_weight(FontWeight::MEDIUM).text_color(theme::text_soft()).child("Filter by player"))
                .child(
                    h_flex()
                        .gap_3()
                        .when(!messages.is_empty(), |d| {
                            d.child(
                                h_flex()
                                    .id("copy-all")
                                    .gap_2()
                                    .px_3()
                                    .py_1p5()
                                    .rounded_md()
                                    .bg(theme::secondary())
                                    .border_1()
                                    .border_color(theme::border())
                                    .text_sm()
                                    .cursor_pointer()
                                    .hover(|s| s.border_color(theme::accent()))
                                    .child(IconName::Copy)
                                    .child("Copy all")
                                    .on_click(move |_, _, cx| copy_to_clipboard(all_text.clone(), cx)),
                            )
                        })
                        .child(div().text_sm().text_color(theme::text_muted()).child("All chat only")),
                ),
        )
        .child(h_flex().flex_wrap().gap_1p5().children(chips));

    let body: AnyElement = if messages.is_empty() {
        centered_note("No chat messages").into_any_element()
    } else {
        v_flex()
            .rounded_lg()
            .overflow_hidden()
            .bg(theme::surface())
            .border_1()
            .border_color(theme::border())
            .child(
                v_flex()
                    .px_4()
                    .py_3()
                    .bg(rgba(0xd07a2d33))
                    .border_b_1()
                    .border_color(theme::border())
                    .child(div().text_lg().font_weight(FontWeight::SEMIBOLD).text_color(theme::accent()).child("All Chat"))
                    .child(div().text_xs().text_color(rgb(0x6b7280)).child(format!("{} messages", messages.len()))),
            )
            .children(messages.iter().enumerate().map(|(i, m)| message_row(i, m)))
            .into_any_element()
    };

    v_flex().gap_4().child(controls).child(body).into_any_element()
}

fn message_row(i: usize, m: &ChatMessage) -> impl IntoElement {
    let secs = (m.tick as f64 / 64.0).max(0.0);
    let time = format!("{}:{:02}", (secs / 60.0) as u64, (secs % 60.0) as u64);
    let name = m.name.clone().unwrap_or_else(|| m.steamid.clone());
    let is_server = name.eq_ignore_ascii_case("*server*");
    let text = line(m);
    let group: SharedString = format!("chat-row-{i}").into();

    h_flex()
        .id(group.clone())
        .group(group.clone())
        .items_start()
        .gap_3()
        .p_3()
        .when(i > 0, |d| d.border_t_1().border_color(theme::border()))
        .hover(|s| s.bg(rgba(0x282b3080)))
        .child(
            v_flex()
                .flex_shrink_0()
                .text_xs()
                .text_color(rgb(0x6b7280))
                .child(div().font_family("Consolas").child(format!("Round {}", m.round_index + 1)))
                .child(time),
        )
        .child(
            v_flex()
                .flex_1()
                .min_w_0()
                .gap_1()
                .child(
                    h_flex()
                        .gap_2()
                        .child(match &m.name {
                            Some(_) => div()
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(theme::accent())
                                .when(is_server, |d| d.italic())
                                .child(name)
                                .into_any_element(),
                            // No name: the SteamID links to the Steam profile, like Electron.
                            None => {
                                let url = format!("https://steamcommunity.com/profiles/{}", m.steamid);
                                div()
                                    .id(SharedString::from(format!("chat-profile-{i}")))
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(theme::accent())
                                    .underline()
                                    .cursor_pointer()
                                    .child(name)
                                    .on_click(move |_, _, cx| cx.open_url(&url))
                                    .into_any_element()
                            }
                        })
                        .when_some(m.team.clone(), |d, team| {
                            d.child(
                                div()
                                    .px_1p5()
                                    .py_0p5()
                                    .rounded_sm()
                                    .text_xs()
                                    .text_color(rgb(0x6b7280))
                                    .bg(if team == "T" { rgba(0x7c2d1233) } else { rgba(0x1e3a8a33) })
                                    .child(team),
                            )
                        })
                        .child(div().flex_1())
                        .child(
                            div()
                                .invisible()
                                .group_hover(group.clone(), |s| s.visible())
                                .child(
                                    icon_button(SharedString::from(format!("copy-{i}")), IconName::Copy)
                                        .on_click(move |_, _, cx| copy_to_clipboard(text.clone(), cx)),
                                ),
                        ),
                )
                .child(div().text_sm().text_color(theme::text_soft()).child(m.message.clone())),
        )
}
