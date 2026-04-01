import { useState } from 'react'
import { ChevronDown, ChevronUp, Play, Map as MapIcon } from 'lucide-react'
import { t } from '../utils/translations'
import { formatTime, formatDuration } from '../utils/formatters'
import type { Round, RoundStats, Player, RoundEvent } from '../types/matches'

const EVENT_TYPE_LABELS: Record<string, string> = {
  TEAM_KILL: t('matches.sections.teamKills'),
  TEAM_DAMAGE: t('matches.sections.teamDamage'),
  TEAM_FLASH: t('matches.sections.teamFlashes'),
  AFK_STILLNESS: t('matches.sections.afk'),
  DISCONNECT: t('matches.sections.disconnects'),
  ECONOMY_GRIEF: 'Economy Griefing',
}

interface Props {
  rounds: Round[]
  roundStats: Map<number, RoundStats>
  allPlayers: Player[]
  demoPath: string | null
  tickRate: number
  hasRadarForCurrentMap: boolean
  onWatchAtTick: (tick: number, playerName: string, roundIndex: number) => void
  onSetViewer2D: (v: { roundIndex: number; tick: number } | null) => void
}

export default function MatchesRoundsTab({
  rounds,
  roundStats,
  allPlayers,
  demoPath,
  tickRate,
  hasRadarForCurrentMap,
  onWatchAtTick,
  onSetViewer2D,
}: Props) {
  const [expandedRounds, setExpandedRounds] = useState<Set<number>>(new Set())

  const toggleRound = (roundIndex: number) => {
    setExpandedRounds(prev => {
      const next = new Set(prev)
      if (next.has(roundIndex)) next.delete(roundIndex)
      else next.add(roundIndex)
      return next
    })
  }

  const getPlayerName = (steamId: string | null | undefined) =>
    allPlayers.find(p => p.steamId === steamId)?.name || steamId || t('matches.unknown')

  return (
    <div className="pt-4 max-h-[90%] overflow-y-auto">
      {rounds.length === 0 ? (
        <div className="text-center text-gray-500 text-sm py-6">
          {t('matches.noRoundsAvailable') ?? 'No rounds available'}
        </div>
      ) : (
        <div className="space-y-3 overflow-y-auto pr-1">
          {rounds.map((r) => {
            const stats = roundStats.get(r.roundIndex)
            const eventsForRound = stats?.events || []
            const durationTicks = r.endTick - r.startTick
            const durationSec = tickRate > 0 ? durationTicks / tickRate : 0
            const eventCount = eventsForRound.length
            const isExpanded = expandedRounds.has(r.roundIndex)

            return (
              <div
                key={r.roundIndex}
                className="bg-surface/60 border border-border rounded-lg overflow-hidden"
              >
                <div
                  className="px-4 py-3 flex items-center justify-between gap-3 cursor-pointer select-none"
                  onClick={() => toggleRound(r.roundIndex)}
                >
                  <div className="flex items-center gap-4">
                    <div className="text-white font-semibold text-sm">
                      Round {r.roundIndex + 1}
                    </div>
                    <div className="flex items-center gap-3 text-xs text-gray-400">
                      <div>
                        <span className="text-gray-500 mr-1">{t('matches.roundsTab.winner')}:</span>
                        {r.winner === 'T' ? (
                          <span className="text-[#ff6b35] font-medium">T</span>
                        ) : r.winner === 'CT' ? (
                          <span className="text-[#4a9eff] font-medium">CT</span>
                        ) : (
                          <span className="text-gray-500">—</span>
                        )}
                      </div>
                      <div>
                        <span className="text-gray-500 mr-1">{t('matches.roundsTab.score')}:</span>
                        <span className="text-gray-300">
                          {r.tWins} – {r.ctWins}
                        </span>
                      </div>
                      <div>
                        <span className="text-gray-500 mr-1">{t('matches.roundsTab.duration')}:</span>
                        <span className="text-gray-300">
                          {formatDuration(durationSec)}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-gray-400">
                      {eventCount} event{eventCount === 1 ? '' : 's'}
                    </span>
                    {hasRadarForCurrentMap && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          onSetViewer2D({ roundIndex: r.roundIndex, tick: r.startTick })
                        }}
                        className="px-2 py-1 text-xs bg-accent/80 hover:bg-accent text-white rounded transition-colors"
                      >
                        {t('matches.roundsTab.view2d')}
                      </button>
                    )}
                    {isExpanded ? (
                      <ChevronUp size={14} className="text-gray-400 flex-shrink-0" />
                    ) : (
                      <ChevronDown size={14} className="text-gray-400 flex-shrink-0" />
                    )}
                  </div>
                </div>

                {isExpanded && (
                  <div className="border-t border-border/60 bg-surface/40">
                    {eventsForRound.length === 0 ? (
                      <div className="px-4 py-3 text-xs text-gray-500">
                        {t('matches.noEventsInRound') ?? 'No events in this round'}
                      </div>
                    ) : (
                      <ul className="divide-y divide-border/40">
                        {eventsForRound.map((e: RoundEvent, idx: number) => {
                          const label = EVENT_TYPE_LABELS[e.type] || e.type
                          const actorName = e.actorSteamId ? getPlayerName(e.actorSteamId) : t('matches.unknown')
                          const victimName = e.victimSteamId ? getPlayerName(e.victimSteamId) : null
                          const timeLabel = tickRate > 0 ? formatTime(e.startTick - r.startTick, tickRate) : '0:00'

                          const previewSeconds = 5
                          const previewTicks = previewSeconds * tickRate
                          const previewTick = Math.max(r.startTick, e.startTick - previewTicks)

                          return (
                            <li
                              key={`${e.type}-${e.startTick}-${idx}`}
                              className="px-4 py-2.5 flex items-start gap-3"
                            >
                              <span className="text-[11px] text-gray-500 mt-0.5 w-12 flex-shrink-0">
                                {timeLabel}
                              </span>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center justify-between gap-3">
                                  <div className="text-xs font-semibold text-white truncate">
                                    {label}
                                  </div>
                                  {demoPath && (
                                    <div className="flex items-center gap-1 flex-shrink-0">
                                      {hasRadarForCurrentMap && (
                                        <button
                                          type="button"
                                          onClick={() => onSetViewer2D({ roundIndex: r.roundIndex, tick: previewTick })}
                                          className="p-1 hover:bg-accent/20 rounded transition-colors"
                                          title="View in 2D"
                                        >
                                          <MapIcon size={12} className="text-gray-400 hover:text-accent" />
                                        </button>
                                      )}
                                      <button
                                        type="button"
                                        onClick={() => onWatchAtTick(previewTick, actorName, r.roundIndex)}
                                        className="p-1 hover:bg-accent/20 rounded transition-colors"
                                        title="Watch this event in CS2"
                                      >
                                        <Play size={12} className="text-gray-400 hover:text-accent" />
                                      </button>
                                    </div>
                                  )}
                                </div>
                                <div className="text-xs text-gray-300 mt-0.5 truncate">
                                  <span className="font-medium">{actorName}</span>
                                  {victimName && (
                                    <>
                                      <span className="mx-1 text-gray-500">→</span>
                                      <span className="font-medium">{victimName}</span>
                                    </>
                                  )}
                                  {e.type === 'TEAM_DAMAGE' && (() => {
                                    const dmg =
                                      (e.meta && (e.meta.total_damage ?? e.meta.damage)) || 0
                                    return dmg > 0 ? (
                                      <span className="ml-2 text-gray-400">
                                        · {Math.round(dmg)} dmg
                                      </span>
                                    ) : null
                                  })()}
                                </div>
                              </div>
                            </li>
                          )
                        })}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
