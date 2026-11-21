//! Radar images (Electron `radarArt.ts`): the original image and a "flat" restyle in
//! stepped greys with wall lines and an outline, decoded once and cached per image.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use gpui_kit::RenderImage;
use image::{Frame, RgbaImage};

#[derive(Clone)]
pub struct RadarArt {
    pub flat: Arc<RenderImage>,
    pub original: Arc<RenderImage>,
}

type Cache = Mutex<HashMap<String, Option<RadarArt>>>;

fn cache() -> &'static Cache {
    static CACHE: OnceLock<Cache> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Already-decoded art, if any (`Some(None)` = tried and there is none).
pub fn cached(image: &str) -> Option<Option<RadarArt>> {
    cache().lock().unwrap().get(image).cloned()
}

/// Decode and restyle `resources/radars/<image>.png`. Slow-ish (tens of ms): call off the UI thread.
pub fn load(image: &str) -> Option<RadarArt> {
    if let Some(hit) = cached(image) {
        return hit;
    }
    let path = cs2da_core::paths::resources_dir().join("radars").join(format!("{image}.png"));
    let art = image::open(&path).ok().map(|img| {
        let rgba = img.to_rgba8();
        let flat = style_radar_pixels(&rgba, 2);
        RadarArt { flat: to_render_image(flat), original: to_render_image(rgba) }
    });
    // A failure isn't cached, so a later visit tries again (as in Electron).
    if art.is_some() {
        cache().lock().unwrap().insert(image.to_string(), art.clone());
    }
    art
}

/// GPUI wants BGRA.
fn to_render_image(mut img: RgbaImage) -> Arc<RenderImage> {
    for px in img.pixels_mut() {
        px.0.swap(0, 2);
    }
    Arc::new(RenderImage::new(vec![Frame::new(img)]))
}

type Rgb = [u8; 3];
const LOW: Rgb = [0x2a, 0x2d, 0x33];
const HIGH: Rgb = [0x4a, 0x4f, 0x58];
const LINE: Rgb = [0x17, 0x19, 0x1c];
const OUTLINE: Rgb = [0x6b, 0x70, 0x7a];
const STEPS: f32 = 6.0;
const LINE_SHARE: f32 = 0.5;

fn percentile(hist: &[u32; 256], total: u32, p: f32) -> usize {
    let mut seen = 0u32;
    for (i, n) in hist.iter().enumerate() {
        seen += n;
        if seen as f32 >= total as f32 * p {
            return i;
        }
    }
    255
}

/// Walkable pixels (alpha) become stepped greys by brightness, much darker marks become
/// wall lines, an outline `outline` px wide runs around every edge; the rest is transparent.
pub fn style_radar_pixels(src: &RgbaImage, outline: i32) -> RgbaImage {
    let (w, h) = (src.width() as i32, src.height() as i32);
    let n = (w * h) as usize;
    let raw = src.as_raw();
    let mut inside = vec![false; n];
    let mut lum = vec![0u8; n];
    let mut hist = [0u32; 256];
    let mut count = 0u32;
    for i in 0..n {
        if raw[i * 4 + 3] < 128 {
            continue;
        }
        inside[i] = true;
        let l = (0.2126 * raw[i * 4] as f32 + 0.7152 * raw[i * 4 + 1] as f32 + 0.0722 * raw[i * 4 + 2] as f32).round() as u8;
        lum[i] = l;
        hist[l as usize] += 1;
        count += 1;
    }
    let line_cut = percentile(&hist, count, 0.5) as f32 * LINE_SHARE;
    let mut lo = 0usize;
    let mut seen = 0u32;
    for (i, n) in hist.iter().enumerate() {
        if (i as f32) < line_cut {
            continue;
        }
        seen += n;
        if seen as f32 >= count as f32 * 0.03 {
            lo = i;
            break;
        }
    }
    let hi = (lo + 1).max(percentile(&hist, count, 0.97));

    // Square dilation, rows then columns.
    let mut rows = vec![false; n];
    for y in 0..h {
        for x in 0..w {
            rows[(y * w + x) as usize] =
                (-outline..=outline).any(|d| (0..w).contains(&(x + d)) && inside[(y * w + x + d) as usize]);
        }
    }
    let mut near = vec![false; n];
    for x in 0..w {
        for y in 0..h {
            near[(y * w + x) as usize] =
                (-outline..=outline).any(|d| (0..h).contains(&(y + d)) && rows[((y + d) * w + x) as usize]);
        }
    }

    let mut out = RgbaImage::new(w as u32, h as u32);
    let buf: &mut [u8] = &mut out;
    let mut put = |i: usize, c: Rgb| {
        buf[i * 4..i * 4 + 4].copy_from_slice(&[c[0], c[1], c[2], 255]);
    };
    for i in 0..n {
        if inside[i] {
            if (lum[i] as f32) < line_cut {
                put(i, LINE);
            } else {
                let t = ((lum[i] as f32 - lo as f32) / (hi - lo) as f32).clamp(0.0, 1.0);
                let step = (t * (STEPS - 1.0)).round() / (STEPS - 1.0);
                let mix = |a: u8, b: u8| (a as f32 + (b as f32 - a as f32) * step).round() as u8;
                put(i, [mix(LOW[0], HIGH[0]), mix(LOW[1], HIGH[1]), mix(LOW[2], HIGH[2])]);
            }
        } else if near[i] {
            put(i, OUTLINE);
        }
    }
    out
}
