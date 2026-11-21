//! Overview tab (Electron `MatchesOverviewTab`): seven summary cards, then one
//! collapsible section per event type. Sections with no events are hidden.

mod economy;
mod icons;
mod sections;

use std::collections::HashSet;

use cs2da_core::{MatchEvent, MatchSummary};
use gpui_kit::component::{IconName, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::i18n::t;
use crate::theme;

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub enum Section {
    Afk,
    Disconnects,
    TeamKills,
    TeamDamage,
    TeamFlashes,
    Economy,
    BodyBlock,
}

/// Per-match UI state of the Overview tab.
pub struct OverviewState {
    collapsed: HashSet<Section>,
    afk_min_seconds: f64,
    afk_sort_by_duration: bool,
    flash_min_seconds: f64,
}

impl OverviewState {
    /// Fresh state for a newly opened match. Thresholds start at the Settings
    /// defaults (`default_afk_threshold`, `default_flash_threshold`), like Electron.
    pub fn for_new_match() -> Self {
        let (afk, flash) = cs2da_core::settings::Settings::open()
            .map(|s| {
                (
                    s.get_or("default_afk_threshold", "10").parse().unwrap_or(10.0),
                    s.get_or("default_flash_threshold", "1.5").parse().unwrap_or(1.5),
                )
            })
            .unwrap_or((10.0, 1.5));
        Self {
            collapsed: HashSet::new(),
            afk_min_seconds: afk,
            afk_sort_by_duration: false,
            flash_min_seconds: flash,
        }
    }
}

impl Default for OverviewState {
    fn default() -> Self {
        Self {
            collapsed: HashSet::new(),
            afk_min_seconds: 10.0,
            afk_sort_by_duration: false,
            flash_min_seconds: 1.5,
        }
    }
}

/// Gives section callbacks mutable access to the state owned by view `V`.
pub type StateOf<V> = fn(&mut V) -> &mut OverviewState;

/// "View in 2D": switch view `V` to the 2D tab at a tick.
pub type View2d<V> = fn(&mut V, i64, &mut Window, &mut Context<V>);

pub fn render<V: 'static>(
    s: &MatchSummary,
    state: &OverviewState,
    state_of: StateOf<V>,
    view_2d: Option<View2d<V>>,
    cx: &mut Context<V>,
) -> AnyElement {
    let of = |kind: &str| s.events.iter().filter(|e| e.kind == kind).collect::<Vec<&MatchEvent>>();
    let afk = of("AFK_STILLNESS");
    let team_kills = of("TEAM_KILL");
    let team_damage = of("TEAM_DAMAGE");
    let disconnects = of("DISCONNECT");
    let flashes = of("TEAM_FLASH");
    let economy = of("ECONOMY_GRIEF");
    let body_blocks = of("BODY_BLOCK");

    let tick_rate = if s.tick_rate > 0.0 { s.tick_rate } else { 64.0 };
    let ctx = sections::Ctx {
        summary: s,
        state,
        state_of,
        tick_rate,
        view_2d: view_2d.map(|f| (f, cx.entity().downgrade())),
        has_demo: s.info.demo_path.is_some(),
    };

    v_flex()
        .gap_4()
        .child(summary_cards([
            afk.len(),
            team_kills.len(),
            team_damage.len(),
            disconnects.len(),
            flashes.len(),
            economy.len(),
            body_blocks.len(),
        ]))
        .when(!afk.is_empty(), |d| d.child(sections::afk(&ctx, &afk, cx)))
        .when(!disconnects.is_empty(), |d| d.child(sections::disconnects(&ctx, &disconnects, cx)))
        .when(!team_kills.is_empty(), |d| d.child(sections::team_kills(&ctx, &team_kills, cx)))
        .when(!team_damage.is_empty(), |d| d.child(sections::team_damage(&ctx, &team_damage, cx)))
        .when(!flashes.is_empty(), |d| d.child(sections::team_flashes(&ctx, &flashes, cx)))
        .when(!economy.is_empty(), |d| d.child(economy::section(&ctx, &economy, cx)))
        .when(!body_blocks.is_empty(), |d| d.child(sections::body_blocks(&ctx, &body_blocks, cx)))
        .into_any_element()
}

/// StatSummaryCards: one card per event type with its count.
fn summary_cards(counts: [usize; 7]) -> impl IntoElement {
    let [afk, team_kills, team_damage, disconnects, flashes, economy, body_blocks] = counts;
    let card = |icon: AnyElement, title: String, count: usize, color: Rgba, subtitle: String| {
        v_flex()
            .min_w_0()
            .p_4()
            .rounded_lg()
            .bg(theme::surface())
            .border_1()
            .border_color(theme::border())
            .child(
                h_flex()
                    .gap_2()
                    .mb_2()
                    .text_color(theme::text_muted())
                    .child(icon)
                    .child(div().text_sm().font_weight(FontWeight::MEDIUM).child(title)),
            )
            .child(div().mb_1().text_3xl().font_weight(FontWeight::BOLD).text_color(color).child(count.to_string()))
            .child(div().text_xs().text_color(rgb(0x6b7280)).child(subtitle))
    };
    // Electron: lg:grid-cols-7. The detail panel is always wide enough for 7 here.
    div()
        .grid()
        .grid_cols(7)
        .gap_3()
        .child(card(icons::clock(), "AFK Detections".into(), afk, theme::text(), "No movement after freezetime".into()))
        .child(card(icons::skull(), "Team Kills".into(), team_kills, rgb(0xf87171), "Friendly fire kills".into()))
        .child(card(
            icons::zap(),
            t("matches.sections.teamDamage"),
            team_damage,
            theme::accent(),
            t("matches.friendlyFireDamage"),
        ))
        .child(card(icons::wifi_off(), "Disconnects".into(), disconnects, theme::text_muted(), "Player disconnection events".into()))
        .child(card(
            icons::zap(),
            t("matches.sections.teamFlashes"),
            flashes,
            theme::accent(),
            t("matches.friendlyFlashbangs"),
        ))
        .child(card(icons::dollar(), "Economy Grief".into(), economy, rgb(0xfacc15), "Poor buy decisions".into()))
        .child(card(icons::body_block(), "Body Block".into(), body_blocks, rgb(0xc084fc), "Head stacking incidents".into()))
}

/// The bordered box around a section, with its clickable title and optional controls.
fn section_frame<V: 'static>(
    ctx: &sections::Ctx<'_, V>,
    section: Section,
    icon: AnyElement,
    title: String,
    hover_color: Rgba,
    controls: Option<AnyElement>,
    body: impl FnOnce() -> AnyElement,
    cx: &mut Context<V>,
) -> AnyElement {
    let expanded = !ctx.state.collapsed.contains(&section);
    let state_of = ctx.state_of;
    let id: SharedString = format!("overview-section-{}", section as u8).into();
    v_flex()
        .p_4()
        .rounded_lg()
        .bg(theme::surface())
        .border_1()
        .border_color(theme::border())
        .child(
            h_flex()
                .mb_3()
                .justify_between()
                .child(
                    h_flex()
                        .id(id)
                        .gap_2()
                        .text_lg()
                        .font_weight(FontWeight::SEMIBOLD)
                        .cursor_pointer()
                        .hover(move |s| s.text_color(hover_color))
                        .child(icon)
                        .child(title)
                        // Electron shows a down chevron while expanded.
                        .child(
                            div()
                                .text_color(rgb(0x6b7280))
                                .child(if expanded { IconName::ChevronDown } else { IconName::ChevronUp }),
                        )
                        .on_click(cx.listener(move |this, _, _, cx| {
                            let st = state_of(this);
                            if !st.collapsed.remove(&section) {
                                st.collapsed.insert(section);
                            }
                            cx.notify();
                        })),
                )
                .children(controls),
        )
        .when(expanded, |d| d.child(body()))
        .into_any_element()
}
