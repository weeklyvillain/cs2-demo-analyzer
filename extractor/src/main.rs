//! CS2 demo extractor: parses a demo and writes the match database the
//! analyzer app reads. Command line and stdout protocol match the Go parser
//! it replaces.

mod db;
mod equipment;
mod extract;
mod hull;
mod model;
mod post;
mod source;
mod state;
#[cfg(test)]
mod tests;
mod util;

use anyhow::{anyhow, bail, Context as _, Result};
use extract::{Extractor, Options};
use source2_demo::prelude::*;
use std::collections::{BTreeMap, HashSet};
use std::path::Path;
use util::J;

fn emit(obj: BTreeMap<String, J>) {
    println!("{}", J::O(obj).encode());
}

fn log(level: &str, msg: &str) {
    let mut o = J::obj();
    o.insert("type".into(), J::S("log".into()));
    o.insert("level".into(), J::S(level.into()));
    o.insert("msg".into(), J::S(msg.into()));
    emit(o);
}

fn progress(stage: &str, tick: i32, round: i32, pct: f64) {
    let mut o = J::obj();
    o.insert("type".into(), J::S("progress".into()));
    o.insert("stage".into(), J::S(stage.into()));
    o.insert("tick".into(), J::Int(tick as i64));
    o.insert("round".into(), J::Int(round as i64));
    o.insert("pct".into(), J::F(pct));
    emit(o);
}

#[derive(Default)]
struct Args {
    demo: String,
    out: String,
    output: String,
    mode: String,
    steam_ids: String,
    match_id: String,
    position_interval: i32,
    legacy_shots: bool,
}

/// Accepts `-flag value`, `--flag value` and `-flag=value`, like Go's `flag`.
fn parse_args() -> Result<Args> {
    let mut a = Args { mode: "database".into(), position_interval: 4, ..Default::default() };
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let mut i = 0;
    while i < argv.len() {
        let raw = argv[i].trim_start_matches('-');
        if raw.len() == argv[i].len() {
            bail!("unexpected argument: {}", argv[i]);
        }
        let (name, mut value) = match raw.split_once('=') {
            Some((n, v)) => (n.to_string(), Some(v.to_string())),
            None => (raw.to_string(), None),
        };
        if name == "legacy-shot-attribution" {
            a.legacy_shots = value.as_deref() != Some("false");
            i += 1;
            continue;
        }
        if value.is_none() {
            i += 1;
            value = argv.get(i).cloned();
        }
        let v = value.ok_or_else(|| anyhow!("flag needs an argument: -{}", name))?;
        match name.as_str() {
            "demo" => a.demo = v,
            "out" => a.out = v,
            "output" => a.output = v,
            "mode" => a.mode = v,
            "steam-ids" => a.steam_ids = v,
            "match-id" => a.match_id = v,
            "position-interval" => {
                a.position_interval = v.parse().context("invalid --position-interval")?
            }
            // Accepted for compatibility; nothing needs limiting any more.
            "memory-limit" => {}
            _ => bail!("flag provided but not defined: -{}", name),
        }
        i += 1;
    }
    Ok(a)
}

fn parse_demo(
    args: &Args,
    steam_ids: Option<HashSet<String>>,
    events_only: bool,
    sink: Option<extract::Sink>,
) -> Result<model::MatchData> {
    let path = Path::new(&args.demo);
    let meta = std::fs::metadata(path).map_err(|e| anyhow!("failed to access demo file: {}", e))?;
    if meta.len() == 0 {
        bail!("demo file is empty");
    }
    if !args.demo.to_lowercase().ends_with(".dem") {
        bail!("file does not have .dem extension");
    }
    log("info", "Creating parser...");
    let bytes = std::fs::read(path).map_err(|e| anyhow!("failed to open demo file: {}", e))?;
    log("info", &format!("Parsing demo with position interval: {}", args.position_interval));
    progress("parsing", 0, 0, 0.0);

    let mut parser = Parser::new(&bytes).map_err(|e| anyhow!("failed to parse demo: {}", e))?;
    let observer = parser.add_observer(Extractor::new(
        Options {
            position_interval: args.position_interval,
            events_only,
            steam_ids,
            legacy_shots: args.legacy_shots,
        },
        Some(Box::new(progress)),
        sink,
    ));
    // A damaged demo can trip an assertion deep inside the parsing library;
    // report that as a failed parse instead of dying without a message.
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| parser.run_to_end()));
    match outcome {
        Ok(result) => result.map_err(|e| anyhow!("failed to parse demo: {}", e))?,
        Err(_) => bail!(
            "parser crashed during parsing (demo may be corrupted, incomplete, or incompatible)"
        ),
    }
    drop(parser);
    let extractor = std::rc::Rc::try_unwrap(observer)
        .map_err(|_| anyhow!("parser still holds the extractor"))?
        .into_inner();
    let file_name = path.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default();
    Ok(extractor.finish(&file_name))
}

fn run_database(args: &Args) -> Result<()> {
    log("info", &format!("Starting parser for demo: {}", args.demo));
    log("info", &format!("Output database: {}", args.out));
    log("info", &format!("Match ID: {}", args.match_id));

    log("info", "Opening database...");
    let writer = db::Writer::start(&args.out, &args.match_id);
    let mut data = match parse_demo(args, None, false, Some(writer.sender())) {
        Ok(d) => d,
        Err(e) => {
            writer.abort();
            return Err(e);
        }
    };
    log(
        "info",
        &format!(
            "Parsed {} rounds, {} players, {} events",
            data.rounds.len(),
            data.players.len(),
            data.events.len()
        ),
    );
    for p in &data.players {
        if p.team.is_empty() {
            log("warn", &format!("Player {} ({}) has no team assigned!", p.steamid, p.name));
        } else {
            log("info", &format!("Player {} ({}) assigned to team {}", p.steamid, p.name, p.team));
        }
    }

    post::dedup_positions(&mut data.positions);
    log("info", "Processing AFK detection...");
    let afk = post::detect_afk(&data);
    if !afk.is_empty() {
        log("info", &format!("Found {} AFK events", afk.len()));
    }
    log("info", "Processing body blocking detection...");
    let body = post::detect_body_block(&data);
    if !body.is_empty() {
        log("info", &format!("Found {} body blocking events", body.len()));
    }
    data.events.extend(afk);
    data.events.extend(body);

    log("info", "Computing player scores...");
    let scores = post::compute_scores(&data.events);

    log("info", "Writing database...");
    let rounds = data.rounds.len() as i32;
    progress("writing_database", 0, rounds, 0.9);
    let summary = format!(
        "Stored {} events, {} player positions, {} grenade positions, {} shots",
        data.events.len(),
        data.positions.len(),
        data.grenade_position_count,
        data.shots.len()
    );
    // Positions were streamed to the writer during parsing already.
    data.positions = Vec::new();
    let created_at = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S%:z").to_string();
    writer
        .finish(db::Final { data, scores, demo_path: args.demo.clone(), created_at })
        .context("failed to write database")?;
    log("info", &summary);
    log("info", "Parsing complete!");
    progress("complete", 0, rounds, 1.0);
    Ok(())
}

fn run_json(args: &Args) -> Result<()> {
    log("info", &format!("Starting parser for demo: {}", args.demo));
    log("info", &format!("Output JSON: {}", args.output));
    log("info", &format!("Match ID: {}", args.match_id));
    let ids: HashSet<String> = args
        .steam_ids
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    let filter = if ids.is_empty() { None } else { Some(ids) };
    if let Some(f) = &filter {
        log("info", &format!("Filtering by {} Steam ID(s)", f.len()));
    }
    let data = parse_demo(args, filter.clone(), true, None)?;
    log("info", &format!("Parsed {} rounds, {} players", data.rounds.len(), data.players.len()));

    const ALLOWED: &[&str] = &[
        "TEAM_KILL",
        "TEAM_DAMAGE",
        "DISCONNECT",
        "RECONNECT",
        "AFK",
        "TEAM_FLASH",
        "ECONOMY_GRIEF",
        "BODY_BLOCK",
    ];
    let mut events: Vec<&model::Event> = data
        .events
        .iter()
        .filter(|e| ALLOWED.contains(&e.typ))
        .filter(|e| match &filter {
            None => true,
            Some(f) => {
                e.actor.as_ref().map_or(false, |a| f.contains(a))
                    || e.victim.as_ref().map_or(false, |v| f.contains(v))
            }
        })
        .collect();
    events.sort_by_key(|e| (e.round, e.start));

    let opt = |v: &Option<String>| v.clone().map_or(J::Null, J::S).encode();
    let mut out = String::new();
    if events.is_empty() {
        out.push_str("[]\n");
    } else {
        out.push_str("[\n");
        for (i, e) in events.iter().enumerate() {
            // Field order follows the Go struct this format came from.
            let mut line = format!(
                "  {{\"Type\":{},\"RoundIndex\":{},\"StartTick\":{},\"EndTick\":{},\"ActorSteamID\":{},\"VictimSteamID\":{}",
                J::S(e.typ.into()).encode(),
                e.round,
                e.start,
                e.end.map_or("null".to_string(), |t| t.to_string()),
                opt(&e.actor),
                opt(&e.victim),
            );
            if e.typ == "DISCONNECT" {
                let reason = e
                    .meta
                    .as_deref()
                    .and_then(|m| serde_json::from_str::<serde_json::Value>(m).ok())
                    .and_then(|v| v.get("reason").and_then(|r| r.as_str()).map(String::from))
                    .filter(|r| !r.is_empty());
                if let Some(r) = reason {
                    line.push_str(&format!(",\"Reason\":{}", J::S(r).encode()));
                }
            }
            line.push('}');
            if i + 1 < events.len() {
                line.push(',');
            }
            line.push('\n');
            out.push_str(&line);
        }
        out.push(']');
    }
    std::fs::write(&args.output, out).context("failed to write JSON output")?;
    log("info", "Parsing complete!");
    progress("complete", 0, data.rounds.len() as i32, 1.0);
    Ok(())
}

fn usage_error(msg: &str) -> ! {
    eprintln!("error: {}", msg);
    std::process::exit(1);
}

fn main() {
    let mut args = match parse_args() {
        Ok(a) => a,
        Err(e) => usage_error(&e.to_string()),
    };
    if args.demo.is_empty() {
        usage_error("--demo is required");
    }
    if args.mode != "json" && args.mode != "database" {
        usage_error("--mode must be 'json' or 'database'");
    }
    if args.mode == "json" && args.output.is_empty() {
        usage_error("--output is required when --mode=json");
    }
    if args.mode == "database" && args.out.is_empty() {
        usage_error("--out is required when --mode=database");
    }
    if args.match_id.is_empty() {
        args.match_id = Path::new(&args.demo)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
    }

    let result = if args.mode == "json" { run_json(&args) } else { run_database(&args) };
    if let Err(e) = result {
        let mut o = J::obj();
        o.insert("type".into(), J::S("error".into()));
        o.insert("msg".into(), J::S(format!("{:#}", e)));
        emit(o);
        std::process::exit(1);
    }
}
