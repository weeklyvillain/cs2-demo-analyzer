export interface Match {
  id: string
  map: string
  startedAt: string | null
  playerCount: number
  demoPath?: string | null
  isMissingDemo?: boolean
  createdAtIso?: string | null
  source?: string | null
}

export interface MatchStats {
  roundCount: number
  duration: number // Duration in seconds
  teamKills: number
  teamDamage: number
  afkSeconds: number
  teamFlashSeconds: number
  disconnects: number
  tWins: number
  ctWins: number
}

export interface PlayerScore {
  matchId: string
  steamId: string
  name: string
  teamKills: number
  teamDamage: number
  teamFlashSeconds: number
  afkSeconds: number
  bodyBlockSeconds: number
  economyGriefCount: number
  griefScore: number
}

export interface Round {
  roundIndex: number
  startTick: number
  endTick: number
  freezeEndTick: number | null
  tWins: number
  ctWins: number
  winner: string | null
}

export interface RoundEvent {
  type: string
  actorSteamId: string
  victimSteamId: string | null
  startTick: number
  endTick: number | null
  meta: any // Shape varies by event type
}

export interface RoundStats {
  roundIndex: number
  teamKills: number
  teamDamage: number
  teamFlashSeconds: number
  afkSeconds: number
  events: RoundEvent[]
}

export interface PlayerEvent {
  type: string
  roundIndex: number
  startTick: number
  endTick: number | null
  actorSteamId: string
  victimSteamId: string | null
  severity: number | null
  confidence: number | null
  meta: any // Shape varies by event type
}

export type ActiveTab = 'overview' | 'rounds' | 'players' | 'chat' | '2d-viewer'

export interface Player {
  steamId: string
  name: string
  team: string | null
  connectedMidgame?: boolean
  permanentDisconnect?: boolean
  firstConnectRound?: number | null
  disconnectRound?: number | null
}
