//! Lucide icons (ISC license) the voice UI uses that aren't in gpui-kit's default set.

use gpui_kit::component::Icon;
use gpui_kit::*;

const VOLUME_2: &[u8] = br##"<svg  xmlns="http://www.w3.org/2000/svg"  width="24"  height="24"  viewBox="0 0 24 24"  fill="none"  stroke="currentColor"  stroke-width="2"  stroke-linecap="round"  stroke-linejoin="round">  <path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z" />  <path d="M16 9a5 5 0 0 1 0 6" />  <path d="M19.364 18.364a9 9 0 0 0 0-12.728" /></svg>"##;
const VOLUME_X: &[u8] = br##"<svg  xmlns="http://www.w3.org/2000/svg"  width="24"  height="24"  viewBox="0 0 24 24"  fill="none"  stroke="currentColor"  stroke-width="2"  stroke-linecap="round"  stroke-linejoin="round">  <path d="M11 4.702a.7.7 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.7.7 0 0 0 11 19.298z" />  <path d="m16.5 14.5 5-5" />  <path d="m16.5 9.5 5 5" /></svg>"##;
const GAUGE: &[u8] = br##"<svg  xmlns="http://www.w3.org/2000/svg"  width="24"  height="24"  viewBox="0 0 24 24"  fill="none"  stroke="currentColor"  stroke-width="2"  stroke-linecap="round"  stroke-linejoin="round">  <path d="m12 14 4-4" />  <path d="M3.34 19a10 10 0 1 1 17.32 0" /></svg>"##;
const USER_PLUS: &[u8] = br##"<svg  xmlns="http://www.w3.org/2000/svg"  width="24"  height="24"  viewBox="0 0 24 24"  fill="none"  stroke="currentColor"  stroke-width="2"  stroke-linecap="round"  stroke-linejoin="round">  <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />  <circle cx="9" cy="7" r="4" />  <line x1="19" x2="19" y1="8" y2="14" />  <line x1="22" x2="16" y1="11" y2="11" /></svg>"##;
const USER_MINUS: &[u8] = br##"<svg  xmlns="http://www.w3.org/2000/svg"  width="24"  height="24"  viewBox="0 0 24 24"  fill="none"  stroke="currentColor"  stroke-width="2"  stroke-linecap="round"  stroke-linejoin="round">  <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />  <circle cx="9" cy="7" r="4" />  <line x1="22" x2="16" y1="11" y2="11" /></svg>"##;

fn icon(data: &[u8]) -> AnyElement {
    Icon::default().data(data).size_4().into_any_element()
}
pub fn volume_2() -> AnyElement {
    icon(VOLUME_2)
}
pub fn volume_x() -> AnyElement {
    icon(VOLUME_X)
}
pub fn gauge() -> AnyElement {
    icon(GAUGE)
}
pub fn user_plus() -> AnyElement {
    icon(USER_PLUS)
}
pub fn user_minus() -> AnyElement {
    icon(USER_MINUS)
}
