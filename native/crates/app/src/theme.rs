//! The app's palette: the same colors as the Electron app's `tailwind.config.js`,
//! so screens look the same while they're being ported.

use gpui_kit::component::scroll::ScrollbarMode;
use gpui_kit::component::{Theme, ThemeMode};
use gpui_kit::{App, Hsla, Rgba, rgb};

pub fn primary() -> Rgba { rgb(0x1e2124) } // window background
pub fn secondary() -> Rgba { rgb(0x282b30) } // sidebar, panels
pub fn surface() -> Rgba { rgb(0x36393e) } // hover / selected rows, cards
pub fn border() -> Rgba { rgb(0x424549) }
pub fn accent() -> Rgba { rgb(0xd07a2d) }
pub fn accent_light() -> Rgba { rgb(0xfb923c) } // tailwind orange-400
pub fn text() -> Rgba { rgb(0xffffff) }
pub fn text_muted() -> Rgba { rgb(0x9ca3af) } // gray-400
pub fn text_soft() -> Rgba { rgb(0xd1d5db) } // gray-300
pub fn team_ct() -> Rgba { rgb(0x60a5fa) }

fn h(c: Rgba) -> Hsla {
    c.into()
}

/// Dark mode plus our palette on top of gpui-kit's components.
pub fn apply(cx: &mut App) {
    Theme::change(ThemeMode::Dark, None, cx);
    let t = Theme::global_mut(cx);
    t.background = h(primary());
    t.foreground = h(text());
    t.border = h(border());
    t.muted = h(surface());
    t.muted_foreground = h(text_muted());
    t.primary = h(accent());
    t.primary_hover = h(accent_light());
    t.primary_active = h(accent());
    t.primary_foreground = h(text());
    t.secondary = h(surface());
    t.secondary_foreground = h(text());
    t.list_hover = h(surface());
    t.list_active = h(surface());
    t.list_active_border = h(accent());
    t.popover = h(secondary());
    t.ring = h(accent());
    t.title_bar = h(primary());
    t.title_bar_border = h(border());
    t.sidebar = h(secondary());
    t.sidebar_border = h(border());
    // Scrollbars stay visible wherever something scrolls (gpui-kit otherwise follows the
    // Windows auto-hide setting and only shows them on hover).
    t.scrollbar_mode = ScrollbarMode::Always;
    t.scrollbar_thumb = h(border());
    t.scrollbar_thumb_hover = h(text_muted());
    // Edits through global_mut reach the Base layer (scrollbars, resize handles) only here.
    Theme::sync_base(cx);
}

