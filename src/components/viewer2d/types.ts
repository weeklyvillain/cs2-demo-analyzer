export const TICKRATE = 64

export interface Position {
  tick: number
  steamid: string
  x: number
  y: number
  z: number
  yaw: number | null
  team: string | null
  name: string | null
  health: number | null
  armor: number | null
  weapon: string | null
}

export interface MatchEvent {
  matchId: string
  roundIndex: number
  type: string
  startTick: number
  endTick: number | null
  actorSteamId: string | null
  victimSteamId: string | null
  severity: number
  confidence: number
  meta: any
}

export interface Round {
  roundIndex: number
  startTick: number
  endTick: number
  freezeEndTick?: number | null
  tWins?: number
  ctWins?: number
  winner?: string | null
}

export interface Shot {
  tick: number
  steamId: string
  weaponName: string
  x: number
  y: number
  z: number
  yaw: number
  pitch: number | null
  team: string | null
}

export interface GrenadePosition {
  tick: number
  projectileId: number
  grenadeName: string
  x: number
  y: number
  z: number
  throwerSteamId: string | null
  throwerName: string | null
  throwerTeam: string | null
}

export interface GrenadeEvent {
  tick: number
  eventType: string
  projectileId: number
  grenadeName: string
  x: number
  y: number
  z: number
  throwerSteamId: string | null
  throwerName: string | null
  throwerTeam: string | null
}

export interface InfernoSample {
  tick: number
  entityId: number
  polygon: [number, number][]
  throwerSteamId: string | null
  throwerName: string | null
  throwerTeam: string | null
}

/** A player as drawn at one moment. */
export interface PlayerFrame extends Position {
  alive: boolean
}

export type Layers = {
  names: boolean
  trails: boolean
  utility: boolean
  shots: boolean
  events: boolean
}

export const DEFAULT_LAYERS: Layers = { names: true, trails: true, utility: true, shots: true, events: true }

export const TEAM_COLORS = {
  T: '#e8b04a',
  CT: '#5fa8ff',
  none: '#9aa0a8',
} as const

export function teamColor(team: string | null | undefined): string {
  return team === 'T' ? TEAM_COLORS.T : team === 'CT' ? TEAM_COLORS.CT : TEAM_COLORS.none
}

export type GrenadeKind = 'he' | 'smoke' | 'flash' | 'fire' | 'decoy' | 'other'

export function grenadeKind(name: string | null | undefined): GrenadeKind {
  const n = (name ?? '').toLowerCase()
  if (n.includes('smoke')) return 'smoke'
  if (n.includes('flash')) return 'flash'
  if (n.includes('molotov') || n.includes('incendiary') || n.includes('inferno')) return 'fire'
  if (n.includes('decoy')) return 'decoy'
  if (n.includes('he')) return 'he'
  return 'other'
}

export const GRENADE_COLORS: Record<GrenadeKind, string> = {
  he: '#5fd08a',
  smoke: '#c3c7ce',
  flash: '#fff3a8',
  fire: '#ff7a3d',
  decoy: '#b48cff',
  other: '#ffffff',
}

/** Short weapon label: "weapon_ak47" → "AK47". */
export function weaponLabel(weapon: string | null | undefined): string {
  if (!weapon) return '—'
  return weapon.replace(/^weapon_/, '').replace(/_/g, ' ').toUpperCase()
}

export function isUtility(weapon: string | null | undefined): boolean {
  const w = (weapon ?? '').toLowerCase()
  return /grenade|flashbang|molotov|incendiary|decoy|smoke/.test(w)
}

export function isKnife(weapon: string | null | undefined): boolean {
  const w = (weapon ?? '').toLowerCase()
  return w.includes('knife') || w.includes('bayonet')
}
