import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  grenadeKind,
  type GrenadeEvent,
  type GrenadeKind,
  type GrenadePosition,
  type InfernoSample,
  type MatchEvent,
  type PlayerFrame,
  type Position,
  type Round,
  type Shot,
} from './types'

/** tick -> steamid -> position */
type PositionMap = Map<number, Map<string, Position>>

type Options = {
  matchId: string
  roundIndex: number
  initialTick: number
  roundStartTick: number
  roundEndTick: number
  isFullGame: boolean
  allRounds: Round[]
}

/** A thrown grenade's lifetime: its flight path and when it went off. */
export type GrenadeTrack = {
  id: number
  kind: GrenadeKind
  team: string | null
  /** Flight samples, by tick. */
  path: GrenadePosition[]
  /** When it detonated (or Infinity if it never did in the data we have). */
  detonate: number
}

/** A lingering effect on the ground: a smoke, a fire, a decoy. */
export type AreaEffect = {
  kind: 'smoke' | 'fire' | 'decoy'
  start: number
  end: number
  x: number
  y: number
  z: number
  team: string | null
  /** For fires: the entity whose polygons to draw. */
  entityId?: number
}

export type Blast = { kind: 'he' | 'flash'; tick: number; x: number; y: number; z: number }

/** Largest index i with arr[i] <= v, or -1. */
function floorIndex(arr: number[], v: number): number {
  let lo = 0
  let hi = arr.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (arr[mid] <= v) {
      ans = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return ans
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = ((b - a + 540) % 360) - 180
  return a + d * t
}

const DEFAULT_SMOKE_SECONDS = 20
const DEFAULT_DECOY_SECONDS = 15
const DEFAULT_FIRE_SECONDS = 7

export function useMatchReplay(opts: Options) {
  const { matchId, roundIndex, initialTick, roundStartTick, roundEndTick, isFullGame, allRounds } = opts

  const [allPositions, setAllPositions] = useState<PositionMap>(new Map())
  const [events, setEvents] = useState<MatchEvent[]>([])
  const [shots, setShots] = useState<Shot[]>([])
  const [grenadePositions, setGrenadePositions] = useState<GrenadePosition[]>([])
  const [grenadeEvents, setGrenadeEvents] = useState<GrenadeEvent[]>([])
  const [infernoPositions, setInfernoPositions] = useState<InfernoSample[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingRounds, setLoadingRounds] = useState<Set<number>>(new Set())

  const loadedRoundsRef = useRef<Set<number>>(new Set())
  const loadingRoundsRef = useRef<Set<number>>(new Set())

  const minTick = isFullGame && allRounds.length > 0 ? allRounds[0].startTick : roundStartTick
  const maxTick = isFullGame && allRounds.length > 0 ? allRounds[allRounds.length - 1].endTick : roundEndTick

  const roundAt = useCallback(
    (tick: number): Round | undefined => {
      if (allRounds.length === 0) return undefined
      return allRounds.find((r) => tick >= r.startTick && tick <= r.endTick)
    },
    [allRounds],
  )

  /** The round a tick belongs to, falling back to the last one that started before it. */
  const roundNear = useCallback(
    (tick: number): Round | undefined => {
      const inside = roundAt(tick)
      if (inside) return inside
      let best: Round | undefined
      for (const r of allRounds) if (r.startTick <= tick) best = r
      return best ?? allRounds[0]
    },
    [allRounds, roundAt],
  )

  // ---------- loading ----------

  const loadRoundData = useCallback(
    async (roundIdx: number) => {
      const api = window.electronAPI
      if (!api || loadedRoundsRef.current.has(roundIdx) || loadingRoundsRef.current.has(roundIdx)) return
      loadingRoundsRef.current.add(roundIdx)
      setLoadingRounds(new Set(loadingRoundsRef.current))
      try {
        const round = allRounds.find((r) => r.roundIndex === roundIdx)
        const startTick = round?.startTick ?? roundStartTick
        const endTick = round?.endTick ?? roundEndTick
        const [positionsData, eventsData, grenadePosData, grenadeEventsData, shotsData, infernoData] = await Promise.all([
          api.getMatchPositionsForRound(matchId, roundIdx),
          api.getMatchEvents(matchId, { round: roundIdx }),
          api.getGrenadePositionsForRound(matchId, roundIdx),
          api.getGrenadeEventsForRound(matchId, roundIdx),
          (api as any).getShotsForRound(matchId, roundIdx),
          api.getInfernoPositionsForRound(matchId, startTick, endTick),
        ])
        setAllPositions((prev) => {
          const next = new Map(prev)
          for (const pos of (positionsData.positions ?? []) as unknown as Position[]) {
            let m = next.get(pos.tick)
            if (!m) {
              m = new Map()
              next.set(pos.tick, m)
            }
            m.set(pos.steamid, pos)
          }
          return next
        })
        setEvents((prev) => [...prev, ...(eventsData?.events ?? [])])
        setGrenadePositions((prev) => [...prev, ...(grenadePosData?.positions ?? [])])
        setGrenadeEvents((prev) => [...prev, ...(grenadeEventsData?.events ?? [])])
        setShots((prev) => [...prev, ...(shotsData?.shots ?? [])])
        setInfernoPositions((prev) => [...prev, ...((infernoData as any)?.positions ?? [])])
        loadedRoundsRef.current.add(roundIdx)
      } catch (err) {
        console.error(`Failed to load round ${roundIdx}:`, err)
      } finally {
        loadingRoundsRef.current.delete(roundIdx)
        setLoadingRounds(new Set(loadingRoundsRef.current))
      }
    },
    [matchId, allRounds, roundStartTick, roundEndTick],
  )

  // initial load: the round in view and its neighbours
  useEffect(() => {
    let cancelled = false
    const run = async () => {
      setLoading(true)
      try {
        if (isFullGame && allRounds.length > 0) {
          const current = roundNear(initialTick) ?? allRounds[0]
          const i = allRounds.indexOf(current)
          const wanted = [allRounds[i - 1], current, allRounds[i + 1]].filter(Boolean).map((r) => r!.roundIndex)
          await Promise.all(wanted.map(loadRoundData))
        } else {
          await loadRoundData(roundIndex)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [matchId, roundIndex, isFullGame, allRounds, initialTick, loadRoundData, roundNear])

  /** Keeps the round at `tick` and its neighbours loaded, dropping the rest (full-game mode only). */
  const ensureAround = useCallback(
    (tick: number) => {
      if (!isFullGame || allRounds.length === 0) return
      const current = roundNear(tick)
      if (!current) return
      const i = allRounds.indexOf(current)
      const keep = new Set([allRounds[i - 1], current, allRounds[i + 1]].filter(Boolean).map((r) => r!.roundIndex))
      for (const idx of keep) void loadRoundData(idx)

      const drop = [...loadedRoundsRef.current].filter((r) => !keep.has(r))
      if (drop.length === 0) return
      drop.forEach((r) => loadedRoundsRef.current.delete(r))
      const ranges = allRounds.filter((r) => loadedRoundsRef.current.has(r.roundIndex) || keep.has(r.roundIndex))
      const inKept = (t: number) => ranges.some((r) => t >= r.startTick && t <= r.endTick)
      const dropped = new Set(drop)
      setAllPositions((prev) => {
        const next: PositionMap = new Map()
        for (const [t, m] of prev) if (inKept(t)) next.set(t, m)
        return next
      })
      setGrenadePositions((prev) => prev.filter((g) => inKept(g.tick)))
      setGrenadeEvents((prev) => prev.filter((g) => inKept(g.tick)))
      setShots((prev) => prev.filter((s) => inKept(s.tick)))
      setInfernoPositions((prev) => prev.filter((s) => inKept(s.tick)))
      setEvents((prev) => prev.filter((e) => !dropped.has(e.roundIndex)))
    },
    [isFullGame, allRounds, roundNear, loadRoundData],
  )

  // ---------- indexes ----------

  const sortedTicks = useMemo(() => [...allPositions.keys()].sort((a, b) => a - b), [allPositions])

  /** Every player seen, with their latest known name and team. */
  const roster = useMemo(() => {
    const out = new Map<string, { steamid: string; name: string; team: string | null }>()
    for (let i = sortedTicks.length - 1; i >= 0; i--) {
      for (const p of allPositions.get(sortedTicks[i])!.values()) {
        if (!out.has(p.steamid)) out.set(p.steamid, { steamid: p.steamid, name: p.name || p.steamid, team: p.team })
      }
    }
    return out
  }, [allPositions, sortedTicks])

  /** The tick to sample at: freeze time and round gaps snap to spawn/end positions. */
  const resolveTick = useCallback(
    (tick: number): { tick: number; snapped: boolean } => {
      if (isFullGame && allRounds.length > 0) {
        const r = roundAt(tick)
        if (r) {
          const freezeEnd = r.freezeEndTick || r.startTick
          if (tick < freezeEnd) return { tick: r.startTick, snapped: true }
          if (tick >= r.endTick) return { tick: r.endTick, snapped: true }
          return { tick, snapped: false }
        }
        const next = allRounds.find((x) => x.startTick > tick)
        if (next) return { tick: next.startTick, snapped: true }
        return { tick: allRounds[allRounds.length - 1].endTick, snapped: true }
      }
      if (tick >= roundEndTick) return { tick: roundEndTick, snapped: true }
      if (tick <= roundStartTick) return { tick: roundStartTick, snapped: true }
      return { tick, snapped: false }
    },
    [isFullGame, allRounds, roundAt, roundStartTick, roundEndTick],
  )

  /** One player's interpolated position at a raw (unresolved) tick. */
  const positionAt = useCallback(
    (steamid: string, rawTick: number, resolved?: { tick: number; snapped: boolean }): Position | null => {
      if (sortedTicks.length === 0) return null
      const { tick, snapped } = resolved ?? resolveTick(rawTick)
      const li = floorIndex(sortedTicks, tick)
      const lowerTick = li >= 0 ? sortedTicks[li] : undefined
      const upperTick = lowerTick === tick ? tick : sortedTicks[li + 1]
      const lower = lowerTick !== undefined ? allPositions.get(lowerTick)?.get(steamid) : undefined
      const upper = upperTick !== undefined ? allPositions.get(upperTick)?.get(steamid) : undefined
      if (lowerTick === tick && lower) return lower
      if (snapped) return upper ?? lower ?? null
      if (!lower || !upper) return lower ?? upper ?? null
      const span = upperTick! - lowerTick!
      if (span <= 0) return lower
      const t = (tick - lowerTick!) / span
      const near = t < 0.5 ? lower : upper
      return {
        ...near,
        tick,
        x: lower.x + (upper.x - lower.x) * t,
        y: lower.y + (upper.y - lower.y) * t,
        z: lower.z + (upper.z - lower.z) * t,
        yaw: lower.yaw != null && upper.yaw != null ? lerpAngle(lower.yaw, upper.yaw, t) : near.yaw,
        team: lower.team || upper.team,
        name: lower.name || upper.name,
      }
    },
    [allPositions, sortedTicks, resolveTick],
  )

  /** Whether a player counts as dead (with a grace period around spawns, when health reads 0). */
  const isAliveAt = useCallback(
    (p: Position, tick: number): boolean => {
      if (p.health !== null && p.health > 0) return true
      if (isFullGame && allRounds.length > 0) {
        const r = roundAt(tick)
        if (r) {
          const freezeEnd = r.freezeEndTick || r.startTick
          if (tick - freezeEnd < 320) return true
        } else {
          const next = allRounds.find((x) => tick < x.startTick)
          if (next && (next.freezeEndTick || next.startTick) - tick < 320) return true
        }
      }
      return false
    },
    [isFullGame, allRounds, roundAt],
  )

  /** Everyone at a tick. */
  const playersAt = useCallback(
    (rawTick: number): PlayerFrame[] => {
      const resolved = resolveTick(rawTick)
      const out: PlayerFrame[] = []
      for (const steamid of roster.keys()) {
        const p = positionAt(steamid, rawTick, resolved)
        if (p) out.push({ ...p, alive: isAliveAt(p, rawTick) })
      }
      return out
    },
    [roster, positionAt, resolveTick, isAliveAt],
  )

  /** A player's path over [from, to], straight from the samples. */
  const pathBetween = useCallback(
    (steamid: string, from: number, to: number): Position[] => {
      const out: Position[] = []
      let i = Math.max(0, floorIndex(sortedTicks, from))
      for (; i < sortedTicks.length && sortedTicks[i] <= to; i++) {
        const p = allPositions.get(sortedTicks[i])?.get(steamid)
        if (p) out.push(p)
      }
      return out
    },
    [allPositions, sortedTicks],
  )

  // ---------- utility ----------

  const grenadeTracks = useMemo<GrenadeTrack[]>(() => {
    const byId = new Map<number, GrenadePosition[]>()
    for (const g of grenadePositions) {
      let arr = byId.get(g.projectileId)
      if (!arr) byId.set(g.projectileId, (arr = []))
      arr.push(g)
    }
    const evByProjectile = new Map<number, GrenadeEvent[]>()
    const infernoStarts: GrenadeEvent[] = []
    for (const e of grenadeEvents) {
      if (e.eventType === 'inferno_start') infernoStarts.push(e)
      let arr = evByProjectile.get(e.projectileId)
      if (!arr) evByProjectile.set(e.projectileId, (arr = []))
      arr.push(e)
    }
    const detonationTypes: Record<string, string[]> = {
      smoke: ['smoke_start', 'smoke_end'],
      he: ['he_explode'],
      flash: ['flash_explode'],
      decoy: ['decoy_start'],
    }
    const tracks: GrenadeTrack[] = []
    for (const [id, path] of byId) {
      path.sort((a, b) => a.tick - b.tick)
      const kind = grenadeKind(path[0].grenadeName)
      const first = path[0].tick
      let detonate = Infinity
      if (kind === 'fire') {
        // inferno events carry the fire's own id, not the projectile's: match on thrower and time
        for (const e of infernoStarts) {
          if (e.throwerSteamId === path[0].throwerSteamId && e.tick >= first && e.tick < detonate) detonate = e.tick
        }
      } else {
        const types = detonationTypes[kind] ?? []
        for (const e of evByProjectile.get(id) ?? []) {
          if (types.includes(e.eventType) && e.tick < detonate) detonate = e.tick
        }
      }
      tracks.push({ id, kind, team: path[0].throwerTeam, path, detonate })
    }
    return tracks
  }, [grenadePositions, grenadeEvents])

  const areaEffects = useMemo<AreaEffect[]>(() => {
    const sorted = [...grenadeEvents].sort((a, b) => a.tick - b.tick)
    const effects: AreaEffect[] = []
    const used = new Set<GrenadeEvent>()
    const findEnd = (start: GrenadeEvent, type: string, match: (e: GrenadeEvent) => boolean) => {
      const e = sorted.find((x) => !used.has(x) && x.eventType === type && x.tick >= start.tick && match(x))
      if (e) used.add(e)
      return e
    }
    for (const e of sorted) {
      if (e.eventType === 'smoke_start') {
        const end = findEnd(e, 'smoke_expire', (x) => x.projectileId === e.projectileId || x.throwerSteamId === e.throwerSteamId)
        effects.push({ kind: 'smoke', start: e.tick, end: end?.tick ?? e.tick + DEFAULT_SMOKE_SECONDS * 64, x: e.x, y: e.y, z: e.z, team: e.throwerTeam })
      } else if (e.eventType === 'inferno_start') {
        const end = findEnd(e, 'inferno_expire', (x) => x.projectileId === e.projectileId)
        effects.push({ kind: 'fire', start: e.tick, end: end?.tick ?? e.tick + DEFAULT_FIRE_SECONDS * 64, x: e.x, y: e.y, z: e.z, team: e.throwerTeam, entityId: e.projectileId })
      } else if (e.eventType === 'decoy_start') {
        const end = findEnd(e, 'decoy_expire', (x) => x.projectileId === e.projectileId || x.throwerSteamId === e.throwerSteamId)
        effects.push({ kind: 'decoy', start: e.tick, end: end?.tick ?? e.tick + DEFAULT_DECOY_SECONDS * 64, x: e.x, y: e.y, z: e.z, team: e.throwerTeam })
      }
    }
    return effects
  }, [grenadeEvents])

  const blasts = useMemo<Blast[]>(
    () =>
      grenadeEvents
        .filter((e) => e.eventType === 'he_explode' || e.eventType === 'flash_explode')
        .map((e) => ({ kind: e.eventType === 'he_explode' ? 'he' : 'flash', tick: e.tick, x: e.x, y: e.y, z: e.z })),
    [grenadeEvents],
  )

  /** Fire polygons by entity, sorted by tick. */
  const infernoByEntity = useMemo(() => {
    const m = new Map<number, InfernoSample[]>()
    for (const s of infernoPositions) {
      let arr = m.get(s.entityId)
      if (!arr) m.set(s.entityId, (arr = []))
      arr.push(s)
    }
    for (const arr of m.values()) arr.sort((a, b) => a.tick - b.tick)
    return m
  }, [infernoPositions])

  const sortedShots = useMemo(() => [...shots].sort((a, b) => a.tick - b.tick), [shots])
  const shotTicks = useMemo(() => sortedShots.map((s) => s.tick), [sortedShots])

  /** Shots fired in (from, to]. */
  const shotsBetween = useCallback(
    (from: number, to: number): Shot[] => {
      const out: Shot[] = []
      for (let i = floorIndex(shotTicks, from) + 1; i < sortedShots.length && sortedShots[i].tick <= to; i++) out.push(sortedShots[i])
      return out
    },
    [sortedShots, shotTicks],
  )

  return {
    loading,
    loadingRounds,
    minTick,
    maxTick,
    events,
    roster,
    roundAt,
    roundNear,
    ensureAround,
    positionAt,
    playersAt,
    pathBetween,
    grenadeTracks,
    areaEffects,
    blasts,
    infernoByEntity,
    shotsBetween,
    hasPositions: sortedTicks.length > 0,
  }
}

export type MatchReplay = ReturnType<typeof useMatchReplay>
