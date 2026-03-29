import { Zap, ChevronDown, ChevronUp, Play, Map as MapIcon } from 'lucide-react'
import { t } from '../../utils/translations'
import type { Player, PlayerEvent } from '../../types/matches'

interface Props {
  events: PlayerEvent[]
  allPlayers: Player[]
  expanded: boolean
  minSeconds: number
  demoPath: string | null
  tickRate: number
  hasRadar: boolean
  onToggle: () => void
  onMinSecondsChange: (v: number) => void
  onWatchAtTick: (tick: number, playerName: string, roundIndex: number) => void
  onSetViewer2D: (v: { roundIndex: number; tick: number }) => void
}

export default function TeamFlashesSection({
  events,
  allPlayers,
  expanded,
  minSeconds,
  demoPath,
  tickRate,
  hasRadar,
  onToggle,
  onMinSecondsChange,
  onWatchAtTick,
  onSetViewer2D,
}: Props) {
  const getPlayerName = (steamId: string | null | undefined) =>
    allPlayers.find(p => p.steamId === steamId)?.name || steamId || t('matches.unknown')

  // Auto-adjust threshold: if no events shown but events exist, lower threshold to show at least one
  let effectiveFlashThreshold = minSeconds
  if (events.length > 0) {
    const filtered = events.filter(e => (e.meta?.blind_duration || 0) >= effectiveFlashThreshold)
    if (filtered.length === 0) {
      const durations = events
        .map(e => e.meta?.blind_duration || 0)
        .filter(d => d > 0)
        .sort((a, b) => a - b)
      if (durations.length > 0) {
        effectiveFlashThreshold = durations[0]
      }
    }
  }

  const filteredEvents = events.filter(e => (e.meta?.blind_duration || 0) >= effectiveFlashThreshold)

  if (events.length === 0) return null

  return (
    <div className="bg-surface border border-border rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <button
          onClick={onToggle}
          className="flex items-center gap-2 text-lg font-semibold text-white hover:text-accent transition-colors"
        >
          <Zap size={18} />
          {t('matches.sections.teamFlashes')}
          {expanded ? <ChevronDown size={18} className="text-gray-500" /> : <ChevronUp size={18} className="text-gray-500" />}
        </button>
        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-400">{t('matches.minBlind')}</label>
          <input
            type="number"
            min="0"
            step="0.1"
            value={effectiveFlashThreshold}
            onChange={(e) => onMinSecondsChange(parseFloat(e.target.value) || 0)}
            className="w-20 px-2 py-1 bg-secondary border border-border rounded text-white text-xs"
          />
          <span className="text-xs text-gray-500">s</span>
          <span className="text-xs text-gray-500">
            ({filteredEvents.length}/{events.length})
          </span>
        </div>
      </div>
      {expanded && (
        <>
          {filteredEvents.length > 0 ? (
            <div className="flex flex-wrap gap-4">
              {filteredEvents
                .sort((a, b) => a.roundIndex - b.roundIndex)
                .map((flash, idx) => (
                  <div key={idx} className="bg-secondary border border-border rounded p-3 min-w-[300px]">
                    <div className="flex items-center justify-between mb-2">
                      <span className="font-medium text-white">{getPlayerName(flash.actorSteamId)}</span>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-gray-400">Round {flash.roundIndex + 1}</span>
                        {demoPath && (
                          <div className="flex items-center gap-1">
                            {hasRadar && (
                              <button
                                onClick={() => {
                                  const previewSeconds = 3
                                  const previewTicks = previewSeconds * tickRate
                                  const targetTick = Math.max(0, flash.startTick - previewTicks)
                                  onSetViewer2D({ roundIndex: flash.roundIndex, tick: targetTick })
                                }}
                                className="p-1 hover:bg-accent/20 rounded transition-colors"
                                title={t('matches.viewIn2D')}
                              >
                                <MapIcon size={14} className="text-gray-400 hover:text-accent" />
                              </button>
                            )}
                            <button
                              onClick={() => onWatchAtTick(flash.startTick, getPlayerName(flash.actorSteamId) as string, flash.roundIndex)}
                              className="p-1 hover:bg-accent/20 rounded transition-colors"
                              title="Watch this event in CS2"
                            >
                              <Play size={14} className="text-gray-400 hover:text-accent" />
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="text-sm text-gray-300">
                      → {getPlayerName(flash.victimSteamId || '')}
                    </div>
                    <div className="text-xs text-accent mt-1">
                      {flash.meta?.blind_duration?.toFixed(1) || 0}s {t('matches.blind')}
                    </div>
                  </div>
                ))}
            </div>
          ) : (
            <div className="text-center text-gray-400 py-4">
              {t('matches.noFlashes').replace('{threshold}', effectiveFlashThreshold.toFixed(1))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
