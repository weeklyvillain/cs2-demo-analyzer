//! English/Swedish strings, extracted from the Electron app's `src/utils/translations.ts`
//! into `translations.json`. `t(key)` falls back to English, then to the key itself.

use std::collections::HashMap;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};

type Table = HashMap<String, HashMap<String, String>>;

static TABLE: OnceLock<Table> = OnceLock::new();
static SWEDISH: AtomicBool = AtomicBool::new(false);

fn table() -> &'static Table {
    TABLE.get_or_init(|| serde_json::from_str(include_str!("translations.json")).unwrap_or_default())
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Language {
    En,
    Sv,
}

impl Language {
    pub fn code(self) -> &'static str {
        match self {
            Language::En => "en",
            Language::Sv => "sv",
        }
    }
    pub fn from_code(code: &str) -> Self {
        if code == "sv" { Language::Sv } else { Language::En }
    }
}

pub fn language() -> Language {
    if SWEDISH.load(Ordering::Relaxed) { Language::Sv } else { Language::En }
}

pub fn set_language(lang: Language) {
    SWEDISH.store(lang == Language::Sv, Ordering::Relaxed);
}

pub fn t(key: &str) -> String {
    let table = table();
    table
        .get(language().code())
        .and_then(|m| m.get(key))
        .or_else(|| table.get("en").and_then(|m| m.get(key)))
        .cloned()
        .unwrap_or_else(|| key.to_string())
}

/// `t(key)` with `{name}`-style placeholders filled in.
pub fn tf(key: &str, args: &[(&str, &str)]) -> String {
    args.iter()
        .fold(t(key), |s, (k, v)| s.replace(&format!("{{{k}}}"), v))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn looks_up_both_languages() {
        assert_eq!(t("matches.sections.teamKills"), "Team Kills");
        set_language(Language::Sv);
        assert_eq!(t("matches.sections.teamKills"), "Lagmord");
        set_language(Language::En);
        assert_eq!(t("no.such.key"), "no.such.key");
    }
}

/// Plural ending for "match": `es` in English, `er` in Swedish (Electron hard-coded one of
/// them per string, so one language always read wrong).
pub fn match_plural(count: usize) -> &'static str {
    match (count > 1, language()) {
        (false, _) => "",
        (true, Language::En) => "es",
        (true, Language::Sv) => "er",
    }
}
