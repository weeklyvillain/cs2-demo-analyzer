import { Zap, ChevronDown, ChevronUp, Play, Map as MapIcon } from 'lucide-react'
import { t } from '../../utils/translations'
import type { Player, PlayerEvent } from '../../types/matches'

interface Props {
  events: PlayerEvent[]
  allPlayers: Player[]
  expanded: boolean
  demoPath: string | null
  tickRate: number
  hasRadar: boolean
  onToggle: () => void
  onWatchAtTick: (tick: number, playerName: string, roundIndex: number) => void
  onSetViewer2D: (v: { roundIndex: number; tick: number }) => void
}

export default function TeamDamageSection({
  events,
  allPlayers,
  expanded,
  demoPath,
  tickRate,
  hasRadar,
  onToggle,
  onWatchAtTick,
  onSetViewer2D,
}: Props) {
  const getPlayerName = (steamId: string | null | undefined) =>
    allPlayers.find(p => p.steamId === steamId)?.name || steamId || t('matches.unknown')

  if (events.length === 0) return null

  return (
    <div className="bg-surface border border-border rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <button
          onClick={onToggle}
          className="flex items-center gap-2 text-lg font-semibold text-white hover:text-accent transition-colors"
        >
          <Zap size={18} />
          {t('matches.sections.teamDamage')}
          {expanded ? <ChevronDown size={18} className="text-gray-500" /> : <ChevronUp size={18} className="text-gray-500" />}
        </button>
      </div>
      {expanded && (
        <div className="flex flex-wrap gap-4">
          {events
            .sort((a, b) => a.roundIndex - b.roundIndex)
            .map((damage, idx) => {
              // Handle weapon display - can be string or array
              let weaponDisplay = ''
              if (damage.meta?.weapon) {
                if (Array.isArray(damage.meta.weapon)) {
                  weaponDisplay = damage.meta.weapon.join(', ')
                } else {
                  weaponDisplay = damage.meta.weapon
                }
              }
              return (
                <div key={idx} className="bg-secondary border border-border rounded p-3 min-w-[300px]">
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-medium text-white">{getPlayerName(damage.actorSteamId)}</span>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-gray-400">{t('matches.round')} {damage.roundIndex + 1}</span>
                      {demoPath && (
                        <div className="flex items-center gap-1">
                          {hasRadar && (
                            <button
                              onClick={() => {
                                const previewSeconds = 5
                                const previewTicks = previewSeconds * tickRate
                                const targetTick = Math.max(0, damage.startTick - previewTicks)
                                onSetViewer2D({ roundIndex: damage.roundIndex, tick: targetTick })
                              }}
                              className="p-1 hover:bg-accent/20 rounded transition-colors"
                              title={t('matches.viewIn2D')}
                            >
                              <MapIcon size={14} className="text-gray-400 hover:text-accent" />
                            </button>
                          )}
                          <button
                            onClick={() => onWatchAtTick(damage.startTick, getPlayerName(damage.actorSteamId) as string, damage.roundIndex)}
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
                    → {getPlayerName(damage.victimSteamId || '')}
                  </div>
                  {weaponDisplay && (
                    <div className="text-xs text-gray-400 mt-1">
                      {weaponDisplay}
                    </div>
                  )}
                  <div className="text-xs text-accent mt-1">
                    {damage.meta?.total_damage?.toFixed(1) || 0} {t('matches.damage')}
                  </div>
                </div>
              )
            })}
        </div>
      )}
    </div>
  )
}
