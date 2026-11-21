//! "What's New" dialog (Electron `WhatsNewModal`): this version's GitHub release notes
//! as Markdown, shown once after an update and from Settings → App info.

use gpui_kit::component::text::TextView;
use gpui_kit::component::{IconName, h_flex, v_flex};
use gpui_kit::*;

use crate::theme;
use crate::ui;
use gpui_kit::component::scroll::ScrollableElement as _;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

enum Notes {
    Loading,
    Ready { title: String, body: String },
}

pub struct WhatsNew {
    open: Option<Notes>,
}

struct GlobalWhatsNew(Entity<WhatsNew>);
impl Global for GlobalWhatsNew {}

pub fn init(cx: &mut App) {
    let e = cx.new(|_| WhatsNew { open: None });
    cx.set_global(GlobalWhatsNew(e));
    // After an update, show it once (Electron `shouldShowWhatsNew`, then setLastSeenVersion on close).
    cx.spawn(async move |cx| {
        let show = cx.background_spawn(async { cs2da_core::releases::should_show_whats_new(VERSION) }).await;
        if show {
            cx.update(show_dialog);
        }
    })
    .detach();
}

pub fn entity(cx: &App) -> Entity<WhatsNew> {
    cx.global::<GlobalWhatsNew>().0.clone()
}

/// Open the dialog and load the notes (falls back like Electron when GitHub can't be reached).
pub fn show_dialog(cx: &mut App) {
    let e = entity(cx);
    e.update(cx, |w, cx| {
        w.open = Some(Notes::Loading);
        cx.notify();
        cx.spawn(async move |this, cx| {
            // CS2DA_WHATS_NEW_VERSION shows another release's notes (for testing the dialog).
            let version = std::env::var("CS2DA_WHATS_NEW_VERSION").unwrap_or_else(|_| VERSION.to_string());
            let notes = cx.background_spawn(async move { cs2da_core::releases::release_notes(&version) }).await;
            let (title, body) = match notes {
                Some(n) if !n.body.trim().is_empty() => (n.title, n.body),
                _ => (format!("What's New in Version {VERSION}"), "Bug fixes and improvements".to_string()),
            };
            this.update(cx, |w, cx| {
                if w.open.is_some() {
                    w.open = Some(Notes::Ready { title, body });
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    });
}

fn close(cx: &mut App) {
    cs2da_core::releases::mark_seen(VERSION);
    entity(cx).update(cx, |w, cx| {
        w.open = None;
        cx.notify();
    });
}

pub fn render(cx: &mut App) -> Option<AnyElement> {
    let e = entity(cx);
    let w = e.read(cx);
    let notes = w.open.as_ref()?;
    let (title, body): (String, AnyElement) = match notes {
        Notes::Loading => (
            format!("What's New in Version {VERSION}"),
            ui::centered_note("Loading release notes...").into_any_element(),
        ),
        Notes::Ready { title, body } => (
            title.clone(),
            TextView::markdown("whats-new-notes", body.clone()).into_any_element(),
        ),
    };
    Some(
        div()
            .id("whats-new-backdrop")
            .absolute()
            .inset_0()
            .bg(rgba(0x000000aa))
            .occlude()
            .flex()
            .items_center()
            .justify_center()
            .on_click(|_, _, cx| close(cx))
            .child(
                v_flex()
                    .id("whats-new-panel")
                    .w(px(720.))
                    .max_h(relative(0.8))
                    .rounded_lg()
                    .bg(theme::secondary())
                    .border_1()
                    .border_color(theme::border())
                    .shadow_lg()
                    // Clicks inside the panel don't close it.
                    .on_click(|_, _, cx| cx.stop_propagation())
                    .child(
                        h_flex()
                            .justify_between()
                            .px_6()
                            .py_4()
                            .border_b_1()
                            .border_color(theme::border())
                            .child(div().text_xl().font_weight(FontWeight::BOLD).child(title))
                            .child(ui::icon_button("whats-new-close", IconName::Close).on_click(|_, _, cx| close(cx))),
                    )
                    .child(div().id("whats-new-body").flex_1().min_h_0().overflow_y_scrollbar().px_6().py_4().child(body)),
            )
            .into_any_element(),
    )
}
