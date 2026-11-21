//! `parser` CLI over the extractor library: command line and stdout protocol match the
//! Go parser it replaced (the Electron app runs this).

use anyhow::{anyhow, bail, Context as _, Result};
use cs2_extractor::{ndjson_error, ndjson_log, ndjson_progress, run_database, run_json, Args, Reporter};
use std::path::Path;
use std::sync::Arc;

/// Prints NDJSON to stdout, one object per line.
struct Stdout;

impl Reporter for Stdout {
    fn log(&self, level: &str, msg: &str) {
        println!("{}", ndjson_log(level, msg));
    }
    fn progress(&self, stage: &str, tick: i32, round: i32, pct: f64) {
        println!("{}", ndjson_progress(stage, tick, round, pct));
    }
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
            "threads" => a.threads = v.parse().context("invalid --threads")?,
            // Accepted for compatibility; nothing needs limiting any more.
            "memory-limit" => {}
            _ => bail!("flag provided but not defined: -{}", name),
        }
        i += 1;
    }
    Ok(a)
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

    let r: Arc<dyn Reporter> = Arc::new(Stdout);
    let result = if args.mode == "json" { run_json(&args, r) } else { run_database(&args, r) };
    if let Err(e) = result {
        println!("{}", ndjson_error(&format!("{:#}", e)));
        std::process::exit(1);
    }
}
