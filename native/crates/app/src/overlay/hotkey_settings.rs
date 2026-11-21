//! Settings → Overlay hotkey recorder (Electron `OverlayHotkeySettings`).

use std::time::Duration;

use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use super::{DEFAULT_HOTKEY, entity, view::key_chips};
use crate::theme;
use crate::ui;

pub struct HotkeySettings {
    focus: FocusHandle,
    recording: bool,
    message: Option<(String, bool)>,
    _timeout: Option<Task<()>>,
}

/// A GPUI keystroke as an Electron accelerator (`Control+Shift+O`), or `None` for a bare modifier.
fn accelerator(k: &Keystroke) -> Option<String> {
    let key = match k.key.as_str() {
        "control" | "shift" | "alt" | "platform" | "function" | "" => return None,
        "space" => "Space".to_string(),
        "up" | "down" | "left" | "right" => {
            let mut c = k.key.chars();
            c.next().map(|f| f.to_uppercase().chain(c).collect()).unwrap_or_default()
        }
        k1 if k1.chars().count() == 1 => k1.to_uppercase(),
        other => {
            let mut c = other.chars();
            c.next().map(|f| f.to_uppercase().chain(c).collect()).unwrap_or_default()
        }
    };
    let mut parts = Vec::new();
    if k.modifiers.control || k.modifiers.platform {
        parts.push("Control".to_string());
    }
    if k.modifiers.alt {
        parts.push("Alt".to_string());
    }
    if k.modifiers.shift {
        parts.push("Shift".to_string());
    }
    parts.push(key);
    Some(parts.join("+"))
}

impl HotkeySettings {
    pub fn new(cx: &mut Context<Self>) -> Self {
        Self { focus: cx.focus_handle(), recording: false, message: None, _timeout: None }
    }

    fn start(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.recording = true;
        self.message = None;
        window.focus(&self.focus, cx);
        self._timeout = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_secs(10)).await;
            this.update(cx, |h, cx| {
                if h.recording {
                    h.recording = false;
                    h.message = Some(("Recording timeout. Please try again.".into(), true));
                    cx.notify();
                }
            })
            .ok();
        }));
        cx.notify();
    }

    fn save(&mut self, acc: String, cx: &mut Context<Self>) {
        let result = entity(cx).update(cx, |o, cx| o.set_hotkey(&acc, cx));
        self.message = Some(match result {
            Ok(()) => ("Hotkey saved successfully!".into(), false),
            Err(e) => (e, true),
        });
        cx.notify();
    }

    fn on_key(&mut self, e: &KeyDownEvent, cx: &mut Context<Self>) {
        if !self.recording {
            return;
        }
        if let Some(acc) = accelerator(&e.keystroke) {
            self.recording = false;
            self._timeout = None;
            self.save(acc, cx);
        }
        cx.stop_propagation();
    }
}

impl Render for HotkeySettings {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let hotkey = entity(cx).read(cx).hotkey().to_string();
        v_flex()
            .track_focus(&self.focus)
            .on_key_down(cx.listener(|this, e: &KeyDownEvent, _, cx| this.on_key(e, cx)))
            .gap_2()
            .child(div().text_sm().font_weight(FontWeight::MEDIUM).text_color(theme::text_soft()).child("Toggle Overlay Interactive Mode"))
            .child(
                h_flex()
                    .gap_3()
                    .child(
                        div()
                            .min_w(px(160.))
                            .px_3()
                            .py_1p5()
                            .rounded_md()
                            .bg(theme::primary())
                            .border_1()
                            .border_color(if self.recording { theme::accent() } else { theme::border() })
                            .child(key_chips(&hotkey)),
                    )
                    .child(
                        ui::button("hk-change", if self.recording { "Press keys..." } else { "Change Hotkey" }, true)
                            .on_click(cx.listener(|this, _, window, cx| this.start(window, cx))),
                    )
                    .child(ui::button("hk-reset", "Reset to Default", false).on_click(cx.listener(|this, _, _, cx| {
                        this.recording = false;
                        this.save(DEFAULT_HOTKEY.into(), cx);
                    }))),
            )
            .child(div().text_xs().text_color(rgb(0x6b7280)).child(
                "Press the hotkey to toggle the overlay (show/hide) while CS2 is running. Default: Ctrl+Shift+O",
            ))
            .when(self.recording, |d| {
                d.child(div().text_xs().text_color(theme::accent()).child("Recording... Press your desired key combination now."))
            })
            .when_some(self.message.clone(), |d, (msg, err)| {
                d.child(div().text_xs().text_color(if err { rgb(0xf87171) } else { rgb(0x4ade80) }).child(msg))
            })
    }
}

#[cfg(test)]
mod tests {
    use super::accelerator;
    use gpui_kit::Keystroke;

    #[test]
    fn records_like_electron() {
        let k = Keystroke::parse("ctrl-shift-o").unwrap();
        assert_eq!(accelerator(&k).as_deref(), Some("Control+Shift+O"));
        let k = Keystroke::parse("alt-f9").unwrap();
        assert_eq!(accelerator(&k).as_deref(), Some("Alt+F9"));
        let k = Keystroke::parse("ctrl-up").unwrap();
        assert_eq!(accelerator(&k).as_deref(), Some("Control+Up"));
    }
}
