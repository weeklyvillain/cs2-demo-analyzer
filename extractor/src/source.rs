//! Demo source detection (FACEIT, Valve matchmaking, ...) from the server and
//! file names.

use regex::Regex;

pub fn demo_source(server_name: &str, file_name: &str) -> String {
    let re = |p: &str| Regex::new(p).map(|r| r.is_match(file_name)).unwrap_or(false);
    let server = server_name.to_lowercase();
    let file = file_name.to_lowercase();

    let s = if server.contains("faceit")
        || server.contains("blast")
        || re(r"\d+_team[\da-z-]+-team[\da-z-]+_de_[\da-z]+\.dem")
    {
        "faceit"
    } else if server.contains("cevo") {
        "cevo"
    } else if server.contains("challengermode") || server.contains("pgl major cs2") {
        "challengermode"
    } else if server.contains("esl") {
        "esl"
    } else if server.contains("ebot") || re(r"(\d*)_(.*?)-(.*?)_(.*?)(\.dem)") {
        "ebot"
    } else if server.contains("esea") || file.contains("esea") {
        "esea"
    } else if server.contains("popflash") || file.contains("popflash") {
        "popflash"
    } else if server.contains("esportal") {
        "esportal"
    } else if server.contains("fastcup") {
        "fastcup"
    } else if server.contains("gamersclub") {
        "gamersclub"
    } else if file.contains("renown") || server.contains("renown") {
        "renown"
    } else if server.contains("matchzy")
        || re(r"^(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})_(\d+)_([a-zA-Z0-9_]+)_(.+?)_vs_(.+)$")
    {
        "matchzy"
    } else if server.contains("valve") {
        "valve"
    } else if server.contains("完美世界") {
        "perfectworld"
    } else if re(r"^g\d+-(.*)[a-zA-Z0-9_]*$") {
        "5eplay"
    } else if server.contains("esplay") {
        "esplay"
    } else if server_name.is_empty()
        && (re(r"^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}.*\.dem$")
            || file.contains("valve")
            || file.contains("matchmaking"))
    {
        "valve"
    } else {
        "unknown"
    };
    s.to_string()
}
