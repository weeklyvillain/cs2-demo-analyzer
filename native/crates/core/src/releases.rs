//! GitHub release lookups (Electron `getReleaseNotes`, `getAvailableVersions`,
//! `checkForUpdates`) and the "What's New" version bookkeeping. Blocking; call off the
//! UI thread. Requests carry no user data, only Electron's generic User-Agent.

use std::cmp::Ordering;
use std::time::Duration;

use serde_json::Value;

const REPO: &str = "weeklyvillain/cs2-demo-analyzer";

fn get(url: &str) -> Option<Value> {
    let agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(10)))
        .build()
        .new_agent();
    agent
        .get(url)
        .header("Accept", "application/vnd.github.v3+json")
        .header("User-Agent", "CS2-Demo-Analyzer")
        .call()
        .ok()?
        .body_mut()
        .read_json()
        .ok()
}

pub struct ReleaseNotes {
    pub title: String,
    pub body: String,
}

/// Notes for `version`, trying the `v1.2.3` tag then `1.2.3`.
pub fn release_notes(version: &str) -> Option<ReleaseNotes> {
    let v = version.trim_start_matches('v');
    [format!("v{v}"), v.to_string()].iter().find_map(|tag| {
        let r = get(&format!("https://api.github.com/repos/{REPO}/releases/tags/{tag}"))?;
        Some(ReleaseNotes {
            title: r["name"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map_or_else(|| format!("What's New in Version {v}"), str::to_string),
            body: r["body"].as_str().unwrap_or("").to_string(),
        })
    })
}

/// Every released version, newest first as GitHub lists them.
pub fn available_versions() -> Vec<String> {
    get(&format!("https://api.github.com/repos/{REPO}/releases"))
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(|r| r["tag_name"].as_str().map(|t| t.trim_start_matches('v').to_string()))
        .collect()
}

/// The latest release's version, if it is newer than `current`.
pub fn newer_release(current: &str) -> Option<String> {
    let latest = get(&format!("https://api.github.com/repos/{REPO}/releases/latest"))?;
    let tag = latest["tag_name"].as_str()?.trim_start_matches('v').to_string();
    (compare_versions(&tag, current) == Ordering::Greater).then_some(tag)
}

/// Electron's `compareVersions`: numeric, dot by dot, missing parts are 0.
pub fn compare_versions(a: &str, b: &str) -> Ordering {
    let parts = |s: &str| s.split('.').map(|p| p.parse::<u64>().unwrap_or(0)).collect::<Vec<_>>();
    let (a, b) = (parts(a), parts(b));
    (0..a.len().max(b.len()))
        .map(|i| a.get(i).unwrap_or(&0).cmp(b.get(i).unwrap_or(&0)))
        .find(|o| o.is_ne())
        .unwrap_or(Ordering::Equal)
}

/// Electron `app:shouldShowWhatsNew`: first run records the version and shows nothing;
/// afterwards, show when this version is newer than the last one seen.
pub fn should_show_whats_new(current: &str) -> bool {
    let Ok(settings) = crate::settings::Settings::open() else { return false };
    let last = settings.get_or("last_seen_version", "");
    if last.is_empty() {
        let _ = settings.set("last_seen_version", current);
        return false;
    }
    compare_versions(current, &last) == Ordering::Greater
}

pub fn mark_seen(version: &str) {
    if let Ok(s) = crate::settings::Settings::open() {
        let _ = s.set("last_seen_version", version);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_like_electron() {
        assert_eq!(compare_versions("1.0.72", "1.0.9"), Ordering::Greater);
        assert_eq!(compare_versions("2.0", "2.0.0"), Ordering::Equal);
        assert_eq!(compare_versions("1.0.71", "1.0.72"), Ordering::Less);
    }
}
