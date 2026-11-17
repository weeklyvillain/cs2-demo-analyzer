import { TEAM_COLORS, TICKRATE, teamColor, type MatchEvent, type Round } from './types'
import { mmss } from './radarMath'

/** Score at the playhead: the previous round's tally while a round is live, this one's once it ends. */
export function scoreAt(rounds: Round[], tick: number): { t: number; ct: number } {
  const i = rounds.findIndex((r) => tick >= r.startTick && tick <= r.endTick)
  if (i < 0) {
    let last: Round | undefined
    for (const r of rounds) if (r.endTick < tick) last = r
    return { t: last?.tWins ?? 0, ct: last?.ctWins ?? 0 }
  }
  const r = rounds[i]
  if (tick >= r.endTick) return { t: r.tWins ?? 0, ct: r.ctWins ?? 0 }
  const prev = rounds[i - 1]
  return { t: prev?.tWins ?? 0, ct: prev?.ctWins ?? 0 }
}

export type Phase = 'freeze' | 'live' | 'over'

export function phaseAt(round: Round | undefined, tick: number): { phase: Phase; clock: string } {
  if (!round) return { phase: 'over', clock: '0:00' }
  const live = round.freezeEndTick && round.freezeEndTick > round.startTick ? round.freezeEndTick : round.startTick
  if (tick < live) return { phase: 'freeze', clock: mmss((live - tick) / TICKRATE) }
  if (tick >= round.endTick) return { phase: 'over', clock: mmss((round.endTick - live) / TICKRATE) }
  return { phase: 'live', clock: mmss((tick - live) / TICKRATE) }
}

/** The score bug over the top of the map. */
export function ScoreBug({ score, round, totalRounds, phase, clock }: { score: { t: number; ct: number }; round: number; totalRounds: number; phase: Phase; clock: string }) {
  return (
    <div className="pointer-events-none absolute left-1/2 top-3 z-20 -translate-x-1/2">
      <div className="flex items-stretch overflow-hidden rounded-lg border border-white/10 bg-[#121417]/90 shadow-xl backdrop-blur">
        <div className="flex items-center gap-2 px-3 py-1.5">
          <span className="text-[10px] font-bold tracking-wider" style={{ color: TEAM_COLORS.T }}>
            T
          </span>
          <span className="font-mono text-lg font-bold tabular-nums text-white">{score.t}</span>
        </div>
        <div className="flex min-w-[84px] flex-col items-center justify-center border-x border-white/10 bg-white/[0.03] px-3">
          <span className={`font-mono text-sm font-semibold tabular-nums ${phase === 'freeze' ? 'text-sky-300' : 'text-white'}`}>{clock}</span>
          <span className="text-[9px] font-semibold uppercase tracking-[0.12em] text-gray-400">
            {phase === 'freeze' ? 'Freeze' : phase === 'over' ? 'Round over' : `Round ${round}${totalRounds ? ` / ${totalRounds}` : ''}`}
          </span>
        </div>
        <div className="flex items-center gap-2 px-3 py-1.5">
          <span className="font-mono text-lg font-bold tabular-nums text-white">{score.ct}</span>
          <span className="text-[10px] font-bold tracking-wider" style={{ color: TEAM_COLORS.CT }}>
            CT
          </span>
        </div>
      </div>
    </div>
  )
}

const FEED_SECONDS = 5

/** Recent kills (and team kills), newest on top. */
export function KillFeed({
  events,
  tick,
  nameOf,
  teamOf,
}: {
  events: MatchEvent[]
  tick: number
  nameOf: (steamid: string | null) => string
  teamOf: (steamid: string | null) => string | null
}) {
  const kills = events
    .filter((e) => {
      const t = e.type?.toUpperCase()
      if (t !== 'TEAM_KILL' && t !== 'KILL' && t !== 'KILLS') return false
      if (!e.actorSteamId || !e.victimSteamId) return false
      const s = (tick - e.startTick) / TICKRATE
      return s >= 0 && s < FEED_SECONDS
    })
    .sort((a, b) => b.startTick - a.startTick)
    .slice(0, 5)
  if (kills.length === 0) return null
  return (
    <div className="pointer-events-none absolute right-3 top-3 z-20 flex flex-col items-end gap-1">
      {kills.map((k) => {
        const age = (tick - k.startTick) / TICKRATE
        const tk = k.type?.toLowerCase() === 'team_kill'
        return (
          <div
            key={`${k.startTick}-${k.actorSteamId}-${k.victimSteamId}`}
            className={`flex items-center gap-2 rounded-md border px-2.5 py-1 text-xs backdrop-blur ${tk ? 'border-[#ff4d5e]/60 bg-[#3a1418]/85' : 'border-white/10 bg-[#121417]/85'}`}
            style={{ opacity: Math.max(0.35, 1 - age / FEED_SECONDS) }}
          >
            <span className="font-semibold" style={{ color: teamColor(teamOf(k.actorSteamId)) }}>
              {nameOf(k.actorSteamId)}
            </span>
            <span className="font-mono text-[10px] uppercase text-gray-400">{k.meta?.weapon ? String(k.meta.weapon).replace(/^weapon_/, '') : '✕'}</span>
            <span className="font-semibold" style={{ color: teamColor(teamOf(k.victimSteamId)) }}>
              {nameOf(k.victimSteamId)}
            </span>
            {tk && <span className="rounded bg-[#ff4d5e] px-1 text-[9px] font-bold text-[#16181b]">TK</span>}
          </div>
        )
      })}
    </div>
  )
}
