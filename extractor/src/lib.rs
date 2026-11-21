//! CS2 demo extractor: parses a demo and writes the match database the analyzer app
//! reads. Used in-process by the native app and through the `parser` CLI (src/main.rs)
//! by the Electron app; both report through a [`Reporter`].

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
use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;
use util::J;

/// Where a parse reports to: the CLI prints NDJSON, the native app forwards to its UI.
pub trait Reporter: Send + Sync {
    fn log(&self, level: &str, msg: &str);
    fn progress(&self, stage: &str, tick: i32, round: i32, pct: f64);
    /// Polled while parsing; returning true stops the parse with a [`Cancelled`] error.
    fn cancelled(&self) -> bool {
        false
    }
}

/// The error a parse returns when its [`Reporter`] asked it to stop.
#[derive(Debug)]
pub struct Cancelled;

impl std::fmt::Display for Cancelled {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("parse cancelled")
    }
}

impl std::error::Error for Cancelled {}

/// The NDJSON lines the CLI prints (`{"type":"log"|"progress"|"error",...}`).
pub fn ndjson_log(level: &str, msg: &str) -> String {
    let mut o = J::obj();
    o.insert("type".into(), J::S("log".into()));
    o.insert("level".into(), J::S(level.into()));
    o.insert("msg".into(), J::S(msg.into()));
    J::O(o).encode()
}

pub fn ndjson_progress(stage: &str, tick: i32, round: i32, pct: f64) -> String {
    let mut o = J::obj();
    o.insert("type".into(), J::S("progress".into()));
    o.insert("stage".into(), J::S(stage.into()));
    o.insert("tick".into(), J::Int(tick as i64));
    o.insert("round".into(), J::Int(round as i64));
    o.insert("pct".into(), J::F(pct));
    J::O(o).encode()
}

pub fn ndjson_error(msg: &str) -> String {
    let mut o = J::obj();
    o.insert("type".into(), J::S("error".into()));
    o.insert("msg".into(), J::S(msg.into()));
    J::O(o).encode()
}

/// What to parse and where to put it (the CLI's flags).
#[derive(Default)]
pub struct Args {
    pub demo: String,
    pub out: String,
    pub output: String,
    pub mode: String,
    pub steam_ids: String,
    pub match_id: String,
    pub position_interval: i32,
    pub legacy_shots: bool,
    /// Entity-decoding threads; 1 = the original sequential parse. 0 = one per core.
    pub threads: usize,
}

impl Args {
    /// A database parse with the CLI's defaults.
    pub fn database(demo: &str, out: &str, match_id: &str, position_interval: i32) -> Args {
        Args {
            demo: demo.into(),
            out: out.into(),
            mode: "database".into(),
            match_id: match_id.into(),
            position_interval,
            ..Default::default()
        }
    }
}

fn parse_demo(
    r: &Arc<dyn Reporter>,
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
    r.log("info", "Creating parser...");
    let bytes = std::fs::read(path).map_err(|e| anyhow!("failed to open demo file: {}", e))?;
    r.log("info", &format!("Parsing demo with position interval: {}", args.position_interval));
    r.progress("parsing", 0, 0, 0.0);

    let mut parser = Parser::new(&bytes).map_err(|e| anyhow!("failed to parse demo: {}", e))?;
    let observer = parser.add_observer(Extractor::new(
        Options {
            position_interval: args.position_interval,
            events_only,
            steam_ids,
            legacy_shots: args.legacy_shots,
        },
        Some({
            let r = r.clone();
            // Progress is reported often; it is also where a cancel request stops the parse.
            Box::new(move |stage: &str, tick: i32, round: i32, pct: f64| {
                if r.cancelled() {
                    std::panic::resume_unwind(Box::new(Cancelled));
                }
                r.progress(stage, tick, round, pct);
            })
        }),
        sink,
    ));
    // A damaged demo can trip an assertion deep inside the parsing library;
    // report that as a failed parse instead of dying without a message.
    // Entity messages are decoded on worker threads and applied in order on this one,
    // so the result is the same as a sequential parse (`--threads 1`).
    let threads = match args.threads {
        // Applying decoded entities on the main thread is the limit beyond ~2-3 workers.
        0 => std::thread::available_parallelism().map_or(1, |n| n.get()).min(3),
        n => n,
    };
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        if threads > 1 { parser.run_to_end_parallel(threads) } else { parser.run_to_end() }
    }));
    match outcome {
        Ok(result) => result.map_err(|e| anyhow!("failed to parse demo: {}", e))?,
        Err(payload) if payload.is::<Cancelled>() => return Err(anyhow::Error::new(Cancelled)),
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

pub fn run_database(args: &Args, r: Arc<dyn Reporter>) -> Result<()> {
    let r = &r;
    r.log("info", &format!("Starting parser for demo: {}", args.demo));
    r.log("info", &format!("Output database: {}", args.out));
    r.log("info", &format!("Match ID: {}", args.match_id));

    r.log("info", "Opening database...");
    let writer = db::Writer::start(&args.out, &args.match_id);
    let mut data = match parse_demo(r, args, None, false, Some(writer.sender())) {
        Ok(d) => d,
        Err(e) => {
            writer.abort();
            return Err(e);
        }
    };
    r.log(
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
            r.log("warn", &format!("Player {} ({}) has no team assigned!", p.steamid, p.name));
        } else {
            r.log("info", &format!("Player {} ({}) assigned to team {}", p.steamid, p.name, p.team));
        }
    }

    post::dedup_positions(&mut data.positions);
    r.log("info", "Processing AFK detection...");
    let afk = post::detect_afk(&data);
    if !afk.is_empty() {
        r.log("info", &format!("Found {} AFK events", afk.len()));
    }
    r.log("info", "Processing body blocking detection...");
    let body = post::detect_body_block(&data);
    if !body.is_empty() {
        r.log("info", &format!("Found {} body blocking events", body.len()));
    }
    data.events.extend(afk);
    data.events.extend(body);

    r.log("info", "Computing player scores...");
    let scores = post::compute_scores(&data.events);

    r.log("info", "Writing database...");
    let rounds = data.rounds.len() as i32;
    r.progress("writing_database", 0, rounds, 0.9);
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
    r.log("info", &summary);
    r.log("info", "Parsing complete!");
    r.progress("complete", 0, rounds, 1.0);
    Ok(())
}

pub fn run_json(args: &Args, r: Arc<dyn Reporter>) -> Result<()> {
    let r = &r;
    r.log("info", &format!("Starting parser for demo: {}", args.demo));
    r.log("info", &format!("Output JSON: {}", args.output));
    r.log("info", &format!("Match ID: {}", args.match_id));
    let ids: HashSet<String> = args
        .steam_ids
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    let filter = if ids.is_empty() { None } else { Some(ids) };
    if let Some(f) = &filter {
        r.log("info", &format!("Filtering by {} Steam ID(s)", f.len()));
    }
    let data = parse_demo(r, args, filter.clone(), true, None)?;
    r.log("info", &format!("Parsed {} rounds, {} players", data.rounds.len(), data.players.len()));

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
    r.log("info", "Parsing complete!");
    r.progress("complete", 0, data.rounds.len() as i32, 1.0);
    Ok(())
}
