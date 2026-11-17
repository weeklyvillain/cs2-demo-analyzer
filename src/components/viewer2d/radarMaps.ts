import type { MapBounds } from './radarMath'

/** One floor of a map: the heights it covers and its radar image (in resources/radars, no extension). */
export type MapLevel = { name: string; min: number; max: number; image: string }

/**
 * A CS2 radar's calibration, as the game's overview files give it: the image's
 * top-left corner in game units and the game units per image pixel.
 */
export type RadarMapInfo = { x: number; y: number; scale: number; levels: MapLevel[] }

/** The radar images are 1024 × 1024. */
export const RADAR_PX = 1024

const one = (image: string): MapLevel[] => [{ name: '', min: -Infinity, max: Infinity, image }]

/**
 * Calibrations from cs-demo-manager's CS2 table (shared with the Kryos 2D
 * replay). Nuke and Vertigo split into two floors at the heights CS2's own
 * radar switches at. Train has a lower image too, but no agreed split height
 * yet, so it stays on one floor.
 */
export const RADAR_MAPS: Record<string, RadarMapInfo> = {
  de_ancient: { x: -2953, y: 2164, scale: 5, levels: one('de_ancient') },
  de_anubis: { x: -2796, y: 3328, scale: 5.22, levels: one('de_anubis') },
  de_cache: { x: -2000, y: 3250, scale: 5.5, levels: one('de_cache') },
  de_cache_b: { x: -2000, y: 3250, scale: 5.5, levels: one('de_cache_b') },
  de_cbble_d: { x: -3800, y: 3050, scale: 6.2, levels: one('de_cbble_d') },
  de_dust2: { x: -2476, y: 3239, scale: 4.4, levels: one('de_dust2') },
  de_inferno: { x: -2087, y: 3870, scale: 4.9, levels: one('de_inferno') },
  de_mirage: { x: -3230, y: 1713, scale: 5, levels: one('de_mirage') },
  de_nuke: {
    x: -3453,
    y: 2887,
    scale: 7,
    levels: [
      { name: 'Upper', min: -495, max: Infinity, image: 'de_nuke' },
      { name: 'Lower', min: -Infinity, max: -495, image: 'de_nuke_lower' },
    ],
  },
  de_overpass: { x: -4831, y: 1781, scale: 5.2, levels: one('de_overpass') },
  de_train: { x: -2308, y: 2078, scale: 4.082077, levels: one('de_train') },
  de_vertigo: {
    x: -3168,
    y: 1762,
    scale: 4,
    levels: [
      { name: 'Upper', min: 11700, max: Infinity, image: 'de_vertigo' },
      { name: 'Lower', min: -Infinity, max: 11700, image: 'de_vertigo_lower' },
    ],
  },
}

/** Accepts "de_mirage", "mirage" or any casing. */
export function radarMapFor(map: string | undefined | null): RadarMapInfo | undefined {
  if (!map) return undefined
  const lower = map.toLowerCase()
  return RADAR_MAPS[lower] ?? RADAR_MAPS[`de_${lower}`]
}

/** "de_mirage" → "Mirage". */
export function prettyMapName(map: string): string {
  const base = map.toLowerCase().replace(/^(de|cs|ar)_/, '').replace(/_/g, ' ')
  return base.replace(/\b\w/g, (c) => c.toUpperCase())
}

/** The square of the game world the radar image covers (z unbounded). */
export function radarBounds(info: RadarMapInfo): MapBounds {
  const size = RADAR_PX * info.scale
  return { min: [info.x, info.y - size, -Infinity], max: [info.x + size, info.y, Infinity] }
}

/** The level a height is on (the nearest one when it's between them). */
export function levelIndexAt(levels: MapLevel[], z: number): number {
  const i = levels.findIndex((l) => z >= l.min && z < l.max)
  if (i >= 0) return i
  let best = 0
  let bestD = Infinity
  levels.forEach((l, j) => {
    const d = z < l.min ? l.min - z : z - l.max
    if (d < bestD) {
      bestD = d
      best = j
    }
  })
  return best
}
