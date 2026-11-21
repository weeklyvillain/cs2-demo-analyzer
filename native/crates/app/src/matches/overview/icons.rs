//! Icons the Overview uses that aren't in gpui-kit's default icon set.
//! Lucide icons (ISC license) plus the Electron app's dollar and body-block icons.
//! GPUI draws SVGs in one color (the text color), so the two custom icons get a
//! fixed tint instead of their original multi-color fills.

use gpui_kit::component::Icon;
use gpui_kit::*;

const CLOCK: &[u8] = br##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>"##;
const SKULL: &[u8] = br##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12.5 17-.5-1-.5 1h1z"/><path d="M15 22a1 1 0 0 0 1-1v-1a2 2 0 0 0 1.56-3.25 8 8 0 1 0-11.12 0A2 2 0 0 0 8 20v1a1 1 0 0 0 1 1z"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="12" r="1"/></svg>"##;
const ZAP: &[u8] = br##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15.914 4a1.5 1.5 0 00-2.474-1.561l-9 9A1.5 1.5 0 005.5 14h4.002a.5.5 0 01.471.666L8.086 20a1.5 1.5 0 002.475 1.56l9-9A1.5 1.5 0 0018.5 10h-3.997a.5.5 0 01-.472-.667z"/></svg>"##;
const WIFI_OFF: &[u8] = br##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h.01"/><path d="M8.5 16.429a5 5 0 0 1 7 0"/><path d="M5 12.859a10 10 0 0 1 5.17-2.69"/><path d="M19 12.859a10 10 0 0 0-2.007-1.523"/><path d="M2 8.82a15 15 0 0 1 4.177-2.643"/><path d="M22 8.82a15 15 0 0 0-11.288-3.764"/><path d="m2 2 20 20"/></svg>"##;
// Lucide circle-dollar-sign: a one-color stand-in for Electron's gold coin icon.
const DOLLAR: &[u8] = br##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><path d="M12 18V6"/></svg>"##;
const BODY_BLOCK: &[u8] = br##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" fill="currentColor"><circle cx="42" cy="34" r="10"/><rect x="30" y="48" width="24" height="48" rx="7"/><circle cx="86" cy="34" r="10"/><rect x="74" y="48" width="24" height="48" rx="7"/><rect x="56" y="68" width="16" height="8" rx="4"/></svg>"##;

fn icon(data: &[u8]) -> Icon {
    Icon::default().data(data).size_4()
}

pub fn clock() -> AnyElement {
    icon(CLOCK).into_any_element()
}
pub fn skull() -> AnyElement {
    icon(SKULL).into_any_element()
}
pub fn zap() -> AnyElement {
    icon(ZAP).into_any_element()
}
pub fn wifi_off() -> AnyElement {
    icon(WIFI_OFF).into_any_element()
}
pub fn dollar() -> AnyElement {
    icon(DOLLAR).text_color(rgb(0xf4c430)).into_any_element()
}
pub fn body_block() -> AnyElement {
    icon(BODY_BLOCK).text_color(rgb(0xff9800)).into_any_element()
}
