import { useEffect, useState } from 'react'

type RGB = [number, number, number]

/** The radar's colours, picked to sit on the analyzer's charcoal surfaces. */
export type RadarPalette = {
  /** The lowest and highest walkable tone; the image's brightness picks between them. */
  low: RGB
  high: RGB
  /** Walls and other dark marks inside the map. */
  line: RGB
  /** The one outline around everything walkable. */
  outline: RGB
}

export const RADAR_PALETTE: RadarPalette = {
  low: [0x2a, 0x2d, 0x33],
  high: [0x4a, 0x4f, 0x58],
  line: [0x17, 0x19, 0x1c],
  outline: [0x6b, 0x70, 0x7a],
}

/** How many flat tones the walkable area is drawn in. */
const STEPS = 6
/** A pixel darker than this share of the map's median brightness is a wall line. */
const LINE_SHARE = 0.5

function percentile(hist: Uint32Array, total: number, p: number): number {
  let seen = 0
  for (let i = 0; i < hist.length; i++) {
    seen += hist[i]
    if (seen >= total * p) return i
  }
  return hist.length - 1
}

/**
 * Recolours a radar image into flat tones: what the image marks as walkable
 * (its alpha) becomes stepped greys picked by its brightness, marks much darker
 * than the map around them become wall lines, and an outline `outlineWidth`
 * pixels wide runs around every edge. Everything else is transparent.
 * (Ported from the Kryos 2D replay.)
 */
export function styleRadarPixels(
  src: Uint8ClampedArray,
  width: number,
  height: number,
  palette: RadarPalette = RADAR_PALETTE,
  outlineWidth = 2,
): Uint8ClampedArray<ArrayBuffer> {
  const n = width * height
  const inside = new Uint8Array(n)
  const lum = new Uint8Array(n)
  const hist = new Uint32Array(256)
  let count = 0
  for (let i = 0; i < n; i++) {
    if (src[i * 4 + 3] < 128) continue
    inside[i] = 1
    const l = Math.round(0.2126 * src[i * 4] + 0.7152 * src[i * 4 + 1] + 0.0722 * src[i * 4 + 2])
    lum[i] = l
    hist[l]++
    count++
  }
  const lineCut = percentile(hist, count, 0.5) * LINE_SHARE
  // the tones span the map's own brightness range, walls aside
  let lo = 0
  for (let seen = 0, i = 0; i < 256; i++) {
    if (i < lineCut) continue
    seen += hist[i]
    if (seen >= count * 0.03) {
      lo = i
      break
    }
  }
  const hi = Math.max(lo + 1, percentile(hist, count, 0.97))

  // the outline: everything within outlineWidth of the map (a square dilation, rows then columns)
  const rows = new Uint8Array(n)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let hit = 0
      for (let d = -outlineWidth; d <= outlineWidth && !hit; d++) {
        const xx = x + d
        if (xx >= 0 && xx < width && inside[y * width + xx]) hit = 1
      }
      rows[y * width + x] = hit
    }
  }
  const near = new Uint8Array(n)
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      let hit = 0
      for (let d = -outlineWidth; d <= outlineWidth && !hit; d++) {
        const yy = y + d
        if (yy >= 0 && yy < height && rows[yy * width + x]) hit = 1
      }
      near[y * width + x] = hit
    }
  }

  const out = new Uint8ClampedArray(n * 4)
  const put = (i: number, c: RGB) => {
    out[i * 4] = c[0]
    out[i * 4 + 1] = c[1]
    out[i * 4 + 2] = c[2]
    out[i * 4 + 3] = 255
  }
  for (let i = 0; i < n; i++) {
    if (inside[i]) {
      if (lum[i] < lineCut) {
        put(i, palette.line)
      } else {
        const t = Math.min(1, Math.max(0, (lum[i] - lo) / (hi - lo)))
        const step = Math.round(t * (STEPS - 1)) / (STEPS - 1)
        put(i, [
          Math.round(palette.low[0] + (palette.high[0] - palette.low[0]) * step),
          Math.round(palette.low[1] + (palette.high[1] - palette.low[1]) * step),
          Math.round(palette.low[2] + (palette.high[2] - palette.low[2]) * step),
        ])
      }
    } else if (near[i]) {
      put(i, palette.outline)
    }
  }
  return out
}

/** Which look the radar is drawn in. */
export type RadarStyle = 'flat' | 'original'

type Art = { flat: HTMLCanvasElement; original: HTMLCanvasElement }
const cache = new Map<string, Promise<Art | null>>()

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.decoding = 'async'
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = src
  })
}

/** Loads a radar image over IPC and makes both looks of it; cached per image, null when it can't load. */
export function loadRadarArt(image: string): Promise<Art | null> {
  let p = cache.get(image)
  if (!p) {
    p = (async () => {
      const api = window.electronAPI
      if (!api) return null
      const res = await api.getRadarImage(image).catch(() => null)
      if (!res?.success || !res.data) return null
      const img = await loadImage(res.data)
      if (!img) return null
      const original = document.createElement('canvas')
      original.width = img.naturalWidth
      original.height = img.naturalHeight
      original.getContext('2d')?.drawImage(img, 0, 0)
      const flat = document.createElement('canvas')
      flat.width = img.naturalWidth
      flat.height = img.naturalHeight
      const ctx = flat.getContext('2d', { willReadFrequently: true })
      if (!ctx) return { flat: original, original }
      ctx.drawImage(img, 0, 0)
      const data = ctx.getImageData(0, 0, flat.width, flat.height)
      const styled = styleRadarPixels(data.data, flat.width, flat.height)
      ctx.putImageData(new ImageData(styled, flat.width, flat.height), 0, 0)
      return { flat, original }
    })()
    // a failure isn't cached: a later visit tries again
    void p.then((a) => {
      if (!a) cache.delete(image)
    })
    cache.set(image, p)
  }
  return p
}

/** The radar art for an image: undefined while it loads, null when there is none. */
export function useRadarArt(image: string | undefined): Art | null | undefined {
  const [state, setState] = useState<{ image: string; art: Art | null } | null>(null)
  useEffect(() => {
    if (!image) return
    let cancelled = false
    void loadRadarArt(image).then((art) => {
      if (!cancelled) setState({ image, art })
    })
    return () => {
      cancelled = true
    }
  }, [image])
  if (!image) return null
  return state?.image === image ? state.art : undefined
}
