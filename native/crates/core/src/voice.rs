//! Voice chat: running `cs2-voice-extractor` the way Electron's `voice:*` handlers do,
//! reading the Ogg Opus files it writes, and the packet-size waveform from
//! `electron/voiceAudio.ts`.

use std::collections::HashMap;
use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};

use anyhow::{Context as _, Result, anyhow, bail};
use serde::Deserialize;

use crate::paths;
use crate::stats::Stats;

// ---------- extractor ----------

pub fn extractor_exe() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("VOICE_EXTRACTOR_PATH") {
        return Some(PathBuf::from(p));
    }
    let name = if cfg!(windows) { "cs2-voice-extractor.exe" } else { "cs2-voice-extractor" };
    paths::bin_dir().map(|d| d.join(name)).filter(|p| p.exists())
}

#[derive(Debug, Clone, Deserialize)]
pub struct ExtractorPlayer {
    pub steam_id: String,
    pub voice_seconds: f64,
    pub file: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct DemoResult {
    error: Option<String>,
    #[serde(default)]
    players: Vec<ExtractorPlayer>,
}

/// Run the extractor with `--json`. Exit code 2 ("no voice in this demo") is a normal
/// result. Each stderr line goes to `on_log`.
fn run_extractor(args: &[String], mut on_log: impl FnMut(String)) -> Result<Vec<ExtractorPlayer>> {
    let exe = extractor_exe().context("Voice extractor not found (expected bin/win/cs2-voice-extractor.exe)")?;
    let mut cmd = Command::new(&exe);
    cmd.args(args).arg("--json").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn().map_err(|e| anyhow!("Failed to start voice extractor: {e}"))?;
    let mut stdout = child.stdout.take().expect("piped");
    let out_thread = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stdout.read_to_string(&mut s);
        s
    });
    let mut stderr_all = String::new();
    if let Some(err) = child.stderr.take() {
        use std::io::BufRead as _;
        for line in std::io::BufReader::new(err).lines().map_while(Result::ok) {
            stderr_all.push_str(&line);
            stderr_all.push('\n');
            if !line.trim().is_empty() {
                on_log(line);
            }
        }
    }
    let status = child.wait()?;
    let stdout = out_thread.join().unwrap_or_default();
    let code = status.code();
    if code != Some(0) && code != Some(2) {
        bail!(
            "Voice extraction failed ({}). {}",
            code.map_or("killed".to_string(), |c| format!("exit code {c}")),
            stderr_all.trim()
        );
    }
    let parsed: Vec<DemoResult> = serde_json::from_str(&stdout)
        .map_err(|_| anyhow!("Voice extractor returned unexpected output. {}", stderr_all.trim()))?;
    let first = parsed.into_iter().next().ok_or_else(|| anyhow!("Voice extractor returned no result"))?;
    if let Some(e) = first.error {
        bail!("Voice extraction failed: {e}");
    }
    Ok(first.players)
}

/// Who talked in a demo: SteamID64 → seconds of voice (`--list`). Cached by path,
/// size and modification time, like Electron, so a replaced demo is scanned again.
pub fn list_speakers(demo: &Path) -> Result<HashMap<String, f64>> {
    static CACHE: OnceLock<Mutex<HashMap<String, HashMap<String, f64>>>> = OnceLock::new();
    let meta = std::fs::metadata(demo)?;
    let mtime = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis());
    let key = format!("{}|{}|{}", demo.display(), meta.len(), mtime);
    let cache = CACHE.get_or_init(Default::default);
    if let Some(hit) = cache.lock().unwrap().get(&key) {
        return Ok(hit.clone());
    }
    let players = run_extractor(&[demo.display().to_string(), "--list".into()], |_| {})?;
    let speakers: HashMap<String, f64> = players.into_iter().map(|p| (p.steam_id, p.voice_seconds)).collect();
    cache.lock().unwrap().insert(key, speakers.clone());
    Ok(speakers)
}

/// Output layouts Electron asks for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// One file per player, voice only (single-player playback).
    SplitCompact,
    /// One file per player spanning the whole demo (team comms, kept in sync).
    SplitFull,
}

impl Mode {
    fn arg(self) -> &'static str {
        match self {
            Mode::SplitCompact => "split-compact",
            Mode::SplitFull => "split-full",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Extraction {
    /// Temp folder holding the files; delete it with [`cleanup`].
    pub output_dir: PathBuf,
    /// (SteamID64, file) for every player that had voice.
    pub files: Vec<(String, PathBuf)>,
}

/// Extract voice to a fresh temp folder (Electron `voice:extract`), and record stats.
pub fn extract(demo: &Path, mode: Mode, steam_ids: &[String], on_log: impl FnMut(String)) -> Result<Extraction> {
    if !demo.exists() {
        bail!("Demo file not found: {}", demo.display());
    }
    let millis = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis());
    let output_dir = std::env::temp_dir().join(format!("cs2-voice-{millis}"));
    std::fs::create_dir_all(&output_dir)?;
    let mut args = vec![
        demo.display().to_string(),
        "--mode".into(),
        mode.arg().into(),
        "--out".into(),
        output_dir.display().to_string(),
    ];
    if !steam_ids.is_empty() {
        args.push("--steam-id".into());
        args.push(steam_ids.join(","));
    }
    let players = run_extractor(&args, on_log)?;
    let mut files: Vec<(String, PathBuf)> = Vec::new();
    for p in &players {
        if let Some(f) = p.file.as_ref().map(PathBuf::from).filter(|f| f.exists()) {
            if !files.iter().any(|(_, g)| g == &f) {
                files.push((p.steam_id.clone(), f));
            }
        }
    }
    let voice_ms = players.iter().map(|p| p.voice_seconds * 1000.0).sum::<f64>() as i64;
    if let Ok(stats) = Stats::open() {
        // Electron calls trackVoiceExtracted and then increments total_voices_extracted again.
        let _ = stats.track_voice_extracted(voice_ms, files.len() as i64);
        let _ = stats.increment("total_voices_extracted", files.len() as i64);
    }
    Ok(Extraction { output_dir, files })
}

/// Delete an extraction folder, but only inside the temp directory (Electron's safety check).
pub fn cleanup(dir: &Path) {
    let temp = std::env::temp_dir();
    let (Ok(temp), Ok(target)) = (std::fs::canonicalize(&temp), std::fs::canonicalize(dir)) else { return };
    if target.starts_with(&temp) && target != temp {
        let _ = std::fs::remove_dir_all(target);
    }
}

// ---------- Ogg Opus ----------

pub const OPUS_RATE: u32 = 48_000;
/// Packets this small are the extractor's silence filler (or DTX).
const SILENCE_PACKET_MAX_BYTES: usize = 3;

#[derive(Debug, Clone)]
pub struct OpusPacket {
    /// Start in 48 kHz samples, after pre-skip (can be negative for the first packets).
    pub start: i64,
    pub samples: u32,
    pub data: Vec<u8>,
}

/// An Ogg Opus file read into memory (voice files are small: ~6 KB per second of talk).
#[derive(Debug, Clone)]
pub struct OggOpus {
    pub channels: u16,
    pub pre_skip: u32,
    pub packets: Vec<OpusPacket>,
    pub duration_samples: u64,
}

impl OggOpus {
    pub fn duration_secs(&self) -> f64 {
        self.duration_samples as f64 / OPUS_RATE as f64
    }

    pub fn open(path: &Path) -> Result<Self> {
        Ok(Self::parse(&std::fs::read(path)?))
    }

    /// Walk Ogg pages and collect audio packets (port of `readOggOpusPackets`).
    pub fn parse(data: &[u8]) -> Self {
        let mut packets = Vec::new();
        let (mut channels, mut pre_skip) = (1u16, 0u32);
        let mut index = 0usize;
        let mut position: i64 = 0;
        let mut last_granule: i64 = -1;
        let mut pending: Vec<u8> = Vec::new();
        let mut offset = 0usize;

        let mut on_packet = |packet: Vec<u8>, position: &mut i64| {
            let i = index;
            index += 1;
            if i == 0 {
                if packet.len() >= 12 && &packet[..8] == b"OpusHead" {
                    channels = u16::from(packet[9].max(1));
                    pre_skip = u32::from(u16::from_le_bytes([packet[10], packet[11]]));
                }
                return;
            }
            if i == 1 {
                return; // OpusTags
            }
            let samples = packet_samples(&packet);
            if samples > 0 {
                packets.push(OpusPacket { start: *position - i64::from(pre_skip), samples, data: packet });
                *position += i64::from(samples);
            }
        };

        while offset + 27 <= data.len() {
            if &data[offset..offset + 4] != b"OggS" {
                match data[offset + 1..].windows(4).position(|w| w == b"OggS") {
                    Some(p) => {
                        offset += 1 + p;
                        continue;
                    }
                    None => break,
                }
            }
            let granule = i64::from_le_bytes(data[offset + 6..offset + 14].try_into().unwrap());
            let segments = data[offset + 26] as usize;
            let table = offset + 27;
            let body = table + segments;
            if body > data.len() {
                break;
            }
            let body_len: usize = data[table..body].iter().map(|&b| b as usize).sum();
            if body + body_len > data.len() {
                break;
            }
            let mut cursor = body;
            for &lacing in &data[table..body] {
                let lacing = lacing as usize;
                pending.extend_from_slice(&data[cursor..cursor + lacing]);
                cursor += lacing;
                if lacing < 255 {
                    on_packet(std::mem::take(&mut pending), &mut position);
                }
            }
            if granule != -1 {
                last_granule = granule;
            }
            offset = body + body_len;
        }
        let pre = i64::from(pre_skip);
        let duration_samples = if last_granule > 0 { (last_granule - pre).max(0) } else { (position - pre).max(0) } as u64;
        Self { channels, pre_skip, packets, duration_samples }
    }

    /// Index of the packet playing at `sample` (48 kHz, after pre-skip).
    pub fn packet_at(&self, sample: i64) -> usize {
        self.packets.partition_point(|p| p.start + i64::from(p.samples) <= sample)
    }

    /// Whether someone is talking at `secs` (a non-silence packet covers that instant).
    pub fn is_voiced_at(&self, secs: f64) -> bool {
        let sample = (secs * OPUS_RATE as f64) as i64;
        self.packets
            .get(self.packet_at(sample))
            .is_some_and(|p| p.start <= sample && p.data.len() > SILENCE_PACKET_MAX_BYTES)
    }

    /// Waveform bars from packet sizes (port of `computeOggOpusAmplitudesFromFile`).
    pub fn amplitudes(&self, num_bars: usize) -> Vec<f32> {
        let total = self.duration_samples as f64;
        if num_bars == 0 || total <= 0.0 || self.packets.is_empty() {
            return vec![0.0; num_bars];
        }
        let mut bytes = vec![0f64; num_bars];
        let mut covered = vec![0f64; num_bars];
        let per_bar = total / num_bars as f64;
        for p in &self.packets {
            if p.data.len() <= SILENCE_PACKET_MAX_BYTES {
                continue;
            }
            let start = (p.start as f64).max(0.0);
            let end = total.min((p.start + i64::from(p.samples)) as f64);
            if end <= start {
                continue;
            }
            let density = p.data.len() as f64 / f64::from(p.samples);
            let mut bar = ((start / per_bar).floor() as usize).min(num_bars - 1);
            let mut cursor = start;
            while cursor < end && bar < num_bars {
                let bar_end = end.min((bar + 1) as f64 * per_bar);
                let span = bar_end - cursor;
                if span > 0.0 {
                    bytes[bar] += density * span;
                    covered[bar] += span;
                }
                cursor = bar_end;
                bar += 1;
            }
        }
        let levels: Vec<f64> = bytes
            .iter()
            .zip(&covered)
            .map(|(&b, &c)| if c <= 0.0 { 0.0 } else { (b / c) * (c / per_bar).min(1.0).sqrt() })
            .collect();
        shape_levels(&levels)
    }
}

/// Streaming decoder over an [`OggOpus`]: 48 kHz interleaved f32, with sample-accurate
/// seeking (the decoder is reset and warmed up on a few earlier packets first).
pub struct OpusStream {
    ogg: std::sync::Arc<OggOpus>,
    decoder: opus_pure::OpusDecoder,
    next_packet: usize,
    buf: Vec<f32>,
    buf_pos: usize,
    /// Interleaved samples still to drop from the front (pre-skip / seek alignment).
    skip: usize,
    /// Output position in samples per channel, after pre-skip.
    pos: u64,
}

/// Packets decoded before a seek target so the decoder state has converged (~80 ms).
const SEEK_PREROLL_PACKETS: usize = 4;

impl OpusStream {
    pub fn new(ogg: std::sync::Arc<OggOpus>) -> Result<Self> {
        let decoder = opus_pure::OpusDecoder::new(OPUS_RATE as i32, ogg.channels as usize)
            .map_err(|e| anyhow!("opus decoder: {e}"))?;
        let skip = ogg.pre_skip as usize * ogg.channels as usize;
        Ok(Self { ogg, decoder, next_packet: 0, buf: Vec::new(), buf_pos: 0, skip, pos: 0 })
    }

    pub fn channels(&self) -> u16 {
        self.ogg.channels
    }

    pub fn duration_secs(&self) -> f64 {
        self.ogg.duration_secs()
    }

    /// Current position in seconds.
    pub fn position_secs(&self) -> f64 {
        self.pos as f64 / OPUS_RATE as f64
    }

    pub fn seek(&mut self, secs: f64) {
        let target = ((secs.max(0.0) * OPUS_RATE as f64) as u64).min(self.ogg.duration_samples);
        let index = self.ogg.packet_at(target as i64);
        let start_index = index.saturating_sub(SEEK_PREROLL_PACKETS);
        let _ = self.decoder.reset_state();
        self.next_packet = start_index;
        self.buf.clear();
        self.buf_pos = 0;
        // Samples between where decoding restarts and the target are thrown away.
        let restart = self.ogg.packets.get(start_index).map_or(target as i64, |p| p.start);
        let drop_frames = (target as i64 - restart).max(0) as usize;
        self.skip = drop_frames * self.ogg.channels as usize;
        self.pos = target;
    }

    fn refill(&mut self) -> bool {
        let channels = self.ogg.channels as usize;
        while self.next_packet < self.ogg.packets.len() {
            let packet = &self.ogg.packets[self.next_packet];
            self.next_packet += 1;
            self.buf.resize(opus_pure::MAX_PACKET_SAMPLES * channels, 0.0);
            let n = match self.decoder.decode(&packet.data, opus_pure::MAX_PACKET_SAMPLES, &mut self.buf) {
                Ok(n) => n,
                Err(_) => {
                    // Corrupt packet: conceal it as silence of the right length.
                    let n = packet.samples as usize;
                    self.buf[..n * channels].fill(0.0);
                    n
                }
            };
            self.buf.truncate(n * channels);
            self.buf_pos = 0;
            if self.skip > 0 {
                let drop = self.skip.min(self.buf.len());
                self.buf_pos = drop;
                self.skip -= drop;
            }
            if self.buf_pos < self.buf.len() {
                return true;
            }
        }
        false
    }

    /// Next interleaved sample, or `None` at the end of the file.
    #[inline]
    pub fn next_sample(&mut self) -> Option<f32> {
        if self.buf_pos >= self.buf.len() && !self.refill() {
            return None;
        }
        if self.pos >= self.ogg.duration_samples {
            return None;
        }
        let s = self.buf[self.buf_pos];
        self.buf_pos += 1;
        if self.buf_pos % self.ogg.channels as usize == 0 {
            self.pos += 1;
        }
        Some(s)
    }
}

/// Samples (48 kHz) in one Opus packet, from its TOC byte (RFC 6716 §3.1).
pub fn packet_samples(packet: &[u8]) -> u32 {
    let Some(&toc) = packet.first() else { return 0 };
    let config = toc >> 3;
    let frame = if config < 12 {
        [480, 960, 1920, 2880][(config & 3) as usize]
    } else if config < 16 {
        [480, 960][(config & 1) as usize]
    } else {
        [120, 240, 480, 960][(config & 3) as usize]
    };
    let frames = match toc & 3 {
        0 => 1,
        1 | 2 => 2,
        _ => match packet.get(1) {
            Some(b) => u32::from(b & 0x3f),
            None => return 0,
        },
    };
    frames * frame
}

/// `shapeWaveformLevels`: drop the quietest 20% as a floor, normalise, gentle curve.
fn shape_levels(levels: &[f64]) -> Vec<f32> {
    let max = levels.iter().cloned().fold(0.0, f64::max);
    if max <= 0.0 {
        return vec![0.0; levels.len()];
    }
    let mut sorted: Vec<f64> = levels.iter().cloned().filter(|v| *v > 0.0).collect();
    sorted.sort_by(|a, b| a.total_cmp(b));
    let floor = if sorted.is_empty() { 0.0 } else { sorted[((sorted.len() - 1) as f64 * 0.2).floor() as usize] * 0.85 };
    let range = (max - floor).max(1e-6);
    levels
        .iter()
        .map(|&v| {
            if v <= 0.0 {
                return 0.0;
            }
            let normed = (v - floor).max(0.0) / range;
            if normed > 0.0 { normed.powf(0.45).max(0.08) as f32 } else { 0.08 }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn toc_sample_counts() {
        assert_eq!(packet_samples(&[0b0000_1000]), 960); // SILK 20 ms, one frame
        assert_eq!(packet_samples(&[0b1111_1001]), 1920); // CELT 20 ms, two frames
        assert_eq!(packet_samples(&[0b1111_1011, 3]), 2880); // CELT 20 ms, code 3, 3 frames
        assert_eq!(packet_samples(&[]), 0);
    }

    #[test]
    fn shaping_keeps_silence_and_peaks() {
        let s = shape_levels(&[0.0, 1.0, 2.0, 4.0]);
        assert_eq!(s[0], 0.0);
        assert!((s[3] - 1.0).abs() < 1e-6);
        assert!(s[1] >= 0.08);
    }

    /// `CS2DA_TEST_DEMO=<demo.dem> cargo test -p cs2da-core real_voice -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn real_voice() {
        let demo = PathBuf::from(std::env::var("CS2DA_TEST_DEMO").expect("CS2DA_TEST_DEMO"));
        let speakers = list_speakers(&demo).unwrap();
        println!("{} speakers", speakers.len());
        let (id, secs) = speakers.iter().max_by(|a, b| a.1.total_cmp(b.1)).unwrap();
        let ex = extract(&demo, Mode::SplitCompact, &[id.clone()], |_| {}).unwrap();
        let (_, file) = &ex.files[0];
        let ogg = OggOpus::open(file).unwrap();
        println!("{id}: listed {secs}s, file {:.2}s, {} packets, {} ch", ogg.duration_secs(), ogg.packets.len(), ogg.channels);
        assert!((ogg.duration_secs() - secs).abs() < 1.0);
        let bars = ogg.amplitudes(600);
        assert!(bars.iter().any(|b| *b > 0.5));
        // Decode it all, then check a seek lands where asked.
        let ogg = std::sync::Arc::new(ogg);
        let mut stream = OpusStream::new(ogg.clone()).unwrap();
        let mut n = 0u64;
        let mut peak = 0f32;
        while let Some(s) = stream.next_sample() {
            n += 1;
            peak = peak.max(s.abs());
        }
        println!("decoded {n} samples, peak {peak:.3}");
        assert_eq!(n, ogg.duration_samples * u64::from(ogg.channels));
        assert!(peak > 0.05);
        stream.seek(100.0);
        assert!((stream.position_secs() - 100.0).abs() < 0.001);
        assert!(stream.next_sample().is_some());
        cleanup(&ex.output_dir);
        assert!(!ex.output_dir.exists());
    }
}
