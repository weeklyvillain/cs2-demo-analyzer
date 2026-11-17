import { RADAR_PX, type RadarMapInfo } from './radarMaps'
import { yawToCanvas, type RadarView } from './radarMath'
import type { MatchReplay } from './useMatchReplay'
import {
  GRENADE_COLORS,
  TICKRATE,
  grenadeKind,
  isKnife,
  isUtility,
  teamColor,
  type Layers,
  type MatchEvent,
  type PlayerFrame,
} from './types'

export type Scene = {
  view: RadarView
  dpr: number
  width: number
  height: number
  info?: RadarMapInfo
  art?: HTMLCanvasElement | null
  tick: number
  players: PlayerFrame[]
  layers: Layers
  selected: string | null
  hovered: string | null
  /** The round in view, so utility and trails don't leak across rounds. */
  roundStart: number
  roundEnd: number
  replay: MatchReplay
  /** Whether a height is on the floor shown; everything else is drawn faded. */
  onLevel: (z: number) => boolean
}

export const TOKEN_RADIUS = 9
const OFF_LEVEL_ALPHA = 0.25
const TRAIL_SECONDS = 3
const SHOT_TICKS = 8
const BLAST_TICKS = 28
const EVENT_WINDOW = 96

const SMOKE_R = 144
const FIRE_R = 120

const EVENT_STYLE: Record<string, { color: string; label: string }> = {
  team_kill: { color: '#ff4d5e', label: 'TK' },
  team_damage: { color: '#ff9a3d', label: 'TD' },
  team_flash: { color: '#ffe066', label: 'TF' },
}

function rgba(hex: string, a: number): string {
  const h = hex.replace('#', '')
  const n = parseInt(h.length === 3 ? h.replace(/(.)/g, '$1$1') : h.slice(0, 6), 16)
  if (Number.isNaN(n)) return hex
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`
}

export function drawScene(ctx: CanvasRenderingContext2D, s: Scene): void {
  const { view } = s
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, s.width, s.height)

  // map
  if (s.info && s.art) {
    const [x0, y0] = view.toCanvas(s.info.x, s.info.y)
    const size = RADAR_PX * s.info.scale * view.scale
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(s.art, x0, y0, size, size)
  } else {
    drawGrid(ctx, s)
  }

  if (s.layers.utility) drawUtility(ctx, s)
  if (s.layers.trails) drawTrails(ctx, s)
  if (s.layers.shots) drawShots(ctx, s)
  if (s.layers.events) drawEvents(ctx, s)
  drawPlayers(ctx, s)

  ctx.globalAlpha = 1
}

function drawGrid(ctx: CanvasRenderingContext2D, s: Scene): void {
  const step = 512
  const [gx0, gy0] = s.view.toGame(0, 0)
  const [gx1, gy1] = s.view.toGame(s.width, s.height)
  ctx.strokeStyle = 'rgba(255,255,255,0.05)'
  ctx.lineWidth = 1
  ctx.beginPath()
  for (let x = Math.floor(gx0 / step) * step; x <= gx1; x += step) {
    const [px] = s.view.toCanvas(x, 0)
    ctx.moveTo(px, 0)
    ctx.lineTo(px, s.height)
  }
  for (let y = Math.floor(gy1 / step) * step; y <= gy0; y += step) {
    const [, py] = s.view.toCanvas(0, y)
    ctx.moveTo(0, py)
    ctx.lineTo(s.width, py)
  }
  ctx.stroke()
}

function inRound(s: Scene, tick: number): boolean {
  return tick >= s.roundStart && tick <= s.roundEnd
}

function drawUtility(ctx: CanvasRenderingContext2D, s: Scene): void {
  const { view, dpr, tick, replay } = s
  const px = (u: number) => u * view.scale

  // lingering effects
  for (const e of replay.areaEffects) {
    if (tick < e.start || tick >= e.end || !inRound(s, e.start)) continue
    ctx.globalAlpha = s.onLevel(e.z) ? 1 : OFF_LEVEL_ALPHA
    const [x, y] = view.toCanvas(e.x, e.y)
    const age = (tick - e.start) / TICKRATE
    const left = (e.end - tick) / TICKRATE
    if (e.kind === 'smoke') {
      const grow = Math.min(1, 0.4 + age * 1.1)
      const fade = Math.min(1, left / 1.2)
      const r = px(SMOKE_R) * grow
      const grad = ctx.createRadialGradient(x, y, r * 0.2, x, y, r)
      grad.addColorStop(0, `rgba(205, 209, 216, ${0.55 * fade})`)
      grad.addColorStop(1, `rgba(170, 175, 184, ${0.35 * fade})`)
      ctx.fillStyle = grad
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fill()
      // remaining time, as a ring that empties clockwise
      const frac = Math.max(0, Math.min(1, (e.end - tick) / Math.max(1, e.end - e.start)))
      ctx.strokeStyle = rgba(teamColor(e.team), 0.85 * fade)
      ctx.lineWidth = 2 * dpr
      ctx.beginPath()
      ctx.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac)
      ctx.stroke()
    } else if (e.kind === 'fire') {
      const fade = Math.min(1, left / 0.8)
      const samples = e.entityId !== undefined ? replay.infernoByEntity.get(e.entityId) : undefined
      let poly: [number, number][] | undefined
      if (samples) {
        for (const smp of samples) {
          if (smp.tick > tick) break
          poly = smp.polygon
        }
      }
      ctx.fillStyle = `rgba(255, 106, 40, ${0.35 * fade})`
      ctx.strokeStyle = `rgba(255, 150, 70, ${0.9 * fade})`
      ctx.lineWidth = 1.5 * dpr
      ctx.beginPath()
      if (poly && poly.length >= 3) {
        poly.forEach(([gx, gy], i) => {
          const [cx, cy] = view.toCanvas(gx, gy)
          if (i === 0) ctx.moveTo(cx, cy)
          else ctx.lineTo(cx, cy)
        })
        ctx.closePath()
      } else {
        ctx.arc(x, y, px(FIRE_R) * Math.min(1, 0.4 + age * 1.5), 0, Math.PI * 2)
      }
      ctx.fill()
      ctx.stroke()
    } else {
      const pulse = 0.6 + 0.4 * Math.sin(age * 8)
      ctx.fillStyle = rgba(GRENADE_COLORS.decoy, 0.9)
      ctx.beginPath()
      ctx.arc(x, y, 3.5 * dpr, 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = rgba(GRENADE_COLORS.decoy, 0.5 * pulse)
      ctx.lineWidth = 1.5 * dpr
      ctx.beginPath()
      ctx.arc(x, y, (6 + 4 * pulse) * dpr, 0, Math.PI * 2)
      ctx.stroke()
    }
  }

  // HE and flash pops
  for (const b of replay.blasts) {
    const age = tick - b.tick
    if (age < 0 || age > BLAST_TICKS) continue
    const p = age / BLAST_TICKS
    const [x, y] = view.toCanvas(b.x, b.y)
    ctx.globalAlpha = (s.onLevel(b.z) ? 1 : OFF_LEVEL_ALPHA) * (1 - p)
    const color = b.kind === 'he' ? GRENADE_COLORS.he : GRENADE_COLORS.flash
    ctx.fillStyle = rgba(color, 0.25)
    ctx.strokeStyle = color
    ctx.lineWidth = 2 * dpr
    ctx.beginPath()
    ctx.arc(x, y, px(b.kind === 'he' ? 260 : 180) * (0.25 + 0.75 * p), 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
  }

  // grenades in the air
  for (const g of replay.grenadeTracks) {
    if (g.path.length === 0 || tick < g.path[0].tick || tick >= g.detonate) continue
    if (!inRound(s, g.path[0].tick)) continue
    const last = g.path[g.path.length - 1]
    if (tick > last.tick + TICKRATE / 2 && g.detonate === Infinity) continue
    const color = GRENADE_COLORS[g.kind]
    ctx.globalAlpha = 1
    ctx.strokeStyle = rgba(color, 0.7)
    ctx.lineWidth = 1.5 * dpr
    ctx.setLineDash([2 * dpr, 3 * dpr])
    ctx.beginPath()
    let head: [number, number] | null = null
    let headZ = g.path[0].z
    for (const p of g.path) {
      if (p.tick > tick) break
      const c = view.toCanvas(p.x, p.y)
      if (head) ctx.lineTo(c[0], c[1])
      else ctx.moveTo(c[0], c[1])
      head = c
      headZ = p.z
    }
    ctx.stroke()
    ctx.setLineDash([])
    if (head) {
      ctx.globalAlpha = s.onLevel(headZ) ? 1 : OFF_LEVEL_ALPHA
      ctx.fillStyle = color
      ctx.strokeStyle = '#111316'
      ctx.lineWidth = 1.5 * dpr
      ctx.beginPath()
      ctx.arc(head[0], head[1], 3.5 * dpr, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
    }
  }
  ctx.globalAlpha = 1
}

function drawTrails(ctx: CanvasRenderingContext2D, s: Scene): void {
  const { view, dpr, tick, replay } = s
  const from = Math.max(s.roundStart, tick - TRAIL_SECONDS * TICKRATE)
  ctx.lineCap = 'round'
  for (const p of s.players) {
    if (!p.alive || !s.onLevel(p.z)) continue
    const path = replay.pathBetween(p.steamid, from, tick)
    if (path.length < 2) continue
    const color = teamColor(p.team)
    const emph = p.steamid === s.selected
    let prev: [number, number] | null = null
    for (let i = 0; i < path.length; i++) {
      const c = view.toCanvas(path[i].x, path[i].y)
      if (prev && Math.hypot(c[0] - prev[0], c[1] - prev[1]) < 400 * view.scale) {
        const k = (path[i].tick - from) / Math.max(1, tick - from)
        ctx.strokeStyle = rgba(color, (emph ? 0.85 : 0.5) * k)
        ctx.lineWidth = (emph ? 3 : 2) * dpr
        ctx.beginPath()
        ctx.moveTo(prev[0], prev[1])
        ctx.lineTo(c[0], c[1])
        ctx.stroke()
      }
      prev = c
    }
  }
}

function drawShots(ctx: CanvasRenderingContext2D, s: Scene): void {
  const { view, dpr, tick, replay } = s
  const len = 650 * view.scale
  for (const shot of replay.shotsBetween(tick - SHOT_TICKS, tick)) {
    const age = (tick - shot.tick) / SHOT_TICKS
    const a = yawToCanvas(shot.yaw)
    const [x, y] = view.toCanvas(shot.x, shot.y)
    const sx = x + Math.cos(a) * TOKEN_RADIUS * dpr
    const sy = y + Math.sin(a) * TOKEN_RADIUS * dpr
    const reach = len * Math.min(1, 0.35 + age * 1.3)
    const grad = ctx.createLinearGradient(sx, sy, sx + Math.cos(a) * reach, sy + Math.sin(a) * reach)
    grad.addColorStop(0, rgba('#fff4d6', 0.9 * (1 - age)))
    grad.addColorStop(1, rgba('#fff4d6', 0))
    ctx.strokeStyle = grad
    ctx.lineWidth = 1.5 * dpr
    ctx.beginPath()
    ctx.moveTo(sx, sy)
    ctx.lineTo(sx + Math.cos(a) * reach, sy + Math.sin(a) * reach)
    ctx.stroke()
  }
}

function drawEvents(ctx: CanvasRenderingContext2D, s: Scene): void {
  const { view, dpr, tick, replay } = s
  for (const e of replay.events as MatchEvent[]) {
    const style = EVENT_STYLE[e.type?.toLowerCase()]
    if (!style) continue
    const d = tick - e.startTick
    if (d < -EVENT_WINDOW / 3 || d > EVENT_WINDOW) continue
    const who = e.victimSteamId ?? e.actorSteamId
    if (!who) continue
    const p = replay.positionAt(who, e.startTick)
    if (!p) continue
    const [x, y] = view.toCanvas(p.x, p.y)
    const k = Math.max(0, 1 - Math.abs(d) / EVENT_WINDOW)
    const pulse = ((tick % 32) / 32) * 1
    ctx.globalAlpha = k
    ctx.strokeStyle = style.color
    ctx.lineWidth = 2 * dpr
    ctx.beginPath()
    ctx.arc(x, y, (TOKEN_RADIUS + 6 + pulse * 10) * dpr, 0, Math.PI * 2)
    ctx.stroke()
    ctx.font = `700 ${10 * dpr}px ui-monospace, Consolas, monospace`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    const ty = y - (TOKEN_RADIUS + 22) * dpr
    const w = ctx.measureText(style.label).width + 8 * dpr
    ctx.fillStyle = style.color
    ctx.fillRect(x - w / 2, ty - 7 * dpr, w, 14 * dpr)
    ctx.fillStyle = '#16181b'
    ctx.fillText(style.label, x, ty + 0.5 * dpr)
  }
  ctx.globalAlpha = 1
}

function drawPlayers(ctx: CanvasRenderingContext2D, s: Scene): void {
  const { view, dpr } = s
  const R = TOKEN_RADIUS * dpr

  // the dead first, as faint crosses
  for (const p of s.players) {
    if (p.alive || !p.team) continue
    const [x, y] = view.toCanvas(p.x, p.y)
    const c = teamColor(p.team)
    ctx.globalAlpha = s.onLevel(p.z) ? 0.75 : OFF_LEVEL_ALPHA * 0.75
    const k = 4.5 * dpr
    ctx.lineCap = 'round'
    ctx.strokeStyle = '#111316'
    ctx.lineWidth = 4.5 * dpr
    ctx.beginPath()
    ctx.moveTo(x - k, y - k)
    ctx.lineTo(x + k, y + k)
    ctx.moveTo(x + k, y - k)
    ctx.lineTo(x - k, y + k)
    ctx.stroke()
    ctx.strokeStyle = c
    ctx.lineWidth = 2.2 * dpr
    ctx.stroke()
  }

  const rank = (p: PlayerFrame) => (p.steamid === s.selected ? 3 : p.steamid === s.hovered ? 2 : s.onLevel(p.z) ? 1 : 0)
  const alive = s.players.filter((p) => p.alive && p.team).sort((a, b) => rank(a) - rank(b))

  for (const p of alive) {
    const [x, y] = view.toCanvas(p.x, p.y)
    const c = teamColor(p.team)
    const here = s.onLevel(p.z)
    const sel = p.steamid === s.selected
    const hov = p.steamid === s.hovered
    ctx.globalAlpha = here || sel ? 1 : OFF_LEVEL_ALPHA

    // teardrop body: a circle drawn out to a point in the view direction
    const a = p.yaw != null ? yawToCanvas(p.yaw) : null
    ctx.beginPath()
    if (a !== null) {
      const tip = R * 1.75
      const spread = 0.62
      ctx.moveTo(x + Math.cos(a) * tip, y + Math.sin(a) * tip)
      ctx.arc(x, y, R, a + spread, a - spread + Math.PI * 2)
      ctx.closePath()
    } else {
      ctx.arc(x, y, R, 0, Math.PI * 2)
    }
    ctx.fillStyle = c
    ctx.fill()
    ctx.lineWidth = 2 * dpr
    ctx.strokeStyle = '#111316'
    ctx.stroke()

    // health ring inside the body
    const hp = Math.max(0, Math.min(100, p.health ?? 100))
    ctx.lineWidth = 2.2 * dpr
    ctx.strokeStyle = 'rgba(17, 19, 22, 0.55)'
    ctx.beginPath()
    ctx.arc(x, y, R * 0.58, 0, Math.PI * 2)
    ctx.stroke()
    if (hp > 0) {
      ctx.strokeStyle = hp <= 30 ? '#ff4d5e' : '#16181b'
      ctx.beginPath()
      ctx.arc(x, y, R * 0.58, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (hp / 100))
      ctx.stroke()
    }

    // what's in hand: utility gets its colour in the middle, a knife a white dot
    if (isUtility(p.weapon)) {
      ctx.fillStyle = GRENADE_COLORS[grenadeKind(p.weapon)]
      ctx.beginPath()
      ctx.arc(x, y, R * 0.3, 0, Math.PI * 2)
      ctx.fill()
    } else if (isKnife(p.weapon)) {
      ctx.fillStyle = '#ffffff'
      ctx.beginPath()
      ctx.arc(x, y, R * 0.18, 0, Math.PI * 2)
      ctx.fill()
    }

    if (sel || hov) {
      ctx.strokeStyle = sel ? '#ffffff' : 'rgba(255,255,255,0.6)'
      ctx.lineWidth = 1.5 * dpr
      ctx.setLineDash(sel ? [] : [3 * dpr, 3 * dpr])
      ctx.beginPath()
      ctx.arc(x, y, R + 5 * dpr, 0, Math.PI * 2)
      ctx.stroke()
      ctx.setLineDash([])
    }

    // name under the token, outlined so it reads over any floor
    if ((s.layers.names && here) || sel || hov) {
      const name = p.name || p.steamid
      ctx.font = `${sel ? 700 : 600} ${11 * dpr}px "Segoe UI", system-ui, sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'top'
      ctx.lineJoin = 'round'
      ctx.lineWidth = 3.5 * dpr
      ctx.strokeStyle = 'rgba(14, 15, 17, 0.9)'
      ctx.strokeText(name, x, y + R + 4 * dpr)
      ctx.fillStyle = sel ? '#ffffff' : '#dfe2e7'
      ctx.fillText(name, x, y + R + 4 * dpr)
    }
  }
  ctx.globalAlpha = 1
}

/** The living player under a canvas point, if any. */
export function hitPlayer(players: PlayerFrame[], view: RadarView, px: number, py: number, reach: number): string | null {
  let best: string | null = null
  let bestD = reach
  for (const p of players) {
    if (!p.alive || !p.team) continue
    const [x, y] = view.toCanvas(p.x, p.y)
    const d = Math.hypot(x - px, y - py)
    if (d <= bestD) {
      bestD = d
      best = p.steamid
    }
  }
  return best
}
