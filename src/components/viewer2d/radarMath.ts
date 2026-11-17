/** A box of the game world in game units ({min,max} of x, y, z). */
export type MapBounds = { min: [number, number, number]; max: [number, number, number] }

/** Maps game x/y onto a canvas: north up, the bounds fitted and centred. */
export type RadarView = {
  /** Canvas pixels per game unit. */
  scale: number
  toCanvas(x: number, y: number): [number, number]
  toGame(px: number, py: number): [number, number]
}

/** Fits the bounds' x/y extent into a width × height canvas with `pad` pixels on each side. */
export function fitView(bounds: MapBounds, width: number, height: number, pad = 0): RadarView {
  const dx = Math.max(1, bounds.max[0] - bounds.min[0])
  const dy = Math.max(1, bounds.max[1] - bounds.min[1])
  const scale = Math.max(0, Math.min((width - 2 * pad) / dx, (height - 2 * pad) / dy))
  const ox = (width - dx * scale) / 2
  const oy = (height - dy * scale) / 2
  const minX = bounds.min[0]
  const maxY = bounds.max[1]
  return {
    scale,
    toCanvas: (x, y) => [ox + (x - minX) * scale, oy + (maxY - y) * scale],
    toGame: (px, py) => [minX + (px - ox) / (scale || 1), maxY - (py - oy) / (scale || 1)],
  }
}

/** A game yaw (degrees, 0 = +x, 90 = +y) as a canvas angle (radians, y down). */
export const yawToCanvas = (yawDeg: number) => (-yawDeg * Math.PI) / 180

/** Zoom and pan over the fitted view, in canvas pixels: screen = fitted * zoom + (x, y). */
export type ViewTransform = { zoom: number; x: number; y: number }

export const IDENTITY: ViewTransform = { zoom: 1, x: 0, y: 0 }
export const MIN_ZOOM = 1
export const MAX_ZOOM = 8

/** The fitted view with a zoom and pan applied. */
export function transformView(base: RadarView, t: ViewTransform): RadarView {
  return {
    scale: base.scale * t.zoom,
    toCanvas: (x, y) => {
      const [px, py] = base.toCanvas(x, y)
      return [px * t.zoom + t.x, py * t.zoom + t.y]
    },
    toGame: (px, py) => base.toGame((px - t.x) / t.zoom, (py - t.y) / t.zoom),
  }
}

/** Keeps the zoom in range and the zoomed canvas covering the viewport (no empty edges). */
export function clampTransform(t: ViewTransform, width: number, height: number): ViewTransform {
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, t.zoom))
  const clamp = (v: number, size: number) => Math.min(0, Math.max(size - size * zoom, v))
  return { zoom, x: clamp(t.x, width), y: clamp(t.y, height) }
}

/** Zooms by `factor` keeping the canvas point (px, py) where it is. */
export function zoomAt(t: ViewTransform, factor: number, px: number, py: number, width: number, height: number): ViewTransform {
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, t.zoom * factor))
  const k = zoom / t.zoom
  return clampTransform({ zoom, x: px - (px - t.x) * k, y: py - (py - t.y) * k }, width, height)
}

/** The transform that puts fitted-canvas point (px, py) in the middle of the viewport at `zoom`. */
export function centreOn(px: number, py: number, zoom: number, width: number, height: number): ViewTransform {
  return clampTransform({ zoom, x: width / 2 - px * zoom, y: height / 2 - py * zoom }, width, height)
}

/** m:ss for a clock. */
export function mmss(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
