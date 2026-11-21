//! Parsing demos in-process with the extractor library (`extractor/`, crate
//! `cs2_extractor`) — the same code the Electron app runs as `parser.exe` — on a
//! background thread, with Electron's `parser:parse` bookkeeping when it finishes
//! (parser logs stored in the match database, stats, map count, match limit).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use anyhow::{Result, bail};
use cs2_extractor::{Args, Cancelled, Reporter};

use crate::settings::Settings;
use crate::stats::Stats;
use crate::{matches, paths};

#[derive(Debug, Clone)]
pub enum ParseEvent {
    Progress { stage: String, round: i64, tick: i64, pct: f64 },
    Log { level: String, msg: String },
    /// The parse failed with this message (the CLI's `{"type":"error"}` line).
    Error(String),
    /// Parsing finished and bookkeeping is done.
    Done { success: bool, error: Option<String> },
}

/// A running parse. Drop does not stop it; call [`ParseJob::stop`].
pub struct ParseJob {
    pub match_id: String,
    pub demo_path: PathBuf,
    pub db_path: PathBuf,
    pub events: Receiver<ParseEvent>,
    cancel: Arc<AtomicBool>,
}

impl ParseJob {
    /// Stop the parse; its incomplete database is deleted (Electron's "Abort & Delete").
    pub fn stop(&self) {
        self.cancel.store(true, Ordering::Relaxed);
    }
}

/// Match ID for a demo: its file name without extension.
pub fn match_id_for(demo: &Path) -> String {
    demo.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
}

/// Forwards the extractor's log/progress to the UI and keeps the lines Electron stores
/// in `parser_logs` (same `[LEVEL] msg` / `[PROGRESS] …` format as its stdout handler).
struct Forward {
    tx: Mutex<Sender<ParseEvent>>,
    logs: Mutex<Vec<String>>,
    cancel: Arc<AtomicBool>,
}

impl Reporter for Forward {
    fn log(&self, level: &str, msg: &str) {
        self.logs.lock().unwrap().push(format!("[{}] {msg}", level.to_uppercase()));
        let _ = self.tx.lock().unwrap().send(ParseEvent::Log { level: level.into(), msg: msg.into() });
    }

    fn progress(&self, stage: &str, tick: i32, round: i32, pct: f64) {
        self.logs
            .lock()
            .unwrap()
            .push(format!("[PROGRESS] {stage}: {:.1}% (round {round}, tick {tick})", pct * 100.0));
        let _ = self.tx.lock().unwrap().send(ParseEvent::Progress {
            stage: stage.into(),
            round: round.into(),
            tick: tick.into(),
            pct,
        });
    }

    fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }
}

/// Start parsing `demo` into `matches/<id>.sqlite`, replacing any earlier parse.
pub fn start(demo: &Path) -> Result<ParseJob> {
    if !demo.exists() {
        bail!("Demo not found: {}", demo.display());
    }
    let settings = Settings::open().ok();
    let get = |k: &str, d: &str| settings.as_ref().map_or(d.to_string(), |s| s.get_or(k, d));
    let position_interval: i32 = get("position_extraction_interval", "4").parse().unwrap_or(4);
    let cap = (get("match_cap_enabled", "false") == "true")
        .then(|| get("match_cap_value", "10").parse::<usize>().ok())
        .flatten()
        .filter(|c| *c > 0);

    let match_id = match_id_for(demo);
    std::fs::create_dir_all(paths::matches_dir())?;
    let db_path = paths::match_db(&match_id);
    // Reparse: start from a fresh database.
    let _ = std::fs::remove_file(&db_path);

    let (tx, rx) = channel();
    let cancel = Arc::new(AtomicBool::new(false));
    let reporter = Arc::new(Forward { tx: Mutex::new(tx.clone()), logs: Mutex::new(Vec::new()), cancel: cancel.clone() });
    let args = Args::database(&demo.to_string_lossy(), &db_path.to_string_lossy(), &match_id, position_interval);
    let demo_size = std::fs::metadata(demo).map_or(0, |m| m.len() as i64);
    let (id, db) = (match_id.clone(), db_path.clone());

    std::thread::Builder::new().name(format!("parse {match_id}")).spawn(move || {
        let started = Instant::now();
        let r: Arc<dyn Reporter> = reporter.clone();
        // The extractor turns decoder panics into errors itself; this also covers its own code.
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| cs2_extractor::run_database(&args, r)))
            .unwrap_or_else(|_| Err(anyhow::anyhow!("parser crashed during parsing")));
        let stopped = reporter.cancel.load(Ordering::Relaxed)
            || result.as_ref().err().is_some_and(|e| e.downcast_ref::<Cancelled>().is_some());
        if stopped {
            let _ = std::fs::remove_file(&db);
            let _ = tx.send(ParseEvent::Done { success: false, error: Some("Parser stopped by user".into()) });
            return;
        }
        if let Err(e) = &result {
            let msg = format!("{e:#}");
            reporter.logs.lock().unwrap().push(format!("[ERROR] {msg}"));
            let _ = tx.send(ParseEvent::Error(msg));
        }
        let success = result.is_ok();
        let logs = std::mem::take(&mut *reporter.logs.lock().unwrap());
        let error = (!success).then(|| logs.last().cloned().unwrap_or_else(|| "Parser failed".into()));
        finish(&id, &db, &logs, success, demo_size, started.elapsed().as_millis() as i64, cap);
        let _ = tx.send(ParseEvent::Done { success, error });
    })?;

    Ok(ParseJob { match_id, demo_path: demo.to_path_buf(), db_path, events: rx, cancel })
}

/// Electron's exit bookkeeping.
#[allow(clippy::too_many_arguments)]
fn finish(
    match_id: &str,
    db: &Path,
    logs: &[String],
    success: bool,
    demo_size: i64,
    parse_ms: i64,
    cap: Option<usize>,
) {
    if !logs.is_empty() && db.exists() {
        if let Ok(conn) = rusqlite::Connection::open(db) {
            let _ = conn.execute(
                "INSERT OR REPLACE INTO parser_logs (match_id, logs, created_at) VALUES (?1, ?2, ?3)",
                rusqlite::params![match_id, logs.join("\n"), now_iso()],
            );
        }
    }
    if !success {
        return;
    }
    if let Ok(stats) = Stats::open() {
        let _ = stats.track_demo_parsed(demo_size, parse_ms);
        if let Ok(conn) = matches::open_match(db) {
            if let Ok(map) = conn.query_row("SELECT map FROM matches WHERE id = ?1", [match_id], |r| r.get::<_, String>(0)) {
                let _ = stats.increment_map_parse_count(&map);
            }
        }
    }
    if let Some(cap) = cap {
        let _ = matches::trim_to_cap(cap);
    }
}

/// UTC timestamp like JavaScript's `toISOString()`.
fn now_iso() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64);
    let (ms, s) = (secs % 1000, secs / 1000);
    let (days, rem) = (s.div_euclid(86_400), s.rem_euclid(86_400));
    // Civil-from-days (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{ms:03}Z", rem / 3600, (rem / 60) % 60, rem % 60)
}

// ---------- unparsed demos ----------

#[derive(Debug, Clone)]
pub struct UnparsedDemo {
    pub file_name: String,
    pub file_path: PathBuf,
    pub file_size: u64,
    /// Seconds since the Unix epoch (file creation time).
    pub created: u64,
}

/// `.dem` files in the watched demo folders that no match database points at
/// (Electron `demos:getUnparsed`).
pub fn unparsed_demos() -> Vec<UnparsedDemo> {
    let parsed: std::collections::HashSet<String> = std::fs::read_dir(paths::matches_dir())
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "sqlite"))
        .filter_map(|p| {
            let conn = matches::open_match(&p).ok()?;
            conn.query_row("SELECT value FROM meta WHERE key = 'demo_path'", [], |r| r.get::<_, String>(0)).ok()
        })
        .map(|p| normalize(&p))
        .collect();

    let folders = Settings::open().map(|s| s.demo_folders()).unwrap_or_default();
    let mut out = Vec::new();
    for folder in folders.iter().map(PathBuf::from).filter(|f| f.is_dir()) {
        let Ok(entries) = std::fs::read_dir(&folder) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.extension().is_some_and(|e| e.eq_ignore_ascii_case("dem")) {
                continue;
            }
            if parsed.contains(&normalize(&path.to_string_lossy())) {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            let created = meta
                .created()
                .or_else(|_| meta.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_secs());
            out.push(UnparsedDemo {
                file_name: entry.file_name().to_string_lossy().into_owned(),
                file_path: path,
                file_size: meta.len(),
                created,
            });
        }
    }
    out
}

/// Windows paths compare case-insensitively and with either slash.
fn normalize(p: &str) -> String {
    if cfg!(windows) { p.replace('/', "\\").to_lowercase() } else { p.to_string() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logs_like_electrons_stdout_handler() {
        let (tx, rx) = channel();
        let f = Forward { tx: Mutex::new(tx), logs: Mutex::new(Vec::new()), cancel: Arc::new(AtomicBool::new(false)) };
        f.progress("parsing", 1200, 3, 0.25);
        f.log("info", "hello");
        assert!(matches!(rx.try_recv().unwrap(), ParseEvent::Progress { round: 3, .. }));
        assert_eq!(
            *f.logs.lock().unwrap(),
            vec!["[PROGRESS] parsing: 25.0% (round 3, tick 1200)".to_string(), "[INFO] hello".into()]
        );
    }

    #[test]
    fn iso_timestamp_shape() {
        let s = now_iso();
        assert_eq!(s.len(), 24);
        assert!(s.ends_with('Z') && s.as_bytes()[10] == b'T');
    }
}

/// End-to-end: `CS2DA_TEST_DEMO=<path.dem> CS2DA_DATA_DIR=<scratch dir> cargo test -p cs2da-core real_parse -- --ignored --nocapture`
#[cfg(test)]
#[test]
#[ignore]
fn real_parse() {
    let demo = PathBuf::from(std::env::var("CS2DA_TEST_DEMO").expect("CS2DA_TEST_DEMO"));
    let t0 = std::time::Instant::now();
    let job = start(&demo).unwrap();
    let mut last_pct = -1.0;
    for ev in job.events.iter() {
        match ev {
            ParseEvent::Progress { pct, round, .. } if pct - last_pct >= 0.2 => {
                println!("progress {:.0}% round {round}", pct * 100.0);
                last_pct = pct;
            }
            ParseEvent::Done { success, error } => {
                println!("done success={success} error={error:?} after {} ms", t0.elapsed().as_millis());
                assert!(success);
                break;
            }
            _ => {}
        }
    }
    let s = crate::matches::match_summary(&job.match_id).unwrap();
    println!("parsed {}: {} players, {} rounds", s.info.map, s.players.len(), s.rounds.len());
    let conn = crate::matches::open_match(&job.db_path).unwrap();
    let logs: String = conn.query_row("SELECT logs FROM parser_logs", [], |r| r.get(0)).unwrap();
    assert!(logs.contains("[PROGRESS]"));
}

/// Stopping a running parse cancels it and removes the incomplete database.
#[cfg(test)]
#[test]
#[ignore]
fn real_stop() {
    let demo = PathBuf::from(std::env::var("CS2DA_TEST_DEMO").expect("CS2DA_TEST_DEMO"));
    let job = start(&demo).unwrap();
    // Let it get going, then abort.
    let _ = job.events.recv();
    job.stop();
    let done = job.events.iter().find_map(|e| match e {
        ParseEvent::Done { success, error } => Some((success, error)),
        _ => None,
    });
    println!("done: {done:?}");
    assert_eq!(done, Some((false, Some("Parser stopped by user".into()))));
    assert!(!job.db_path.exists());
}
