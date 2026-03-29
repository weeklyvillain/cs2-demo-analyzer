import { ChevronDown, ChevronUp, Play } from 'lucide-react'
import { t } from '../../utils/translations'
import type { Player, PlayerEvent } from '../../types/matches'

// Custom body block icon for head stacking
const BodyBlockIcon = () => (
  <svg width="18" height="18" viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">
    {/* Player left */}
    <circle cx="42" cy="34" r="10" fill="#FF9800"/>
    <rect x="30" y="48" width="24" height="48" rx="7" fill="#FF9800"/>
    {/* Player right */}
    <circle cx="86" cy="34" r="10" fill="#FF9800"/>
    <rect x="74" y="48" width="24" height="48" rx="7" fill="#FF9800"/>
    {/* Impact bar (the block moment) */}
    <rect x="56" y="68" width="16" height="8" rx="4" fill="#FF5722"/>
  </svg>
)

interface Props {
  events: PlayerEvent[]
  allPlayers: Player[]
  expanded: boolean
  tickRate: number
  onToggle: () => void
}

export default function BodyBlockSection({
  events,
  allPlayers,
  expanded,
  tickRate: _tickRate,
  onToggle,
}: Props) {
  const getPlayerName = (steamId: string | null | undefined) =>
    allPlayers.find(p => p.steamId === steamId)?.name || steamId || t('matches.unknown')

  if (events.length === 0) return null

  return (
    <div className="bg-surface border border-border rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <button
          onClick={onToggle}
          className="flex items-center gap-2 text-lg font-semibold text-white hover:text-purple-400 transition-colors"
        >
          <BodyBlockIcon />
          Body Block (Head Stacking)
          {expanded ? <ChevronDown size={18} className="text-gray-500" /> : <ChevronUp size={18} className="text-gray-500" />}
        </button>
      </div>
      {expanded && (
        <div className="flex flex-wrap gap-4">
          {events
            .sort((a, b) => a.roundIndex - b.roundIndex)
            .map((block, idx) => {
              const seconds = block.meta?.seconds || 0

              return (
                <div key={idx} className="bg-secondary border border-border rounded p-3 min-w-[320px]">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-white">{getPlayerName(block.actorSteamId)}</span>
                      <span className="text-xs text-gray-500">on</span>
                      <span className="font-medium text-purple-300">{getPlayerName(block.victimSteamId)}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-gray-400">Round {block.roundIndex + 1}</span>
                    </div>
                  </div>
                  <div className="text-xs text-purple-400 font-medium mb-2">
                    Head stacking detected
                  </div>
                  <div className="text-xs text-gray-400">
                    <span className="font-medium">Duration:</span>{' '}
                    <span className="text-white">{seconds.toFixed(1)}s</span>
                  </div>
                </div>
              )
            })}
        </div>
      )}
    </div>
  )
}
