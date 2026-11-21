//! Small building blocks shared by screens.

use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::theme;

pub fn centered_note(text: impl Into<SharedString>) -> Div {
    v_flex()
        .size_full()
        .py_8()
        .items_center()
        .justify_center()
        .text_sm()
        .text_color(theme::text_muted())
        .child(text.into())
}

/// A rounded, bordered button in the app's style. `primary` fills it with the accent color.
pub fn button(id: impl Into<ElementId>, label: impl Into<SharedString>, primary: bool) -> Stateful<Div> {
    h_flex()
        .id(id)
        .gap_1p5()
        .px_3()
        .py_1p5()
        .rounded_md()
        .text_sm()
        .font_weight(FontWeight::MEDIUM)
        .cursor_pointer()
        .when(primary, |d| d.bg(theme::accent()).text_color(theme::text()).hover(|s| s.bg(theme::accent_light())))
        .when(!primary, |d| {
            d.bg(theme::surface())
                .text_color(theme::text_soft())
                .border_1()
                .border_color(theme::border())
                .hover(|s| s.text_color(theme::text()).border_color(theme::accent()))
        })
        .child(label.into())
}

/// Small icon-only button that lights up on hover.
pub fn icon_button(id: impl Into<ElementId>, icon: impl IntoElement) -> Stateful<Div> {
    div()
        .id(id)
        .p_1()
        .rounded_sm()
        .cursor_pointer()
        .text_color(theme::text_muted())
        .hover(|s| s.bg(rgba(0xd07a2d33)).text_color(theme::accent()))
        .child(icon)
}

pub fn copy_to_clipboard(text: impl Into<String>, cx: &mut App) {
    cx.write_to_clipboard(ClipboardItem::new_string(text.into()));
}

/// Open the system file browser with `path` selected (Electron `shell.showItemInFolder`).
pub fn show_in_folder(path: &std::path::Path) {
    #[cfg(windows)]
    {
        let _ = std::process::Command::new("explorer").arg(format!("/select,{}", path.display())).spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg("-R").arg(path).spawn();
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if let Some(dir) = path.parent() {
            let _ = std::process::Command::new("xdg-open").arg(dir).spawn();
        }
    }
}
