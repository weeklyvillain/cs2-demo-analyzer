//! Audio output for voice playback: one shared output device, and a seekable
//! rodio source that decodes the extractor's Ogg Opus files as it plays.

use std::num::NonZero;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Result, anyhow};
use cs2da_core::voice::{OPUS_RATE, OggOpus, OpusStream};
use rodio::source::SeekError;
use rodio::{ChannelCount, Player, SampleRate, Source};

thread_local! {
    // The device sink must outlive every player and isn't `Send`; the UI thread owns it.
    static OUTPUT: std::cell::RefCell<Option<rodio::MixerDeviceSink>> = const { std::cell::RefCell::new(None) };
}

fn new_player() -> Result<Player> {
    OUTPUT.with(|out| {
        let mut out = out.borrow_mut();
        if out.is_none() {
            let mut sink = rodio::DeviceSinkBuilder::open_default_sink().map_err(|e| anyhow!("No audio output: {e}"))?;
            sink.log_on_drop(false);
            *out = Some(sink);
        }
        Ok(Player::connect_new(out.as_ref().unwrap().mixer()))
    })
}

struct VoiceSource {
    stream: OpusStream,
    channels: ChannelCount,
    duration: Duration,
}

impl Iterator for VoiceSource {
    type Item = f32;
    #[inline]
    fn next(&mut self) -> Option<f32> {
        self.stream.next_sample()
    }
}

impl Source for VoiceSource {
    fn current_span_len(&self) -> Option<usize> {
        None
    }
    fn channels(&self) -> ChannelCount {
        self.channels
    }
    fn sample_rate(&self) -> SampleRate {
        NonZero::new(OPUS_RATE).unwrap()
    }
    fn total_duration(&self) -> Option<Duration> {
        Some(self.duration)
    }
    fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> {
        self.stream.seek(pos.as_secs_f64());
        Ok(())
    }
}

/// One playable voice file. Paused until [`Track::play`].
pub struct Track {
    pub ogg: Arc<OggOpus>,
    player: Player,
    pub duration: f64,
    /// Set after the file ran out; the next play starts from the top (Electron reloads the element).
    ended: bool,
}

impl Track {
    pub fn open(path: &Path) -> Result<Self> {
        let ogg = Arc::new(OggOpus::open(path)?);
        let duration = ogg.duration_secs();
        let player = new_player()?;
        player.pause();
        let mut track = Self { ogg, player, duration, ended: false };
        track.load()?;
        Ok(track)
    }

    fn load(&mut self) -> Result<()> {
        let stream = OpusStream::new(self.ogg.clone())?;
        let channels = NonZero::new(stream.channels().max(1)).unwrap();
        self.player.clear();
        self.player.append(VoiceSource { stream, channels, duration: Duration::from_secs_f64(self.duration) });
        self.player.pause();
        self.ended = false;
        Ok(())
    }

    pub fn is_playing(&self) -> bool {
        !self.player.is_paused() && !self.player.empty()
    }

    /// Current position in seconds; 0 once it has ended.
    pub fn position(&self) -> f64 {
        if self.ended { 0.0 } else { self.player.get_pos().as_secs_f64().min(self.duration) }
    }

    pub fn play(&mut self) {
        if self.ended || self.player.empty() {
            let _ = self.load();
        }
        self.player.play();
    }

    pub fn pause(&self) {
        self.player.pause();
    }

    pub fn seek(&mut self, secs: f64) {
        if self.ended || self.player.empty() {
            let _ = self.load();
        }
        let _ = self.player.try_seek(Duration::from_secs_f64(secs.clamp(0.0, self.duration)));
    }

    /// 0.0–2.0 like Electron's gain node.
    pub fn set_volume(&self, v: f32) {
        self.player.set_volume(v.clamp(0.0, 2.0));
    }

    /// Playback speed (note: rodio changes pitch with speed; HTML audio keeps it).
    pub fn set_speed(&self, s: f32) {
        self.player.set_speed(s);
    }

    /// Call every frame: notices the end of the file and resets like Electron's `onEnded`.
    /// Returns true when playback just ended.
    pub fn poll_ended(&mut self) -> bool {
        if !self.ended && self.player.empty() {
            self.ended = true;
            self.player.pause();
            return true;
        }
        false
    }
}

impl Drop for Track {
    fn drop(&mut self) {
        self.player.stop();
    }
}
