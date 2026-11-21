//! What the overlay window draws (Electron `OverlayScreen`, `EventsList`, `IncidentPanel`,
//! `DebugCommandPanel`): the events list or perspective panel top-left, the debug command
//! log top-right in debug mode, and the hotkey hint bottom-right. Everything else is
//! transparent and click-through.

use cs2da_core::MatchEvent;
use gpui_kit::component::{IconName, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use super::{ActionStatus, MatchData, Overlay};
use crate::theme;
use gpui_kit::component::scroll::ScrollableElement as _;

pub struct OverlayView {
    overlay: Entity<Overlay>,
    _observe: Subscription,
}

impl OverlayView {
    pub fn new(overlay: Entity<Overlay>, cx: &mut Context<Self>) -> Self {
        let _observe = cx.observe(&overlay, |_, _, cx| cx.notify());
        Self { overlay, _observe }
    }
}

/// Records a panel's bounds each frame so hover can switch off click-through over it.
fn region_probe(key: &'static str, overlay: &Overlay) -> impl IntoElement {
    let regions = overlay.regions.clone();
    canvas(
        move |bounds, _, _| {
            regions.borrow_mut().insert(key, bounds);
        },
        |_, _, _, _| {},
    )
    .absolute()
    .inset_0()
}

/// The overlay's panel look: near-opaque dark card with a soft border, blue outline on hover.
fn panel(hovered: bool) -> Div {
    v_flex()
        .p_4()
        .rounded_lg()
        .bg(rgba(0x1e2124f2))
        .border_1()
        .border_color(rgba(0x42454980))
        .shadow_xl()
        .when(hovered, |d| d.border_2().border_color(rgb(0x3b82f6)))
}

fn card(label: &'static str, value: String, sub: Option<String>) -> impl IntoElement {
    v_flex()
        .p_3()
        .rounded_md()
        .bg(rgba(0x36393e80))
        .border_1()
        .border_color(rgba(0x4245494d))
        .child(div().text_xs().text_color(theme::text_muted()).mb_1p5().child(label.to_uppercase()))
        .child(div().font_weight(FontWeight::SEMIBOLD).child(value))
        .when_some(sub, |d, s| d.child(div().mt_1p5().text_xs().text_color(theme::text_muted()).child(s)))
}

/// `TEAM_FLASH` → `Team Flash`.
fn event_label(kind: &str) -> String {
    kind.split('_')
        .map(|w| {
            let mut c = w.chars();
            c.next().map(|f| f.to_uppercase().chain(c.flat_map(char::to_lowercase)).collect::<String>()).unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn thousands(n: i64) -> String {
    let s = n.abs().to_string();
    let mut out = String::new();
    for (i, ch) in s.chars().enumerate() {
        if i > 0 && (s.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(ch);
    }
    if n < 0 { format!("-{out}") } else { out }
}

/// Electron's key names for the hint chips (`CommandOrControl` → `Ctrl`).
fn key_names(acc: &str) -> Vec<String> {
    acc.split('+')
        .map(|k| match k {
            "CommandOrControl" | "CmdOrCtrl" | "Control" | "Command" => "Ctrl".to_string(),
            other => other.to_string(),
        })
        .collect()
}

pub fn key_chips(acc: &str) -> impl IntoElement {
    let names = key_names(acc);
    let n = names.len();
    h_flex().gap_1().items_center().children(names.into_iter().enumerate().flat_map(move |(i, k)| {
        let chip = div()
            .px_1p5()
            .py_0p5()
            .min_w(px(24.))
            .rounded_sm()
            .border_1()
            .border_color(rgba(0xffffff40))
            .bg(rgba(0x36393e80))
            .text_xs()
            .font_family("Consolas")
            .text_color(theme::text())
            .flex()
            .justify_center()
            .child(k.to_uppercase())
            .into_any_element();
        let plus = (i + 1 < n).then(|| div().text_xs().text_color(theme::text_muted()).child("+").into_any_element());
        std::iter::once(chip).chain(plus)
    }))
}

impl OverlayView {
    fn events_list(&self, o: &Overlay) -> AnyElement {
        let overlay = self.overlay.clone();
        let filter = o.player_filter.clone();
        let body: AnyElement = match &o.match_data {
            None | Some(MatchData::Loading) => note("Loading events...", theme::text_muted()),
            Some(MatchData::Failed(e)) => note(e, rgb(0xf87171)),
            Some(MatchData::Ready { events, roster }) => {
                let shown: Vec<&MatchEvent> =
                    events.iter().filter(|e| filter.as_ref().is_none_or(|f| e.actor.as_ref() == Some(f))).collect();
                let count = shown.len();
                let chip = |id: SharedString, label: String, active: bool, value: Option<String>| {
                    let overlay = overlay.clone();
                    div()
                        .id(id)
                        .px_2()
                        .py_0p5()
                        .rounded_sm()
                        .text_xs()
                        .cursor_pointer()
                        .when(active, |d| d.bg(theme::accent()))
                        .when(!active, |d| d.bg(rgba(0x36393e80)).hover(|s| s.bg(rgba(0x36393eb3))))
                        .child(label)
                        .on_click(move |_, _, cx| {
                            overlay.update(cx, |o, cx| {
                                o.player_filter = value.clone();
                                cx.notify();
                            })
                        })
                };
                let mut chips = vec![chip("ov-all".into(), "All Players".into(), filter.is_none(), None)];
                for p in roster {
                    chips.push(chip(
                        SharedString::from(format!("ov-p-{}", p.steamid)),
                        p.name.clone(),
                        filter.as_deref() == Some(p.steamid.as_str()),
                        Some(p.steamid.clone()),
                    ));
                }
                let rows: Vec<AnyElement> = shown
                    .iter()
                    .enumerate()
                    .map(|(i, e)| {
                        let overlay = overlay.clone();
                        let ev = (*e).clone();
                        let secs = e.start_tick.max(0) / 64;
                        v_flex()
                            .id(SharedString::from(format!("ov-ev-{i}")))
                            .p_2p5()
                            .rounded_sm()
                            .bg(rgba(0x36393e80))
                            .border_1()
                            .border_color(rgba(0x4245494d))
                            .cursor_pointer()
                            .hover(|s| s.bg(rgba(0x36393eb3)))
                            .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).truncate().child(event_label(&e.kind)))
                            .child(
                                div()
                                    .mt_1()
                                    .text_xs()
                                    .text_color(theme::text_muted())
                                    .child(format!("Offender: {}", o.player_name(e.actor.as_deref()))),
                            )
                            .when_some(e.victim.as_deref(), |d, v| {
                                d.child(div().text_xs().text_color(theme::text_muted()).child(format!("Victim: {}", o.player_name(Some(v)))))
                            })
                            .child(div().mt_0p5().text_xs().text_color(theme::text_muted()).child(format!(
                                "Tick: {} ({}:{:02})",
                                thousands(e.start_tick),
                                secs / 60,
                                secs % 60
                            )))
                            .child(div().mt_0p5().text_xs().text_color(rgb(0x6b7280)).child(format!("Round {}", e.round_index + 1)))
                            .on_click(move |_, _, cx| overlay.update(cx, |o, cx| o.select_event(&ev, cx)))
                            .into_any_element()
                    })
                    .collect();
                v_flex()
                    .gap_3()
                    .child(h_flex().flex_wrap().gap_1().children(chips))
                    .child(if count == 0 {
                        note("No events found", theme::text_muted())
                    } else {
                        v_flex()
                            .id("ov-events")
                            .max_h(px(440.))
                            .overflow_y_scrollbar()
                            .gap_1()
                            .pr_2()
                            .children(rows)
                            .into_any_element()
                    })
                    .when(count > 0, |d| {
                        d.child(
                            div()
                                .pt_3()
                                .border_t_1()
                                .border_color(rgba(0x4245494d))
                                .text_xs()
                                .text_color(theme::text_muted())
                                .child(format!("{count} event{}", if count == 1 { "" } else { "s" })),
                        )
                    })
                    .into_any_element()
            }
        };
        panel(o.hovered)
            .relative()
            .min_w(px(400.))
            .max_w(px(448.))
            .gap_4()
            .child(div().font_weight(FontWeight::SEMIBOLD).child("Events"))
            .child(body)
            .child(region_probe("panel", o))
            .into_any_element()
    }

    fn incident_panel(&self, o: &Overlay) -> AnyElement {
        let Some(inc) = o.incident.clone() else { return div().into_any_element() };
        let single = matches!(inc.event_type.as_deref(), Some("AFK_STILLNESS" | "DISCONNECT"));
        let loading = matches!(o.action, Some(ActionStatus::Loading));
        let (back, off, vic) = (self.overlay.clone(), self.overlay.clone(), self.overlay.clone());
        let event_card = inc.event_type.as_deref().map(|t| {
            let (label, sub) = if t == "AFK_STILLNESS" {
                let d = ["seconds", "afkDuration"].iter().find_map(|k| inc.meta.get(*k).and_then(|v| v.as_f64()));
                let dur = d.map_or("N/A".to_string(), |d| {
                    if d < 60.0 { format!("{d:.1}s") } else { format!("{}m {}s", (d / 60.0) as u64, (d % 60.0) as u64) }
                });
                ("Afk".to_string(), Some(format!("Duration: {dur}")))
            } else {
                (event_label(t), None)
            };
            card("Event Type", label, sub)
        });
        let button = |id: &'static str, label: &'static str, primary: bool, on: Entity<Overlay>, offender: bool| {
            h_flex()
                .id(id)
                .justify_center()
                .gap_2()
                .px_4()
                .py_2p5()
                .rounded_md()
                .text_sm()
                .font_weight(FontWeight::SEMIBOLD)
                .when(primary, |d| d.bg(theme::accent()).hover(|s| s.bg(rgba(0xd07a2dcc))))
                .when(!primary, |d| d.bg(theme::surface()).hover(|s| s.bg(rgba(0x36393ecc))))
                .when(loading, |d| d.opacity(0.5))
                .when(!loading, |d| d.cursor_pointer())
                .when(loading, |d| d.child(IconName::Loader))
                .child(label)
                .on_click(move |_, _, cx| {
                    if !loading {
                        on.update(cx, |o, cx| o.view_player(offender, cx));
                    }
                })
        };
        let toast = o.action.clone().map(|a| {
            let (bg, border, fg, text) = match a {
                ActionStatus::Loading => (rgba(0x3b82f633), rgba(0x3b82f64d), rgb(0x93c5fd), "Loading...".to_string()),
                ActionStatus::Success(m) => (rgba(0x22c55e33), rgba(0x22c55e4d), rgb(0x86efac), m),
                ActionStatus::Error(m) => (rgba(0xef444433), rgba(0xef44444d), rgb(0xfca5a5), m),
            };
            div().mt_3().px_3().py_2().rounded_sm().border_1().border_color(border).bg(bg).text_xs().text_color(fg).child(text)
        });
        panel(o.hovered)
            .relative()
            .min_w(px(300.))
            .max_w(px(384.))
            .gap_4()
            .child(
                h_flex()
                    .gap_3()
                    .child(
                        div()
                            .id("ov-back")
                            .p_1p5()
                            .rounded_sm()
                            .cursor_pointer()
                            .hover(|s| s.bg(rgba(0x36393e80)))
                            .child(IconName::ArrowLeft)
                            .on_click(move |_, _, cx| {
                                back.update(cx, |o, cx| {
                                    o.show_events_list = true;
                                    cx.notify();
                                })
                            }),
                    )
                    .child(div().font_weight(FontWeight::SEMIBOLD).child("Perspective")),
            )
            .children(event_card)
            .child(card("Offender", inc.offender.name.clone(), None))
            .when(!single, |d| d.child(card("Victim", inc.victim.name.clone(), None)))
            .when(o.interactive, |d| {
                d.child(
                    v_flex()
                        .gap_2p5()
                        .child(button("ov-offender", "View Offender", true, off, true))
                        .when(!single, |d| d.child(button("ov-victim", "View Victim", false, vic, false))),
                )
            })
            .children(toast)
            .child(region_probe("panel", o))
            .into_any_element()
    }

    fn debug_panel(&self, o: &Overlay) -> AnyElement {
        let log = cs2da_core::cs2_launch::command_log();
        let n = log.len();
        panel(o.hovered)
            .relative()
            .w(px(380.))
            .gap_2()
            .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).child("Debug: Commands"))
            .child(
                v_flex()
                    .id("ov-debug")
                    .max_h(px(320.))
                    .overflow_y_scrollbar()
                    .gap_1()
                    .font_family("Consolas")
                    .text_xs()
                    .when(n == 0, |d| d.child(div().text_color(theme::text_muted()).child("No commands sent yet")))
                    .children(log.into_iter().map(|entry| {
                        use chrono::TimeZone as _;
                        let time = chrono::Local
                            .timestamp_millis_opt(entry.ts as i64)
                            .single()
                            .map_or_else(String::new, |t| t.format("%H:%M:%S").to_string());
                        h_flex()
                            .gap_2()
                            .child(div().text_color(rgb(0x6b7280)).child(time))
                            .child(div().text_color(theme::text_soft()).child(entry.cmd))
                    })),
            )
            .when(n > 0, |d| {
                d.child(div().text_xs().text_color(theme::text_muted()).child(format!("{n} command{}", if n == 1 { "" } else { "s" })))
            })
            .child(region_probe("debug", o))
            .into_any_element()
    }
}

fn note(text: impl Into<SharedString>, color: impl Into<Hsla>) -> AnyElement {
    div().py_8().flex().justify_center().text_sm().text_color(color.into()).child(text.into()).into_any_element()
}

impl Render for OverlayView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let overlay = self.overlay.clone();
        let o = overlay.read(cx);
        o.scale.set(window.scale_factor());
        // Forget panels that aren't drawn this time so hover can't hit a stale rect.
        let show_panel = o.incident.is_some() && (o.interactive || !o.show_events_list);
        {
            let mut regions = o.regions.borrow_mut();
            if !show_panel {
                regions.remove("panel");
            }
            if !o.debug_mode {
                regions.remove("debug");
            }
        }
        let main_panel = show_panel.then(|| {
            if o.show_events_list { self.events_list(o) } else { self.incident_panel(o) }
        });
        let debug = o.debug_mode.then(|| self.debug_panel(o));
        let hotkey = o.hotkey.clone();
        div()
            .size_full()
            .relative()
            .text_color(theme::text())
            .children(main_panel.map(|p| div().absolute().top(px(96.)).left_4().child(p)))
            .children(debug.map(|p| div().absolute().top_4().right_4().child(p)))
            .child(
                div().absolute().bottom_4().right_4().child(
                    h_flex()
                        .gap_2()
                        .px_3()
                        .py_1p5()
                        .rounded_sm()
                        .bg(rgba(0x1e2124cc))
                        .border_1()
                        .border_color(rgba(0x4245494d))
                        .shadow_lg()
                        .child(div().text_xs().font_weight(FontWeight::MEDIUM).text_color(theme::text_soft()).child("Toggle overlay:"))
                        .child(key_chips(&hotkey)),
                ),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::{event_label, key_names, thousands};

    #[test]
    fn labels_like_electron() {
        assert_eq!(event_label("TEAM_FLASH"), "Team Flash");
        assert_eq!(key_names("CommandOrControl+Shift+O"), vec!["Ctrl", "Shift", "O"]);
        assert_eq!(thousands(123456), "123,456");
    }
}
