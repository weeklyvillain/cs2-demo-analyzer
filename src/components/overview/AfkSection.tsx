import { Clock, Skull, ChevronDown, ChevronUp, Play, Map as MapIcon } from 'lucide-react'
import { t } from '../../utils/translations'
import type { Player } from '../../types/matches'

interface AfkEvent {
  actorSteamId: string
  startTick: number
  endTick: number | null
  roundIndex: number
  meta: any
}

interface Props {
  events: AfkEvent[]
  allPlayers: Player[]
  expanded: boolean
  minSeconds: number
  sortBy: 'round' | 'duration'
  demoPath: string | null
  tickRate: number
  hasRadar: boolean
  onToggle: () => void
  onMinSecondsChange: (v: number) => void
  onSortByChange: (v: 'round' | 'duration') => void
  onWatchAtTick: (tick: number, playerName: string, roundIndex: number) => void
  onSetViewer2D: (v: { roundIndex: number; tick: number }) => void
}

export default function AfkSection({
  events,
  allPlayers,
  expanded,
  minSeconds,
  sortBy,
  demoPath,
  tickRate,
  hasRadar,
  onToggle,
  onMinSecondsChange,
  onSortByChange,
  onWatchAtTick,
  onSetViewer2D,
}: Props) {
  const getPlayerName = (steamId: string) => {
    const p = allPlayers.find(p => p.steamId === steamId)
    return p?.name || steamId
  }

  // Auto-adjust threshold: if no events shown but events exist, lower threshold to show at least one
  let effectiveAfkThreshold = minSeconds
  if (events.length > 0) {
    const filtered = events.filter((e) => {
      const duration = e.meta?.seconds || e.meta?.afkDuration || (e.endTick && e.startTick ? (e.endTick - e.startTick) / 64 : 0)
      return duration >= effectiveAfkThreshold
    })
    if (filtered.length === 0) {
      const durations = events
        .map(e => e.meta?.seconds || e.meta?.afkDuration || (e.endTick && e.startTick ? (e.endTick - e.startTick) / 64 : 0))
        .filter(d => d > 0)
        .sort((a, b) => a - b)
      if (durations.length > 0) {
        effectiveAfkThreshold = Math.floor(durations[0])
      }
    }
  }

  const filteredEvents = events.filter((e) => {
    const duration = e.meta?.seconds || e.meta?.afkDuration || (e.endTick && e.startTick ? (e.endTick - e.startTick) / 64 : 0)
    return duration >= effectiveAfkThreshold
  })

  if (events.length === 0) return null

  return (
    <div className="bg-surface border border-border rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <button
          onClick={onToggle}
          className="flex items-center gap-2 text-lg font-semibold text-white hover:text-accent transition-colors"
        >
          <Clock size={18} />
          {t('matches.afkPlayersAtRoundStart')}
          {expanded ? <ChevronDown size={18} className="text-gray-500" /> : <ChevronUp size={18} className="text-gray-500" />}
        </button>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-400">{t('matches.sortBy')}</label>
            <select
              value={sortBy}
              onChange={(e) => onSortByChange(e.target.value as 'round' | 'duration')}
              className="px-2 py-1 bg-secondary border border-border rounded text-white text-xs"
            >
              <option value="round">{t('matches.round')}</option>
              <option value="duration">{t('matches.duration')}</option>
            </select>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-400">{t('matches.minDuration')}</label>
            <input
              type="number"
              min="0"
              step="0.5"
              value={effectiveAfkThreshold}
              onChange={(e) => onMinSecondsChange(parseFloat(e.target.value) || 0)}
              className="w-20 px-2 py-1 bg-secondary border border-border rounded text-white text-xs"
            />
            <span className="text-xs text-gray-500">{t('matches.seconds')}</span>
            <span className="text-xs text-gray-500">
              ({filteredEvents.length}/{events.length})
            </span>
          </div>
        </div>
      </div>
      {expanded && (() => {
        // Group by player (actorSteamId)
        const groupedByPlayer = new Map<string, typeof filteredEvents>()
        filteredEvents.forEach((afk) => {
          const playerId = afk.actorSteamId
          if (!groupedByPlayer.has(playerId)) {
            groupedByPlayer.set(playerId, [])
          }
          groupedByPlayer.get(playerId)!.push(afk)
        })

        // Convert to array and sort alphabetically by player name
        const sortedPlayers = Array.from(groupedByPlayer.entries())
          .map(([playerId, afks]) => {
            // Sort AFK periods based on user selection
            const sortedAfks = afks.sort((a, b) => {
              if (sortBy === 'round') {
                return a.roundIndex - b.roundIndex
              } else if (sortBy === 'duration') {
                const durationA = a.meta?.seconds || a.meta?.afkDuration || (a.endTick && a.startTick ? (a.endTick - a.startTick) / tickRate : 0)
                const durationB = b.meta?.seconds || b.meta?.afkDuration || (b.endTick && b.startTick ? (b.endTick - b.startTick) / tickRate : 0)
                return durationB - durationA // Descending order (longest first)
              }
              return 0
            })
            return {
              playerId,
              playerName: getPlayerName(playerId),
              afks: sortedAfks,
            }
          })
          .sort((a, b) => a.playerName.localeCompare(b.playerName))

        return filteredEvents.length > 0 ? (
          <div className="flex flex-col gap-4">
            {sortedPlayers.map(({ playerId, playerName, afks }) => (
              <div key={playerId} className="bg-secondary border border-border rounded p-4">
                <div className="flex items-center justify-between mb-3">
                  <span className="font-semibold text-white text-base">{playerName}</span>
                  <span className="text-xs text-gray-400">{afks.length} {afks.length !== 1 ? t('matches.afkPeriods') : t('matches.afkPeriod')}</span>
                </div>
                <div className="flex flex-wrap gap-3">
                  {afks.map((afk, idx) => {
                    const duration = afk.meta?.seconds || afk.meta?.afkDuration || (afk.endTick && afk.startTick ? (afk.endTick - afk.startTick) / 64 : 0)
                    const diedWhileAFK = afk.meta?.diedWhileAFK === true
                    const timeToFirstMovement = afk.meta?.timeToFirstMovement
                    const borderColor = diedWhileAFK ? 'border-red-500' : timeToFirstMovement !== undefined ? 'border-yellow-400' : 'border-gray-500'

                    return (
                      <div key={idx} className={`bg-surface border-l-4 ${borderColor} border border-border rounded p-3 min-w-[280px]`}>
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-xs text-gray-400">{t('matches.round')} {afk.roundIndex + 1}</span>
                          {demoPath && (
                            <div className="flex items-center gap-1">
                              {hasRadar && (
                                <button
                                  onClick={() => {
                                    const previewSeconds = 5
                                    const previewTicks = previewSeconds * tickRate
                                    const targetTick = Math.max(0, afk.startTick - previewTicks)
                                    onSetViewer2D({ roundIndex: afk.roundIndex, tick: targetTick })
                                  }}
                                  className="p-1 hover:bg-accent/20 rounded transition-colors"
                                  title={t('matches.viewIn2D')}
                                >
                                  <MapIcon size={14} className="text-gray-400 hover:text-accent" />
                                </button>
                              )}
                              <button
                                onClick={() => onWatchAtTick(afk.startTick, playerName, afk.roundIndex)}
                                className="p-1 hover:bg-accent/20 rounded transition-colors"
                                title={t('matches.watchInCS2')}
                              >
                                <Play size={14} className="text-gray-400 hover:text-accent" />
                              </button>
                            </div>
                          )}
                        </div>
                        <div className="text-xs text-gray-400 space-y-1">
                          <div className="flex items-center gap-2">
                            <Clock size={12} />
                            <span>{t('matches.afkDuration').replace('{duration}', duration.toFixed(1))}</span>
                          </div>
                          {diedWhileAFK ? (
                            <div className="flex items-center gap-2 text-red-400">
                              <Skull size={12} />
                              <span>{t('matches.endedWhenDied')}</span>
                            </div>
                          ) : timeToFirstMovement !== undefined ? (
                            <div className="flex items-center gap-2 text-yellow-400">
                              <span>{t('matches.endedWhenMoving')}</span>
                            </div>
                          ) : (
                            <div className="flex items-center gap-2 text-gray-500">
                              <span>Ended when round ended</span>
                            </div>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-center text-gray-400 py-4">
            {t('matches.noAfkDetections').replace('{threshold}', effectiveAfkThreshold.toString())}
          </div>
        )
      })()}
    </div>
  )
}
