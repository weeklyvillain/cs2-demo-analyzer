//! Watching demos in CS2 (Electron `cs2:launch`, `cs2:launchPOV`, `cs2:copyCommands`,
//! `playDemoInCS2`): build the same console command sequences, start CS2 with
//! `-insecure -novid -netconport <port>` when it isn't running, and drive it over netcon.
//!
//! The `start_*` functions return as soon as CS2 is started (or found running); the
//! timed command sequence then runs on a background thread, as Electron does with
//! `setTimeout`. `currentDemoPath` and the POV poll loop are process-wide, like in Electron.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Result, bail};

use crate::netcon;
use crate::settings::Settings;

/// Electron always assumes 64 tick when backing up 5 seconds before an event.
const PREVIEW_TICKS: i64 = 5 * 64;
/// Gap between commands in Electron's `sendCS2CommandsSequentially`.
const COMMAND_DELAY_MS: u64 = 500;

// ---------- command building (pure, unit-tested) ----------

/// `mat_setvideomode` comes from these settings (only sent when CS2 is launched by us).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowSettings {
    pub width: String,
    pub height: String,
    pub fullscreen: bool,
}

impl WindowSettings {
    pub fn load() -> Self {
        let s = Settings::open().ok();
        let get = |k: &str, d: &str| s.as_ref().map_or(d.to_string(), |s| s.get_or(k, d));
        WindowSettings {
            width: get("cs2_window_width", "1920"),
            height: get("cs2_window_height", "1080"),
            fullscreen: get("cs2_window_mode", "windowed") == "fullscreen",
        }
    }

    fn videomode(&self) -> String {
        format!("mat_setvideomode {} {} {}", self.width, self.height, if self.fullscreen { 1 } else { 0 })
    }
}

/// `spec_player` argument: quoted only when the name has a space (Electron).
pub fn quote_player(name: &str) -> String {
    if name.contains(' ') { format!("\"{name}\"") } else { name.to_string() }
}

/// Tick CS2 jumps to: 5 s (at 64 tick) before `start_tick`, or 0 when none is given.
pub fn target_tick(start_tick: Option<i64>) -> i64 {
    match start_tick {
        Some(t) if t != 0 => (t - PREVIEW_TICKS).max(0),
        _ => 0,
    }
}

/// `cs2:launch` sequence: playdemo, [mat_setvideomode], [demo_pause + demo_gototick], [spec_player].
pub fn watch_commands(demo: &Path, start_tick: Option<i64>, player: Option<&str>, cs2_running: bool, win: &WindowSettings) -> Vec<String> {
    let mut cmds = vec![format!("playdemo \"{}\"", demo.display())];
    if !cs2_running {
        cmds.push(win.videomode());
    }
    let tick = target_tick(start_tick);
    if tick > 0 {
        cmds.push("demo_pause".into());
        cmds.push(format!("demo_gototick {tick}"));
    }
    if let Some(p) = player.filter(|p| !p.is_empty()) {
        cmds.push(format!("spec_player {}", quote_player(p)));
    }
    cmds
}

/// `cs2:launchPOV` sequence: start of the first round, spectate, 2× speed, play.
pub fn pov_commands(demo: &Path, player: &str, first_round_start: i64, cs2_running: bool, win: &WindowSettings) -> Vec<String> {
    let mut cmds = vec![format!("playdemo \"{}\"", demo.display())];
    if !cs2_running {
        cmds.push(win.videomode());
    }
    cmds.push("demo_pause".into());
    cmds.push(format!("demo_gototick {first_round_start}"));
    cmds.push(format!("spec_player {}", quote_player(player)));
    cmds.push("demo_timescale 2".into());
    cmds.push("demo_resume".into());
    cmds
}

/// `cs2:copyCommands` sequence (for a CS2 that already has the demo open).
pub fn copy_commands(start_tick: Option<i64>, player: Option<&str>) -> Vec<String> {
    let mut cmds = vec!["demo_pause".to_string()];
    let tick = target_tick(start_tick);
    if tick > 0 {
        cmds.push(format!("demo_gototick {tick}"));
    }
    if let Some(p) = player.filter(|p| !p.is_empty()) {
        cmds.push(format!("spec_player {}", quote_player(p)));
    }
    cmds
}

/// What goes on the clipboard: the commands joined with `; `.
pub fn clipboard_text(cmds: &[String]) -> String {
    cmds.join("; ")
}

/// POV: for each round, the tick to skip ahead at — the player's (last) death in that
/// round, otherwise the round end.
pub fn pov_jump_ticks(rounds: &[(i64, i64)], deaths: &[(i64, i64)]) -> Vec<i64> {
    let by_round: HashMap<i64, i64> = deaths.iter().copied().collect();
    rounds.iter().enumerate().map(|(i, (_, end))| *by_round.get(&(i as i64)).unwrap_or(end)).collect()
}

/// Current tick from `demo_goto` output: "Currently playing 5574 of 160517 ticks".
pub fn parse_demo_goto_tick(response: &str) -> Option<i64> {
    let lower = response.to_ascii_lowercase();
    let at = lower.find("currently")?;
    let mut words = lower[at..].split_whitespace();
    (words.next()? == "currently" && words.next()? == "playing").then_some(())?;
    let tick: i64 = words.next()?.parse().ok()?;
    (words.next()? == "of").then_some(tick)
}

// ---------- process checks ----------

fn running_processes() -> Vec<String> {
    use sysinfo::{ProcessRefreshKind, RefreshKind, System};
    let Ok(sys) = System::new_with_specifics(RefreshKind::nothing().with_processes(ProcessRefreshKind::nothing())) else {
        return Vec::new();
    };
    sys.processes().values().map(|p| p.name().to_string_lossy().to_lowercase()).collect()
}

pub fn is_cs2_running() -> bool {
    running_processes().iter().any(|n| n == "cs2.exe" || n == "cs2")
}

/// Electron refuses to drive CS2 while these anti-cheats run.
pub fn blocking_anticheat() -> Option<&'static str> {
    let procs = running_processes();
    if procs.iter().any(|n| n == "akros.exe") {
        Some("Akros anti-cheat is running, close it before you can continue")
    } else if procs.iter().any(|n| n == "faceitclient.exe") {
        Some("FACEIT anti-cheat is running, close it before you can continue")
    } else {
        None
    }
}

// ---------- state shared across launches ----------

/// The demo CS2 is playing, as far as we know (Electron's `currentDemoPath`).
fn current_demo() -> &'static Mutex<Option<PathBuf>> {
    static CURRENT: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();
    CURRENT.get_or_init(|| Mutex::new(None))
}

fn same_path(a: &Path, b: &Path) -> bool {
    let norm = |p: &Path| {
        std::fs::canonicalize(p)
            .unwrap_or_else(|_| p.to_path_buf())
            .to_string_lossy()
            .replace('\\', "/")
            .to_lowercase()
    };
    norm(a) == norm(b)
}

/// Bumped whenever a POV session starts, so an older poll loop stops.
static POV_GENERATION: AtomicU64 = AtomicU64::new(0);

// ---------- command log (Electron commandLog.ts) ----------

const MAX_COMMANDS: usize = 50;

#[derive(Debug, Clone)]
pub struct CommandEntry {
    /// Milliseconds since the Unix epoch.
    pub ts: u64,
    pub cmd: String,
}

fn log_buffer() -> &'static Mutex<VecDeque<CommandEntry>> {
    static LOG: OnceLock<Mutex<VecDeque<CommandEntry>>> = OnceLock::new();
    LOG.get_or_init(|| Mutex::new(VecDeque::new()))
}

pub fn push_command(cmd: &str) {
    let ts = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64);
    let mut log = log_buffer().lock().unwrap();
    log.push_back(CommandEntry { ts, cmd: cmd.trim().to_string() });
    while log.len() > MAX_COMMANDS {
        log.pop_front();
    }
}

/// The last 50 commands sent to CS2 (recorded while Settings → debug mode is on).
pub fn command_log() -> Vec<CommandEntry> {
    log_buffer().lock().unwrap().iter().cloned().collect()
}

pub fn clear_command_log() {
    log_buffer().lock().unwrap().clear();
}

/// Electron `sendCS2CommandsSequentially`: 500 ms between commands (longer after playdemo /
/// gototick), commands recorded in the debug log, `currentDemoPath` updated on playdemo.
fn send_sequence(port: u16, cmds: &[String]) -> Result<()> {
    let debug = Settings::open().is_ok_and(|s| s.get_bool("debugMode", false));
    if debug {
        for c in cmds {
            push_command(c);
        }
    }
    netcon::send_batch(port, cmds, COMMAND_DELAY_MS, |_| {})?;
    if let Some(demo) = cmds.iter().find_map(|c| c.strip_prefix("playdemo ")) {
        *current_demo().lock().unwrap() = Some(PathBuf::from(demo.trim().trim_matches(['"', '\''])));
    }
    Ok(())
}

// ---------- launching ----------

/// What the UI should say after a successful start.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Started {
    /// CS2 wasn't running; it's being launched with the demo.
    Launched,
    /// CS2 was running with this demo; only navigating.
    SameDemo,
    /// CS2 was running; loading the new demo (after the user confirmed).
    NewDemo,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Started { how: Started, commands: String },
    /// CS2 is playing another demo: ask the user, then call again with `confirmed`.
    NeedsConfirm { current: Option<PathBuf>, new_demo: PathBuf },
}

fn check_ready(demo: &Path) -> Result<PathBuf> {
    if let Some(msg) = blocking_anticheat() {
        bail!(msg);
    }
    if !demo.exists() {
        bail!("Demo file not found: {}", demo.display());
    }
    crate::cs2::resolve_exe(Settings::open().ok().as_ref())
        .ok_or_else(|| anyhow::anyhow!("CS2 executable not found. Please set the CS2 path in Settings."))
}

fn spawn_cs2(exe: &Path, port: u16) -> Result<()> {
    let mut cmd = std::process::Command::new(exe);
    cmd.args(["-insecure", "-novid", "-netconport", &port.to_string()])
        .current_dir(exe.parent().unwrap_or(Path::new(".")))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        cmd.creation_flags(DETACHED_PROCESS);
    }
    cmd.spawn().map_err(|e| anyhow::anyhow!("Failed to launch CS2: {e}"))?;
    Ok(())
}

/// After launching CS2, wait until its console socket accepts connections. Electron used a
/// fixed 3 s (5 s for POV); a cold start through Steam can take much longer, and the
/// first send then failed with "connection refused".
fn wait_for_netcon(port: u16, at_least: Duration) {
    std::thread::sleep(at_least);
    let deadline = std::time::Instant::now() + Duration::from_secs(90);
    while std::time::Instant::now() < deadline && !netcon::is_reachable(port) {
        std::thread::sleep(Duration::from_millis(500));
    }
}

/// Is CS2 playing `demo` right now? (`demo_goto` answers "Currently playing N of M ticks …
/// File:<path>", or "Not currently playing back a demo".)
fn is_playing(port: u16, demo: &Path) -> bool {
    let Ok(reply) = netcon::send_and_read(port, "demo_goto", 1200) else { return false };
    let name = demo.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    parse_demo_goto_tick(&reply).is_some() && reply.to_lowercase().contains(&name)
}

/// `playdemo`, then Electron's 5 s for it to load. Right after CS2 starts, its console
/// accepts commands before the game acts on them and the first `playdemo` is silently
/// dropped, so check that the demo is playing and send it again if not (up to ~1 min).
fn play_until_loaded(port: u16, demo: &Path) -> Result<()> {
    let cmd = [format!("playdemo \"{}\"", demo.display())];
    for _ in 0..12 {
        send_sequence(port, &cmd)?;
        std::thread::sleep(Duration::from_secs(5));
        if is_playing(port, demo) {
            return Ok(());
        }
    }
    bail!("CS2 didn't start playing {}", demo.display())
}

/// Background: wait, playdemo, let it load, then the rest (plus `demo_resume` after
/// spectating when autoplay is on). Errors are only logged, as in Electron.
fn run_sequence(port: u16, demo: PathBuf, rest: Vec<String>, first_wait: Duration, with_playdemo: bool, resume_after_spec: bool) {
    std::thread::spawn(move || {
        wait_for_netcon(port, first_wait);
        let result = (|| -> Result<()> {
            if with_playdemo {
                play_until_loaded(port, &demo)?;
            }
            if !rest.is_empty() {
                send_sequence(port, &rest)?;
            }
            if resume_after_spec {
                std::thread::sleep(Duration::from_secs(2));
                send_sequence(port, &["demo_resume".into()])?;
            }
            Ok(())
        })();
        if let Err(e) = result {
            eprintln!("[cs2] failed to send commands via netconport: {e:#}");
        }
    });
}

/// "Watch in CS2" / watch an event: open `demo` in CS2 at 5 s before `start_tick`,
/// spectating `player`. Pass `confirmed` after the user agreed to switch demos.
pub fn start_watch(demo: &Path, start_tick: Option<i64>, player: Option<&str>, confirmed: bool) -> Result<Outcome> {
    let exe = check_ready(demo)?;
    let running = is_cs2_running();
    let port = netcon::port();
    let cmds = watch_commands(demo, start_tick, player, running, &WindowSettings::load());
    let commands = clipboard_text(&cmds);
    let rest: Vec<String> = cmds.iter().filter(|c| !c.starts_with("playdemo")).cloned().collect();
    let autoplay = Settings::open().map_or(true, |s| s.get_bool("autoplayAfterSpectate", true));
    let resume = autoplay && player.is_some_and(|p| !p.is_empty());
    let demo = demo.to_path_buf();

    if running {
        let current = current_demo().lock().unwrap().clone();
        if current.as_deref().is_some_and(|c| same_path(c, &demo)) {
            run_sequence(port, demo, rest, Duration::from_secs(1), false, resume);
            return Ok(Outcome::Started { how: Started::SameDemo, commands });
        }
        if !confirmed {
            return Ok(Outcome::NeedsConfirm { current, new_demo: demo });
        }
        run_sequence(port, demo, rest, Duration::from_secs(1), true, resume);
        return Ok(Outcome::Started { how: Started::NewDemo, commands });
    }

    spawn_cs2(&exe, port)?;
    run_sequence(port, demo, rest, Duration::from_secs(3), true, resume);
    Ok(Outcome::Started { how: Started::Launched, commands })
}

/// "Watch POV": play every round from the player's view at 2×, skipping to the next
/// round when they die (`deaths` = (round index, tick)).
pub fn start_pov(demo: &Path, player: &str, rounds: Vec<(i64, i64)>, deaths: Vec<(i64, i64)>, tick_rate: f64, confirmed: bool) -> Result<Outcome> {
    let exe = check_ready(demo)?;
    let running = is_cs2_running();
    let port = netcon::port();
    let first = rounds.first().map_or(0, |r| r.0);
    let cmds = pov_commands(demo, player, first, running, &WindowSettings::load());
    let commands = clipboard_text(&cmds);
    let nav: Vec<String> = cmds.iter().filter(|c| !c.starts_with("playdemo")).cloned().collect();
    let demo = demo.to_path_buf();
    let pov = PovSession { port, player: player.to_string(), jump: pov_jump_ticks(&rounds, &deaths), rounds, start: first, tick_rate };

    let (how, wait, with_playdemo) = if running {
        let current = current_demo().lock().unwrap().clone();
        if current.as_deref().is_some_and(|c| same_path(c, &demo)) {
            (Started::SameDemo, Duration::from_secs(1), false)
        } else if !confirmed {
            return Ok(Outcome::NeedsConfirm { current, new_demo: demo });
        } else {
            (Started::NewDemo, Duration::from_secs(1), true)
        }
    } else {
        spawn_cs2(&exe, port)?;
        (Started::Launched, Duration::from_secs(5), true)
    };

    std::thread::spawn(move || {
        wait_for_netcon(port, wait);
        let result = (|| -> Result<()> {
            if with_playdemo {
                play_until_loaded(port, &demo)?;
            }
            pov.run(nav)
        })();
        if let Err(e) = result {
            eprintln!("[cs2] POV playback stopped: {e:#}");
        }
    });
    Ok(Outcome::Started { how, commands })
}

struct PovSession {
    port: u16,
    player: String,
    rounds: Vec<(i64, i64)>,
    jump: Vec<i64>,
    start: i64,
    tick_rate: f64,
}

impl PovSession {
    /// Electron's `runPOVSequenceAndPoll`: navigate, then every 1.5 s read the current tick
    /// and jump to the next round once the player died (or the round ended).
    fn run(self, nav: Vec<String>) -> Result<()> {
        let generation = POV_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
        send_sequence(self.port, &nav)?;
        std::thread::sleep(Duration::from_millis(500));
        send_sequence(self.port, &["demo_resume".into()])?;

        let started = std::time::Instant::now();
        let spec = format!("spec_player {}", quote_player(&self.player));
        let mut last_known: Option<i64> = None;
        let mut jumped_from: Option<usize> = None;
        loop {
            std::thread::sleep(Duration::from_millis(1500));
            if POV_GENERATION.load(Ordering::SeqCst) != generation {
                return Ok(()); // a newer POV session took over
            }
            // A netcon error means CS2 closed: stop polling.
            let raw = netcon::send_and_read(self.port, "demo_goto", 1200)?;
            if let Some(t) = parse_demo_goto_tick(&raw) {
                last_known = Some(t);
            }
            let tick = last_known.unwrap_or_else(|| {
                self.start + (started.elapsed().as_secs_f64() * self.tick_rate * 2.0) as i64
            });
            let Some(round) = self.rounds.iter().position(|(s, e)| tick >= *s && tick <= *e) else { continue };
            if jumped_from.is_some_and(|r| r != round) {
                jumped_from = None;
            }
            let jump = self.jump[round];
            if tick >= jump && round + 1 < self.rounds.len() {
                if jumped_from == Some(round) {
                    continue; // already asked to skip; wait for the seek to land
                }
                send_sequence(self.port, &[format!("demo_gototick {}", self.rounds[round + 1].0), spec.clone()])?;
                jumped_from = Some(round);
            } else if round + 1 == self.rounds.len() && tick >= jump {
                return Ok(());
            } else {
                // Re-assert the spectate target; CS2 can lose it after a skip.
                send_sequence(self.port, std::slice::from_ref(&spec))?;
            }
        }
    }
}

/// `cs2:copyCommands`: the navigation commands for a CS2 that already has the demo open;
/// sent right away if CS2 is running. Returns the clipboard text.
pub fn copy_and_send(start_tick: Option<i64>, player: Option<&str>) -> Result<String> {
    if let Some(msg) = blocking_anticheat() {
        bail!(msg);
    }
    let cmds = copy_commands(start_tick, player);
    let text = clipboard_text(&cmds);
    if is_cs2_running() {
        let port = netcon::port();
        std::thread::spawn(move || {
            if let Err(e) = send_sequence(port, &cmds) {
                eprintln!("[cs2] failed to send commands via netconport: {e:#}");
            }
        });
    }
    Ok(text)
}

/// "Play in CS2" (Explorer verb): just open the demo, no navigation (Electron `playDemoInCS2`).
pub fn play_demo(demo: &Path) -> Result<()> {
    if !demo.exists() {
        bail!("Demo file not found: {}", demo.display());
    }
    let exe = crate::cs2::resolve_exe(Settings::open().ok().as_ref())
        .ok_or_else(|| anyhow::anyhow!("CS2 executable not found"))?;
    let port = netcon::port();
    let cmd = vec![format!("playdemo \"{}\"", demo.display())];
    if is_cs2_running() {
        std::thread::spawn(move || {
            let _ = send_sequence(port, &cmd);
        });
    } else {
        spawn_cs2(&exe, port)?;
        std::thread::spawn(move || {
            wait_for_netcon(port, Duration::from_secs(8));
            let _ = send_sequence(port, &cmd);
        });
    }
    Ok(())
}

// ---------- CS Demo Analyzer server plugin (electron/cs2-plugin.ts) ----------

/// Is CS Demo Analyzer's server plugin installed next to `cs2_exe`?
pub fn is_plugin_installed(cs2_exe: &Path) -> bool {
    let Some(root) = cs2_exe.ancestors().nth(4) else { return false };
    let plugin = if cfg!(windows) {
        root.join("game/csgo/csdm/bin/win64/server.dll")
    } else {
        root.join("game/csgo/csdm/bin/linuxsteamrt64/libserver.so")
    };
    plugin.exists()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn win() -> WindowSettings {
        WindowSettings { width: "1920".into(), height: "1080".into(), fullscreen: false }
    }

    #[test]
    fn watch_sequence_matches_electron() {
        let demo = Path::new(r"E:\demos\a b.dem");
        assert_eq!(
            watch_commands(demo, Some(1000), Some("Some Guy"), false, &win()),
            vec![
                "playdemo \"E:\\demos\\a b.dem\"",
                "mat_setvideomode 1920 1080 0",
                "demo_pause",
                "demo_gototick 680",
                "spec_player \"Some Guy\"",
            ]
        );
        // Already running: no video mode; start of demo: no pause/goto; no player: no spec.
        assert_eq!(watch_commands(demo, None, None, true, &win()), vec!["playdemo \"E:\\demos\\a b.dem\""]);
        // Close to the start clamps to 0, which Electron treats as "from the start".
        assert_eq!(watch_commands(demo, Some(100), Some("x"), true, &win()).len(), 2);
    }

    #[test]
    fn pov_sequence_matches_electron() {
        let w = WindowSettings { fullscreen: true, ..win() };
        assert_eq!(
            pov_commands(Path::new("d.dem"), "Bob", 512, false, &w),
            vec![
                "playdemo \"d.dem\"",
                "mat_setvideomode 1920 1080 1",
                "demo_pause",
                "demo_gototick 512",
                "spec_player Bob",
                "demo_timescale 2",
                "demo_resume",
            ]
        );
        assert_eq!(pov_jump_ticks(&[(0, 100), (200, 300)], &[(1, 250), (1, 260)]), vec![100, 260]);
    }

    #[test]
    fn copy_sequence_and_clipboard() {
        let cmds = copy_commands(Some(10_000), Some("a"));
        assert_eq!(cmds, vec!["demo_pause", "demo_gototick 9680", "spec_player a"]);
        assert_eq!(clipboard_text(&cmds), "demo_pause; demo_gototick 9680; spec_player a");
        assert_eq!(copy_commands(None, None), vec!["demo_pause"]);
    }

    #[test]
    fn parses_demo_goto() {
        let out = "[Demo]   Currently playing 5574 of 160517 ticks. Minutes:41.80 File:x.dem";
        assert_eq!(parse_demo_goto_tick(out), Some(5574));
        assert_eq!(parse_demo_goto_tick("Currently  playing\t12 of 99"), Some(12));
        assert_eq!(parse_demo_goto_tick("nothing here"), None);
    }

    #[test]
    fn command_log_keeps_last_50() {
        clear_command_log();
        for i in 0..60 {
            push_command(&format!(" cmd {i} "));
        }
        let log = command_log();
        assert_eq!(log.len(), 50);
        assert_eq!(log[0].cmd, "cmd 10");
    }
}

/// Timing check for the process scan: `cargo test -p cs2da-core process_scan -- --ignored --nocapture`
#[cfg(test)]
#[test]
#[ignore]
fn process_scan_speed() {
    let t = std::time::Instant::now();
    let running = is_cs2_running();
    let anticheat = blocking_anticheat();
    println!("cs2 running: {running}, anti-cheat: {anticheat:?}, took {:?}", t.elapsed());
}
