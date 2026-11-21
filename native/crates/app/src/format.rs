//! Small display helpers shared by screens.

/// `de_mirage` -> `Mirage`, `cs_office` -> `Office`; anything else unchanged.
pub fn map_name(map: &str) -> String {
    let base = map
        .strip_prefix("de_")
        .or_else(|| map.strip_prefix("cs_"))
        .or_else(|| map.strip_prefix("ar_"))
        .unwrap_or(map);
    let mut chars = base.chars();
    match chars.next() {
        Some(c) => c.to_uppercase().chain(chars).collect(),
        None => map.to_string(),
    }
}

/// `2026-11-17T16:30:31+01:00` -> `2026-11-17 16:30`.
pub fn short_date(iso: &str) -> String {
    let s = iso.replace('T', " ");
    s.get(..16).unwrap_or(&s).to_string()
}

/// Ticks as `m:ss` (Electron `formatTime`).
pub fn clock(ticks: i64, tick_rate: f64) -> String {
    let secs = (ticks.max(0) as f64 / tick_rate) as u64;
    format!("{}:{:02}", secs / 60, secs % 60)
}

/// Display name for an event type, as in the Electron Rounds tab.
pub fn event_label(kind: &str) -> String {
    let key = match kind {
        "TEAM_KILL" => "matches.sections.teamKills",
        "TEAM_DAMAGE" => "matches.sections.teamDamage",
        "TEAM_FLASH" => "matches.sections.teamFlashes",
        "AFK_STILLNESS" => "matches.sections.afk",
        "DISCONNECT" => "matches.sections.disconnects",
        "ECONOMY_GRIEF" => return "Economy Griefing".into(),
        "BODY_BLOCK" => return "Body Blocking".into(),
        "KILL" => return "Kills".into(),
        other => return other.replace('_', " "),
    };
    crate::i18n::t(key)
}

/// Same as the Electron app's `formatDuration`: `45s`, `12m 5s`, `1h 3m`.
/// Rounds to whole seconds first, so 359.7 s is `6m 0s`, not `5m 60s`.
pub fn duration(secs: f64) -> String {
    let total = secs.max(0.0).round() as u64;
    let minutes = total / 60;
    if minutes == 0 {
        format!("{total}s")
    } else if minutes < 60 {
        format!("{minutes}m {}s", total % 60)
    } else {
        format!("{}h {}m", minutes / 60, minutes % 60)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats() {
        assert_eq!(map_name("de_mirage"), "Mirage");
        assert_eq!(map_name("kryos"), "Kryos");
        assert_eq!(short_date("2026-11-17T16:30:31+01:00"), "2026-11-17 16:30");

        assert_eq!(duration(359.7), "6m 0s");
        assert_eq!(duration(45.2), "45s");
        assert_eq!(duration(3725.0), "1h 2m");
    }
}
