//! Scrolling bar waveform (port of `src/utils/waveformUtils.ts`): bars from Opus packet
//! sizes, the playhead stays centred once past the middle, click to seek.

use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::sync::Arc;

use cs2da_core::voice::OggOpus;
use gpui_kit::*;

use crate::theme;

const BAR_WIDTH: f32 = 3.0;
const BAR_GAP: f32 = 2.0;
const BAR_STRIDE: f32 = BAR_WIDTH + BAR_GAP;
const BASE_BARS_PER_SECOND: f64 = 20.0;
const MAX_BARS: usize = 6000;

/// Enough bars to fill the width, more for long audio so it scrolls (`computeNumBars`).
fn num_bars(duration: f64, display_width: f32) -> usize {
    let from_duration = (duration * BASE_BARS_PER_SECOND).ceil() as usize;
    let from_display = (display_width / BAR_STRIDE).ceil() as usize;
    from_duration.max(from_display).min(MAX_BARS)
}

struct Scroll {
    scroll_x: f32,
    playhead_px: f32,
    played_bar: usize,
}

/// `computeScrollState`.
fn scroll_state(time: f64, duration: f64, bars: usize, display_width: f32) -> Scroll {
    let total = bars as f32 * BAR_STRIDE;
    if duration <= 0.0 || bars == 0 {
        return Scroll { scroll_x: 0.0, playhead_px: 0.0, played_bar: 0 };
    }
    let playhead_px = (time / duration) as f32 * total;
    let scroll_x = (playhead_px - display_width / 2.0).min(total - display_width).max(0.0);
    Scroll { scroll_x, playhead_px, played_bar: (playhead_px / BAR_STRIDE).floor() as usize }
}

/// A file's waveform, with its bars cached for the last width it was drawn at.
#[derive(Clone)]
pub struct Wave {
    pub ogg: Arc<OggOpus>,
    cache: Rc<RefCell<Option<(usize, Arc<Vec<f32>>)>>>,
    width: Rc<Cell<f32>>,
    bounds: Rc<Cell<Option<Bounds<Pixels>>>>,
}

impl Wave {
    pub fn new(ogg: Arc<OggOpus>) -> Self {
        Self {
            ogg,
            cache: Rc::default(),
            width: Rc::new(Cell::new(600.0)),
            bounds: Rc::default(),
        }
    }

    fn bars(&self) -> Arc<Vec<f32>> {
        let n = num_bars(self.ogg.duration_secs(), self.width.get());
        let mut cache = self.cache.borrow_mut();
        match cache.as_ref() {
            Some((count, bars)) if *count == n => bars.clone(),
            _ => {
                let bars = Arc::new(self.ogg.amplitudes(n));
                *cache = Some((n, bars.clone()));
                bars
            }
        }
    }

    /// Time under a window x position (`canvasXToTime`), using the last drawn layout.
    pub fn time_at(&self, x: Pixels, time_now: f64, duration: f64) -> Option<f64> {
        let bounds = self.bounds.get()?;
        let bars = self.bars().len();
        let width = f32::from(bounds.size.width);
        let s = scroll_state(time_now, duration, bars, width);
        let total = bars as f32 * BAR_STRIDE;
        if total == 0.0 {
            return Some(0.0);
        }
        let canvas_x = f32::from(x - bounds.origin.x);
        Some((((canvas_x + s.scroll_x) / total) as f64 * duration).clamp(0.0, duration))
    }

    /// The waveform at `time`.
    pub fn element(&self, time: f64, duration: f64, height: Pixels) -> impl IntoElement {
        let wave = self.clone();
        let bars = self.bars();
        canvas(
            move |bounds, _, _| bounds,
            move |_, bounds, window, _| {
                wave.bounds.set(Some(bounds));
                let width = f32::from(bounds.size.width);
                if (wave.width.get() - width).abs() > 1.0 {
                    // Next frame picks the bar count for this width.
                    wave.width.set(width);
                    window.refresh();
                }
                let h = f32::from(bounds.size.height);
                let center = h / 2.0;
                let max_half = center * 0.88;
                let s = scroll_state(time, duration, bars.len(), width);
                let playhead = s.playhead_px - s.scroll_x;
                if playhead > 0.0 {
                    window.paint_quad(fill(
                        Bounds::new(bounds.origin, size(px(playhead.min(width)), bounds.size.height)),
                        rgba(0x00000040),
                    ));
                }
                if bars.is_empty() {
                    return;
                }
                let first = (s.scroll_x / BAR_STRIDE).floor() as usize;
                let last = (((s.scroll_x + width) / BAR_STRIDE).ceil() as usize).min(bars.len() - 1);
                for i in first..=last {
                    let x = i as f32 * BAR_STRIDE - s.scroll_x;
                    let half = (bars[i] * max_half).max(2.0);
                    let color = if i <= s.played_bar { theme::accent() } else { theme::surface() };
                    window.paint_quad(
                        fill(
                            Bounds::new(
                                point(bounds.origin.x + px(x), bounds.origin.y + px(center - half)),
                                size(px(BAR_WIDTH), px(half * 2.0)),
                            ),
                            color,
                        )
                        .corner_radii(px(1.0)),
                    );
                }
                if (0.0..=width).contains(&playhead) {
                    window.paint_quad(fill(
                        Bounds::new(
                            point(bounds.origin.x + px(playhead.round() - 1.0), bounds.origin.y),
                            size(px(2.0), bounds.size.height),
                        ),
                        theme::accent(),
                    ));
                }
            },
        )
        .w_full()
        .h(height)
    }
}

/// `m:ss`.
pub fn clock(secs: f64) -> String {
    let s = secs.max(0.0) as u64;
    format!("{}:{:02}", s / 60, s % 60)
}

#[cfg(test)]
mod tests {
    use super::{num_bars, scroll_state};

    #[test]
    fn bars_and_scroll_match_electron() {
        assert_eq!(num_bars(10.0, 600.0), 200);
        assert_eq!(num_bars(1000.0, 600.0), 6000);
        assert_eq!(num_bars(1.0, 600.0), 120);
        // Playhead sticks to the middle once past it.
        let s = scroll_state(5.0, 10.0, 200, 600.0);
        assert!((s.playhead_px - 500.0).abs() < 1e-3 && (s.scroll_x - 200.0).abs() < 1e-3);
        assert_eq!(s.played_bar, 100);
    }
}
