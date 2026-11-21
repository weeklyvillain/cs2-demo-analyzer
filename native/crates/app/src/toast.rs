//! App-wide toasts (Electron `ToastContext` + `ToastStack`): stacked top-right,
//! green / red / blue, each dismissing itself after its duration.

use std::time::Duration;

use gpui_kit::component::{IconName, h_flex, v_flex};
use gpui_kit::*;


#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Success,
    Error,
    Info,
}

struct Toast {
    id: u64,
    kind: Kind,
    message: String,
}

pub struct Toasts {
    items: Vec<Toast>,
    next_id: u64,
}

struct GlobalToasts(Entity<Toasts>);
impl Global for GlobalToasts {}

pub fn init(cx: &mut App) {
    let toasts = cx.new(|_| Toasts { items: Vec::new(), next_id: 0 });
    cx.set_global(GlobalToasts(toasts));
}

pub fn entity(cx: &App) -> Entity<Toasts> {
    cx.global::<GlobalToasts>().0.clone()
}

/// Show a toast for `ms` milliseconds (Electron's default is 3000).
pub fn push(kind: Kind, message: impl Into<String>, ms: u64, cx: &mut App) {
    entity(cx).update(cx, |t, cx| {
        let id = t.next_id;
        t.next_id += 1;
        t.items.push(Toast { id, kind, message: message.into() });
        cx.notify();
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(ms)).await;
            this.update(cx, |t, cx| {
                t.items.retain(|x| x.id != id);
                cx.notify();
            })
            .ok();
        })
        .detach();
    });
}

pub fn render(cx: &mut App) -> Option<AnyElement> {
    let entity = entity(cx);
    let t = entity.read(cx);
    if t.items.is_empty() {
        return None;
    }
    Some(
        v_flex()
            .absolute()
            .top_16()
            .right_4()
            .max_w(px(384.))
            .gap_2()
            .children(t.items.iter().map(|toast| {
                let (bg, border, fg, icon) = match toast.kind {
                    Kind::Success => (rgba(0x14532de6), rgba(0x22c55e80), rgb(0x86efac), IconName::Check),
                    Kind::Error => (rgba(0x7f1d1de6), rgba(0xef444480), rgb(0xfca5a5), IconName::CircleAlert),
                    Kind::Info => (rgba(0x1e3a8ae6), rgba(0x3b82f680), rgb(0x93c5fd), IconName::Info),
                };
                let (id, close) = (toast.id, entity.clone());
                h_flex()
                    .gap_3()
                    .px_4()
                    .py_3()
                    .rounded_lg()
                    .border_1()
                    .border_color(border)
                    .bg(bg)
                    .shadow_lg()
                    .text_color(fg)
                    .child(icon)
                    .child(div().flex_1().text_sm().font_weight(FontWeight::MEDIUM).child(toast.message.clone()))
                    .child(
                        div()
                            .id(SharedString::from(format!("toast-close-{id}")))
                            .p_1()
                            .rounded_sm()
                            .cursor_pointer()
                            .opacity(0.7)
                            .hover(|s| s.opacity(1.0).bg(rgba(0x00000033)))
                            .child(IconName::Close)
                            .on_click(move |_, _, cx| {
                                close.update(cx, |t, cx| {
                                    t.items.retain(|x| x.id != id);
                                    cx.notify();
                                })
                            }),
                    )
            }))
            .into_any_element(),
    )
}
