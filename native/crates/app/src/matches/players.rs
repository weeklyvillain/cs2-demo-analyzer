//! Players tab: Team A and Team B columns of player cards (Electron `MatchesPlayersTab`),
//! with Watch POV, Extract Voice, Team Voice and a click-through to the player modal.

use std::collections::HashMap;
use std::path::PathBuf;
use std::rc::Rc;

use cs2da_core::{MatchSummary, RosterPlayer};
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::component::{IconName, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::i18n::{t, tf};
use crate::theme;
use crate::ui::centered_note;
use crate::voice;

/// In-game player color name -> the color the Electron app draws for it.
fn cs_color(name: &str) -> Option<Rgba> {
    Some(match name {
        "yellow" => rgb(0x4db8ff),
        "purple" => rgb(0x4caf50),
        "green" => rgb(0xf5d30f),
        "blue" => rgb(0xff6b26),
        "orange" => rgb(0x8847ff),
        _ => return None,
    })
}

/// Players who joined mid-game go last, then most team kills first.
fn sorted(players: impl Iterator<Item = RosterPlayer>) -> Vec<RosterPlayer> {
    let mut v: Vec<_> = players.collect();
    v.sort_by(|a, b| {
        a.connected_midgame
            .cmp(&b.connected_midgame)
            .then(b.team_kills.cmp(&a.team_kills))
    });
    v
}

/// What the cards need to decide their voice buttons.
struct Ctx {
    /// Jumps the 2D viewer (None when the map has no radar), for the player window.
    view_2d: Option<voice::View2d>,
    summary: Rc<MatchSummary>,
    demo: Option<PathBuf>,
    /// `None` while scanning or if the scan failed: buttons stay enabled, like Electron.
    speakers: Option<HashMap<String, f64>>,
}

impl Ctx {
    fn has_voice(&self, steam_id: &str) -> bool {
        self.speakers.as_ref().is_none_or(|s| s.get(steam_id).copied().unwrap_or(0.0) > 0.0)
    }

    fn voice_title(&self, p: &RosterPlayer) -> String {
        if self.demo.is_none() {
            return t("matches.demoFileRequired");
        }
        if !self.has_voice(&p.steamid) {
            return tf("matches.noVoiceFor", &[("name", &p.name)]);
        }
        let base = tf("matches.extractVoiceFor", &[("name", &p.name)]);
        match self.speakers.as_ref().and_then(|s| s.get(&p.steamid)) {
            Some(secs) if *secs > 0.0 => format!("{base} ({})", voice::voice_seconds(*secs)),
            _ => base,
        }
    }
}

pub fn render(s: &MatchSummary, view_2d: Option<voice::View2d>, cx: &mut App) -> AnyElement {
    if s.roster.is_empty() {
        return centered_note(t("matches.noPlayersAvailable")).into_any_element();
    }
    let demo = s.info.demo_path.clone().filter(|p| p.exists());
    let speakers = demo.as_deref().and_then(|d| voice::speakers(d, cx));
    let ctx = Rc::new(Ctx { summary: Rc::new(s.clone()), demo, speakers, view_2d });

    let of_team = |t: Option<&str>| sorted(s.roster.iter().filter(|p| p.team.as_deref() == t).cloned());
    let team_a = of_team(Some("A"));
    let team_b = of_team(Some("B"));
    let no_team = sorted(s.roster.iter().filter(|p| !matches!(p.team.as_deref(), Some("A" | "B"))).cloned());

    v_flex()
        .gap_6()
        .child(
            div()
                .grid()
                .grid_cols(2)
                .gap_4()
                .child(column(&ctx, "Team A", &team_a))
                .child(column(&ctx, "Team B", &team_b)),
        )
        .when(!no_team.is_empty(), |d| {
            d.child(
                v_flex()
                    .gap_2()
                    .child(div().px_2().py_2().bg(rgba(0x36393e4d)).border_b_1().border_color(theme::border()).text_lg().font_weight(FontWeight::SEMIBOLD).text_color(theme::text_muted()).child("Unknown Team"))
                    .child(div().grid().grid_cols(2).gap_2().children(no_team.iter().map(|p| card(&ctx, p)))),
            )
        })
        .into_any_element()
}

fn small_button(id: SharedString, icon: IconName, label: String, primary: bool, enabled: bool, title: String) -> Stateful<Div> {
    h_flex()
        .id(id)
        .gap_1p5()
        .px_2p5()
        .py_1p5()
        .rounded_sm()
        .text_sm()
        .when(enabled && primary, |d| d.bg(theme::accent()).cursor_pointer().hover(|s| s.bg(theme::accent_light())))
        .when(enabled && !primary, |d| d.bg(theme::secondary()).cursor_pointer().hover(|s| s.bg(theme::surface())))
        .when(!enabled, |d| d.bg(rgb(0x4b5563)).opacity(0.7).cursor_not_allowed())
        .child(icon)
        .child(label)
        .tooltip(move |window, cx| Tooltip::new(title.clone()).build(window, cx))
}

fn column(ctx: &Rc<Ctx>, title: &'static str, players: &[RosterPlayer]) -> impl IntoElement {
    let team_has_voice = !players.is_empty() && players.iter().any(|p| ctx.has_voice(&p.steamid));
    let enabled = ctx.demo.is_some() && team_has_voice;
    let tooltip = if ctx.demo.is_none() {
        t("matches.demoFileRequired")
    } else if !team_has_voice {
        t("matches.noTeamVoice")
    } else {
        "Extract team voice".into()
    };
    let team_players: Vec<(String, String)> = players.iter().map(|p| (p.steamid.clone(), p.name.clone())).collect();
    let demo = ctx.demo.clone();
    v_flex()
        .gap_2()
        .child(
            h_flex()
                .justify_between()
                .px_2()
                .py_2()
                .bg(rgba(0x36393e4d))
                .border_b_1()
                .border_color(theme::border())
                .child(div().text_lg().font_weight(FontWeight::SEMIBOLD).text_color(theme::accent()).child(title))
                .child(
                    small_button(SharedString::from(format!("team-voice-{title}")), IconName::Mic, "Team Voice".into(), true, enabled, tooltip)
                        .text_xs()
                        .when(enabled, |d| {
                            d.on_click(move |_, window, cx| {
                                cx.stop_propagation();
                                if let Some(demo) = demo.clone() {
                                    voice::open_team(demo, title.to_string(), team_players.clone(), window, cx);
                                }
                            })
                        }),
                ),
        )
        .when(players.is_empty(), |d| d.child(centered_note(t("matches.noPlayers"))))
        .children(players.iter().map(|p| card(ctx, p)))
}

fn card(ctx: &Rc<Ctx>, p: &RosterPlayer) -> impl IntoElement {
    let stat = |label: String, value: String| {
        h_flex()
            .gap_1()
            .child(div().text_color(theme::text_muted()).child(label))
            .child(value)
    };
    let midgame_note = match p.first_connect_round {
        Some(r) => tf("matches.firstConnectRound", &[("round", &(r + 1).to_string())]),
        None => t("matches.connectedMidgame"),
    };
    let disconnect_note = match p.disconnect_round {
        Some(r) => tf("matches.disconnectRound", &[("round", &(r + 1).to_string())]),
        None => t("matches.permanentDisconnect"),
    };
    let has_demo = ctx.demo.is_some();
    let voice_enabled = has_demo && ctx.has_voice(&p.steamid);
    let pov_title = if has_demo {
        "Watch game from this player's POV (2x, jump on death)".to_string()
    } else {
        t("matches.demoFileRequired")
    };

    let (open_ctx, open_player) = (ctx.clone(), p.clone());
    let (voice_demo, voice_id, voice_name) = (ctx.demo.clone(), p.steamid.clone(), p.name.clone());
    let (pov_summary, pov_id, pov_name) = (ctx.summary.clone(), p.steamid.clone(), p.name.clone());

    v_flex()
        .id(SharedString::from(format!("player-card-{}", p.steamid)))
        .gap_2()
        .p_3()
        .rounded_md()
        .border_1()
        .border_color(rgba(0x42454980))
        .cursor_pointer()
        .hover(|s| s.bg(rgba(0x36393e80)))
        .on_click(move |_, window, cx| {
            voice::open_player(&open_ctx.summary, &open_player, open_ctx.view_2d.clone(), window, cx)
        })
        .child(
            h_flex()
                .justify_between()
                .gap_2()
                .child(
                    h_flex()
                        .flex_1()
                        .min_w_0()
                        .gap_1p5()
                        .items_center()
                        .font_weight(FontWeight::MEDIUM)
                        .when_some(p.color.as_deref().and_then(cs_color), |d, c| {
                            d.child(div().size(px(10.)).flex_shrink_0().rounded_full().bg(c))
                        })
                        .when(p.connected_midgame, |d| {
                            d.child(
                                div()
                                    .id(SharedString::from(format!("midgame-{}", p.steamid)))
                                    .text_color(rgb(0x60a5fa))
                                    .child(voice::icons::user_plus())
                                    .tooltip(move |window, cx| Tooltip::new(midgame_note.clone()).build(window, cx)),
                            )
                        })
                        .when(p.permanent_disconnect, |d| {
                            d.child(
                                div()
                                    .id(SharedString::from(format!("left-{}", p.steamid)))
                                    .text_color(rgb(0xf87171))
                                    .child(voice::icons::user_minus())
                                    .tooltip(move |window, cx| Tooltip::new(disconnect_note.clone()).build(window, cx)),
                            )
                        })
                        .child(if p.name == p.steamid {
                            // No name: the SteamID links to the Steam profile, like Electron.
                            let url = format!("https://steamcommunity.com/profiles/{}", p.steamid);
                            div()
                                .id(SharedString::from(format!("profile-{}", p.steamid)))
                                .truncate()
                                .underline()
                                .text_color(theme::accent())
                                .cursor_pointer()
                                .child(p.steamid.clone())
                                .on_click(move |_, _, cx| {
                                    cx.stop_propagation();
                                    cx.open_url(&url);
                                })
                                .into_any_element()
                        } else {
                            div().truncate().child(p.name.clone()).into_any_element()
                        }),
                )
                .child(
                    h_flex()
                        .gap_1p5()
                        .flex_shrink_0()
                        .child(
                            small_button(
                                SharedString::from(format!("pov-{}", p.steamid)),
                                IconName::Play,
                                "Watch POV".into(),
                                false,
                                has_demo,
                                pov_title,
                            )
                            .when(has_demo, |d| {
                                d.on_click(move |_, window, cx| {
                                    cx.stop_propagation();
                                    crate::cs2_watch::watch_pov(&pov_summary, &pov_id, &pov_name, window, cx);
                                })
                            }),
                        )
                        .child(
                            small_button(
                                SharedString::from(format!("voice-{}", p.steamid)),
                                IconName::Mic,
                                t("matches.extractVoice"),
                                true,
                                voice_enabled,
                                ctx.voice_title(p),
                            )
                            .when(voice_enabled, |d| {
                                d.on_click(move |_, window, cx| {
                                    cx.stop_propagation();
                                    if let Some(demo) = voice_demo.clone() {
                                        voice::open_voice(demo, voice_id.clone(), voice_name.clone(), window, cx);
                                    }
                                })
                            }),
                        ),
                ),
        )
        .child(
            div()
                .grid()
                .grid_cols(2)
                .gap_2()
                .text_xs()
                .text_color(theme::text_soft())
                .child(stat(t("matches.teamKillsLabel"), p.team_kills.to_string()))
                .child(stat(t("matches.teamDamageLabel"), format!("{:.1}", p.team_damage)))
                .child(stat(t("matches.flashSecondsLabel"), format!("{:.1}s", p.team_flash_seconds)))
                .child(stat(t("matches.afkSecondsLabel"), format!("{:.1}s", p.afk_seconds))),
        )
}
