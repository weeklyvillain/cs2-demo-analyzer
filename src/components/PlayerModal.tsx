import { useState } from 'react'
import { X, Clock, Skull, Zap, WifiOff, ChevronDown, ChevronUp, Play, Info, Map as MapIcon } from 'lucide-react'
import { formatDisconnectReason } from '../utils/disconnectReason'

const DollarIcon = () => (
  <svg width="18" height="18" viewBox="0 0 128 128" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="64" cy="64" r="54" fill="#F4C430"/>
    <circle cx="64" cy="64" r="44" fill="#FFD966"/>
    <text x="64" y="78" textAnchor="middle" fontSize="48" fontWeight="bold" fill="#B8860B">$</text>
  </svg>
)

const ECONOMY_GRIEF_TYPE_LABELS: Record<string, string> = {
  equipment_mismatch: 'Wrong weapon choice',
  no_buy_with_team: 'Not buying with team',
  excessive_saving: 'Excessive saving',
  full_save_high_money: 'Full save with high money',
}

interface PlayerEvent {
  type: string
  roundIndex: number
  startTick: number
  endTick: number | null
  actorSteamId: string
  victimSteamId: string | null
  severity: number | null
  confidence: number | null
  meta: any
}

interface PlayerScore {
  matchId: string
  steamId: string
  name: string
  teamKills: number
  teamDamage: number
  teamFlashSeconds: number
  afkSeconds: number
  bodyBlockSeconds: number
  griefScore: number
}

interface PlayerModalProps {
  player: PlayerScore
  events: PlayerEvent[]
  loading: boolean
  onClose: () => void
  onCopyCommand: (event: PlayerEvent) => void
  onView2D: (roundIndex: number, tick: number) => void
  demoPath: string | null
  tickRate: number
  getPlayerName: (steamId: string | null | undefined) => string
  formatTime: (tick: number, tickRate?: number) => string
  formatEventDuration: (startTick: number, endTick: number | null, tickRate?: number) => string
  eventTypeLabels: Record<string, string>
  collapsedSections: Set<string>
  toggleSection: (eventType: string) => void
  afkMinSeconds: number
  flashMinSeconds: number
  setAfkMinSeconds: (value: number) => void
  setFlashMinSeconds: (value: number) => void
  afkSortBy: 'round' | 'duration'
  setAfkSortBy: (value: 'round' | 'duration') => void
  filteredEvents: PlayerEvent[]
  eventsByType: Record<string, PlayerEvent[]>
  rounds?: Array<{ roundIndex: number; freezeEndTick?: number | null; startTick: number }>
}

export default function PlayerModal({
  player,
  events,
  loading,
  onClose,
  onCopyCommand,
  onView2D,
  demoPath,
  tickRate,
  getPlayerName,
  formatTime,
  formatEventDuration,
  eventTypeLabels,
  collapsedSections,
  toggleSection,
  afkMinSeconds,
  flashMinSeconds,
  setAfkMinSeconds,
  setFlashMinSeconds,
  afkSortBy,
  setAfkSortBy,
  filteredEvents,
  eventsByType,
  rounds = [],
}: PlayerModalProps) {
  const [selectedEconomyEvent, setSelectedEconomyEvent] = useState<PlayerEvent | null>(null)

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-secondary border border-border rounded-lg w-full max-w-5xl max-h-[90vh] flex flex-col overflow-hidden shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="px-6 py-4 border-b border-border flex items-center justify-between flex-shrink-0">
          <div>
            <h3 className="text-xl font-bold text-white">{player.name || player.steamId}</h3>
            <p className="text-sm text-gray-400 mt-1">
              Steam ID:{' '}
              <button
                onClick={async () => {
                  if (window.electronAPI?.openExternal) {
                    await window.electronAPI.openExternal(`https://steamcommunity.com/profiles/${player.steamId}`)
                  } else {
                    window.open(`https://steamcommunity.com/profiles/${player.steamId}`, '_blank')
                  }
                }}
                className="text-accent hover:text-accent/80 underline bg-transparent border-none cursor-pointer p-0"
              >
                {player.steamId}
              </button>
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1 hover:bg-surface rounded transition-colors text-gray-400 hover:text-white"
            aria-label="Close"
          >
            <X size={20} />
          </button>
        </div>

        {/* Modal Content */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="text-center text-gray-400 py-16">Loading events...</div>
          ) : filteredEvents.length === 0 ? (
            <div className="text-center text-gray-400 py-16">
              <p className="text-lg mb-2">No events found for this player</p>
              <p className="text-sm">This player has no griefing events recorded.</p>
            </div>
          ) : (
            <div className="flex flex-col gap-6 p-6">
              {/* Summary Cards */}
              {(() => {
                const teamKills = filteredEvents.filter(e => e.type === 'TEAM_KILL')
                const teamDamage = filteredEvents.filter(e => e.type === 'TEAM_DAMAGE')
                const afkEvents = filteredEvents.filter(e => e.type === 'AFK_STILLNESS')
                const teamFlashes = filteredEvents.filter(e => e.type === 'TEAM_FLASH')
                const disconnects = filteredEvents.filter(e => e.type === 'DISCONNECT')
                const economyGriefs = filteredEvents.filter(e => e.type === 'ECONOMY_GRIEF')

                return (
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
                    {economyGriefs.length > 0 && (
                      <div className="bg-surface border border-border rounded-lg p-4">
                        <div className="flex items-center gap-2 mb-2 text-gray-400">
                          <DollarIcon />
                          <span className="text-sm font-medium">Economy Grief</span>
                        </div>
                        <div className="text-3xl font-bold mb-1 text-yellow-400">{economyGriefs.length}</div>
                        <div className="text-xs text-gray-500">Buy phase / economy griefing</div>
                      </div>
                    )}
                    {teamKills.length > 0 && (
                      <div className="bg-surface border border-border rounded-lg p-4">
                        <div className="flex items-center gap-2 mb-2 text-gray-400">
                          <Skull size={16} />
                          <span className="text-sm font-medium">Team Kills</span>
                        </div>
                        <div className="text-3xl font-bold mb-1 text-red-400">{teamKills.length}</div>
                        <div className="text-xs text-gray-500">Friendly fire kills</div>
                      </div>
                    )}
                    {teamDamage.length > 0 && (
                      <div className="bg-surface border border-border rounded-lg p-4">
                        <div className="flex items-center gap-2 mb-2 text-gray-400">
                          <Zap size={16} />
                          <span className="text-sm font-medium">Team Damage</span>
                        </div>
                        <div className="text-3xl font-bold mb-1 text-accent">{teamDamage.length}</div>
                        <div className="text-xs text-gray-500">Friendly fire damage events</div>
                      </div>
                    )}
                    {afkEvents.length > 0 && (
                      <div className="bg-surface border border-border rounded-lg p-4">
                        <div className="flex items-center gap-2 mb-2 text-gray-400">
                          <Clock size={16} />
                          <span className="text-sm font-medium">AFK Detections</span>
                        </div>
                        <div className="text-3xl font-bold mb-1 text-white">{afkEvents.length}</div>
                        <div className="text-xs text-gray-500">No movement after freezetime</div>
                      </div>
                    )}
                    {teamFlashes.length > 0 && (
                      <div className="bg-surface border border-border rounded-lg p-4">
                        <div className="flex items-center gap-2 mb-2 text-gray-400">
                          <Zap size={16} />
                          <span className="text-sm font-medium">Team Flashes</span>
                        </div>
                        <div className="text-3xl font-bold mb-1 text-accent">{teamFlashes.length}</div>
                        <div className="text-xs text-gray-500">Friendly flashbang detonations</div>
                      </div>
                    )}
                    {disconnects.length > 0 && (
                      <div className="bg-surface border border-border rounded-lg p-4">
                        <div className="flex items-center gap-2 mb-2 text-gray-400">
                          <WifiOff size={16} />
                          <span className="text-sm font-medium">Disconnects</span>
                        </div>
                        <div className="text-3xl font-bold mb-1 text-gray-400">{disconnects.length}</div>
                        <div className="text-xs text-gray-500">Player disconnection events</div>
                      </div>
                    )}
                  </div>
                )
              })()}

              {/* Event Sections */}
              {Object.entries(eventsByType).map(([eventType, events]) => {
                const isCollapsed = collapsedSections.has(eventType)
                const iconMap: Record<string, React.ReactNode> = {
                  TEAM_KILL: <Skull size={18} />,
                  TEAM_DAMAGE: <Zap size={18} />,
                  AFK_STILLNESS: <Clock size={18} />,
                  TEAM_FLASH: <Zap size={18} />,
                  DISCONNECT: <WifiOff size={18} />,
                  ECONOMY_GRIEF: <DollarIcon />,
                }
                return (
                  <div key={eventType} className="bg-surface border border-border rounded-lg overflow-hidden">
                    <button
                      onClick={() => toggleSection(eventType)}
                      className="w-full px-4 py-3 flex items-center justify-between hover:bg-surface/50 transition-colors"
                    >
                      <div className="flex items-center gap-2">
                        {iconMap[eventType]}
                        <h4 className="text-lg font-semibold text-white">
                          {eventTypeLabels[eventType] || eventType}
                          <span className="ml-2 text-sm text-gray-400 font-normal">
                            ({events.length} {events.length === 1 ? 'event' : 'events'})
                          </span>
                        </h4>
                      </div>
                      {isCollapsed ? <ChevronDown size={18} className="text-gray-500" /> : <ChevronUp size={18} className="text-gray-500" />}
                    </button>
                    {!isCollapsed && (
                      <div className="px-4 pb-4">
                        {eventType === 'AFK_STILLNESS' && (
                          <div className="mb-3 flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <label className="text-xs text-gray-400">Sort by:</label>
                              <select
                                value={afkSortBy}
                                onChange={(e) => setAfkSortBy(e.target.value as 'round' | 'duration')}
                                className="px-2 py-1 bg-secondary border border-border rounded text-white text-xs"
                              >
                                <option value="round">Round</option>
                                <option value="duration">Duration</option>
                              </select>
                            </div>
                            <div className="flex items-center gap-2">
                              <label className="text-xs text-gray-400">Min duration:</label>
                              <input
                                type="number"
                                min="0"
                                step="0.5"
                                value={afkMinSeconds}
                                onChange={(e) => setAfkMinSeconds(parseFloat(e.target.value) || 0)}
                                className="w-20 px-2 py-1 bg-secondary border border-border rounded text-white text-xs"
                              />
                              <span className="text-xs text-gray-500">s</span>
                            </div>
                          </div>
                        )}
                        {eventType === 'TEAM_FLASH' && (
                          <div className="mb-3 flex items-center justify-end">
                            <div className="flex items-center gap-2">
                              <label className="text-xs text-gray-400">Min blind:</label>
                              <input
                                type="number"
                                min="0"
                                step="0.1"
                                value={flashMinSeconds}
                                onChange={(e) => setFlashMinSeconds(parseFloat(e.target.value) || 0)}
                                className="w-20 px-2 py-1 bg-secondary border border-border rounded text-white text-xs"
                              />
                              <span className="text-xs text-gray-500">s</span>
                            </div>
                          </div>
                        )}
                        <div className="flex flex-wrap gap-4">
                          {(() => {
                            // Sort events - for AFK_STILLNESS, use user-selected sort
                            let sortedEvents = events
                            if (eventType === 'AFK_STILLNESS') {
                              sortedEvents = [...events].sort((a, b) => {
                                if (afkSortBy === 'round') {
                                  return a.roundIndex - b.roundIndex
                                } else if (afkSortBy === 'duration') {
                                  const durationA = a.meta?.seconds || (a.endTick && a.startTick ? (a.endTick - a.startTick) / tickRate : 0)
                                  const durationB = b.meta?.seconds || (b.endTick && b.startTick ? (b.endTick - b.startTick) / tickRate : 0)
                                  return durationB - durationA // Descending (longest first)
                                }
                                return 0
                              })
                            }
                            return sortedEvents.map((event, idx) => {
                              if (eventType === 'ECONOMY_GRIEF') {
                                const griefType = event.meta?.grief_type || 'unknown'
                                const startMoney = event.meta?.start_money || 0
                                const moneySpent = event.meta?.money_spent || 0
                                const spendPct = event.meta?.spend_pct || 0
                                const teamAvgSpend = event.meta?.team_avg_spend || 0
                                const teamAvgMoney = event.meta?.team_avg_money || 0
                                const teamSpendPct = event.meta?.team_spend_pct || 0
                                const round = rounds.find(r => r.roundIndex === event.roundIndex)
                                const view2DTick = round ? (round.freezeEndTick ?? round.startTick) : event.startTick
                                return (
                                  <div key={idx} className="bg-secondary border border-border rounded p-3 min-w-[320px] flex-1">
                                    <div className="flex items-center justify-between mb-2">
                                      <span className="font-medium text-white">{getPlayerName(event.actorSteamId)}</span>
                                      <div className="flex items-center gap-2">
                                        <button
                                          onClick={() => setSelectedEconomyEvent(event)}
                                          className="p-1 hover:bg-accent/20 rounded transition-colors"
                                          title="View details"
                                        >
                                          <Info size={14} className="text-gray-400 hover:text-accent" />
                                        </button>
                                        <span className="text-xs text-gray-400">Round {event.roundIndex + 1}</span>
                                        {demoPath && (
                                          <div className="flex items-center gap-1">
                                            <button
                                              onClick={() => onView2D(event.roundIndex, view2DTick)}
                                              className="p-1 hover:bg-accent/20 rounded transition-colors"
                                              title="View in 2D"
                                            >
                                              <MapIcon size={14} className="text-gray-400 hover:text-accent" />
                                            </button>
                                            <button
                                              onClick={() => onCopyCommand(event)}
                                              className="p-1 hover:bg-accent/20 rounded transition-colors"
                                              title="Watch this event in CS2"
                                            >
                                              <Play size={14} className="text-gray-400 hover:text-accent" />
                                            </button>
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                    <div className="text-xs text-yellow-400 font-medium mb-2">
                                      {ECONOMY_GRIEF_TYPE_LABELS[griefType] || griefType}
                                    </div>
                                    <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                                      <div className="text-gray-400">
                                        <span className="font-medium">Start money:</span>
                                      </div>
                                      <div className="text-white">
                                        ${startMoney.toLocaleString()}
                                      </div>
                                      <div className="text-gray-400">
                                        <span className="font-medium">Spent:</span>
                                      </div>
                                      <div className="text-white">
                                        ${moneySpent.toLocaleString()} ({spendPct.toFixed(1)}%)
                                      </div>
                                      <div className="text-gray-400">
                                        <span className="font-medium">Team avg money:</span>
                                      </div>
                                      <div className="text-gray-300">
                                        ${Math.round(teamAvgMoney).toLocaleString()}
                                      </div>
                                      <div className="text-gray-400">
                                        <span className="font-medium">Team avg spent:</span>
                                      </div>
                                      <div className="text-gray-300">
                                        ${Math.round(teamAvgSpend).toLocaleString()} ({teamSpendPct.toFixed(1)}%)
                                      </div>
                                    </div>
                                  </div>
                                )
                              }
                              return (
                            <div
                              key={idx}
                              className="bg-secondary border border-border rounded p-3 min-w-[300px] flex-1"
                            >
                              <div className="flex items-center justify-between mb-2">
                                <span className="text-xs text-gray-400">Round {event.roundIndex + 1}</span>
                                <div className="flex items-center gap-2">
                                  {demoPath && (
                                    <div className="flex items-center gap-1">
                                      <button
                                        onClick={() => onView2D(event.roundIndex, event.startTick)}
                                        className="p-1 hover:bg-accent/20 rounded transition-colors"
                                        title="View in 2D"
                                      >
                                        <span className="text-xs">🗺️</span>
                                      </button>
                                      <button
                                        onClick={() => onCopyCommand(event)}
                                        className="p-1 hover:bg-accent/20 rounded transition-colors"
                                        title="Watch this event in CS2"
                                      >
                                        <Play size={14} className="text-gray-400 hover:text-accent" />
                                      </button>
                                    </div>
                                  )}
                                </div>
                              </div>
                              <div className="text-xs text-gray-400 mb-2">
                                {formatTime(event.startTick, tickRate)}
                                {event.endTick && ` - ${formatTime(event.endTick, tickRate)}`}
                                {event.endTick && (
                                  <span className="text-gray-500 ml-1">
                                    ({formatEventDuration(event.startTick, event.endTick, tickRate)})
                                  </span>
                                )}
                              </div>
                              {event.victimSteamId && (
                                <div className="text-sm text-gray-300 mb-2">
                                  → {getPlayerName(event.victimSteamId)}
                                </div>
                              )}

                              {/* Event-specific details */}
                              {event.meta && (
                                <div className="mt-2 space-y-1">
                                  {event.meta.weapon && (
                                    <div className="text-xs text-gray-400">
                                      {Array.isArray(event.meta.weapon)
                                        ? event.meta.weapon.join(', ')
                                        : event.meta.weapon}
                                    </div>
                                  )}
                                  {event.meta.total_damage !== undefined && (
                                    <div className="text-xs text-accent">
                                      {event.meta.total_damage.toFixed(1)} damage
                                    </div>
                                  )}
                                  {event.meta.blind_duration !== undefined && (
                                    <div className="text-xs text-accent">
                                      {event.meta.blind_duration.toFixed(1)}s blind
                                    </div>
                                  )}
                                  {event.meta.seconds !== undefined && (
                                    <div className="text-xs text-gray-300">
                                      {event.meta.seconds.toFixed(1)}s AFK
                                    </div>
                                  )}
                                  {event.type === 'DISCONNECT' && event.meta.reason && (
                                    <div className="text-xs text-gray-400">
                                      <span className="font-medium">Reason:</span> {formatDisconnectReason(event.meta.reason)}
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                            )
                            })
                          })()}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}

              {/* Economy event detail modal */}
              {selectedEconomyEvent && (
                <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60] p-4">
                  <div className="bg-surface border border-border rounded-lg max-w-md w-full max-h-[80vh] overflow-y-auto">
                    <div className="sticky top-0 bg-surface border-b border-border p-4 flex items-center justify-between">
                      <h2 className="text-lg font-semibold text-white">
                        {getPlayerName(selectedEconomyEvent.actorSteamId)} - Round {selectedEconomyEvent.roundIndex + 1}
                      </h2>
                      <button
                        onClick={() => setSelectedEconomyEvent(null)}
                        className="p-1 hover:bg-secondary rounded transition-colors"
                      >
                        <X size={18} className="text-gray-400" />
                      </button>
                    </div>

                    <div className="p-4 space-y-4">
                      <div>
                        <div className="text-xs font-medium text-gray-400 mb-1">Grief Type:</div>
                        <div className="text-yellow-400 font-medium">
                          {selectedEconomyEvent.meta?.grief_type === 'equipment_mismatch' && 'Wrong weapon choice'}
                          {selectedEconomyEvent.meta?.grief_type === 'no_buy_with_team' && 'Not buying with team'}
                          {selectedEconomyEvent.meta?.grief_type === 'excessive_saving' && 'Excessive saving'}
                          {selectedEconomyEvent.meta?.grief_type === 'full_save_high_money' && 'Full save with high money'}
                          {!['equipment_mismatch', 'no_buy_with_team', 'excessive_saving', 'full_save_high_money'].includes(selectedEconomyEvent.meta?.grief_type) && selectedEconomyEvent.meta?.grief_type}
                        </div>
                      </div>

                      <div className="bg-secondary/50 rounded p-3 space-y-2">
                        <div className="flex justify-between text-xs">
                          <span className="text-gray-400">Start money:</span>
                          <span className="text-white font-medium">${selectedEconomyEvent.meta?.start_money?.toLocaleString()}</span>
                        </div>
                        <div className="flex justify-between text-xs">
                          <span className="text-gray-400">Spent:</span>
                          <span className="text-white font-medium">${selectedEconomyEvent.meta?.money_spent?.toLocaleString()} ({selectedEconomyEvent.meta?.spend_pct?.toFixed(1)}%)</span>
                        </div>
                        <div className="flex justify-between text-xs">
                          <span className="text-gray-400">Remaining:</span>
                          <span className="text-white font-medium">${selectedEconomyEvent.meta?.remaining_money?.toLocaleString()}</span>
                        </div>
                      </div>

                      <div className="bg-secondary/50 rounded p-3 space-y-2">
                        <div className="text-xs font-medium text-gray-400 mb-2">Team Average:</div>
                        <div className="flex justify-between text-xs">
                          <span className="text-gray-400">Start money:</span>
                          <span className="text-white font-medium">${Math.round(selectedEconomyEvent.meta?.team_avg_money)?.toLocaleString()}</span>
                        </div>
                        <div className="flex justify-between text-xs">
                          <span className="text-gray-400">Spent:</span>
                          <span className="text-white font-medium">${Math.round(selectedEconomyEvent.meta?.team_avg_spend)?.toLocaleString()} ({selectedEconomyEvent.meta?.team_spend_pct?.toFixed(1)}%)</span>
                        </div>
                        <div className="flex justify-between text-xs">
                          <span className="text-gray-400">Remaining:</span>
                          <span className="text-white font-medium">${Math.round(selectedEconomyEvent.meta?.team_avg_remaining)?.toLocaleString()}</span>
                        </div>
                      </div>

                      {selectedEconomyEvent.meta && (
                        <div>
                          <div className="text-xs font-medium text-gray-400 mb-2">Flagged Player&apos;s Equipment:</div>
                          <div className="bg-secondary/50 rounded p-2">
                            <div className="flex items-center justify-between mb-1">
                              <span className="text-white text-sm font-medium">{getPlayerName(selectedEconomyEvent.actorSteamId)}</span>
                              <span className="text-xs text-gray-400">
                                ${selectedEconomyEvent.meta?.remaining_money}
                                <span className="ml-1 text-[10px] text-gray-500">Remaining</span>
                              </span>
                            </div>
                            <div className="flex flex-wrap gap-1">
                              {selectedEconomyEvent.meta.weapon_details?.length ? (
                                selectedEconomyEvent.meta.weapon_details.map((weapon: any, widx: number) => (
                                  <span key={widx} className={`text-xs rounded px-2 py-1 font-medium ${
                                    weapon.purchase === 'bought' ? 'bg-red-500/20 text-red-400' :
                                    weapon.purchase === 'saved' ? 'bg-green-500/20 text-green-400' :
                                    'bg-yellow-500/20 text-yellow-400'
                                  }`}>
                                    {weapon.name} ({weapon.purchase === 'likely_bought' ? '~' : ''}{weapon.purchase})
                                  </span>
                                ))
                              ) : (
                                <span className="text-xs text-gray-500">Nothing bought</span>
                              )}
                            </div>
                          </div>
                        </div>
                      )}

                      {selectedEconomyEvent.meta?.other_players && selectedEconomyEvent.meta.other_players.length > 0 && (
                        <div>
                          <div className="text-xs font-medium text-gray-400 mb-2">Team Equipment:</div>
                          <div className="space-y-2">
                            {selectedEconomyEvent.meta.other_players.map((player: any, pidx: number) => (
                              <div key={pidx} className="bg-secondary/50 rounded p-2">
                                <div className="flex items-center justify-between mb-1">
                                  <span className="text-white text-sm font-medium">{getPlayerName(player.steamid)}</span>
                                  <span className="text-xs text-gray-400">
                                    ${player.money}
                                    <span className="ml-1 text-[10px] text-gray-500">Remaining</span>
                                  </span>
                                </div>
                                <div className="flex flex-wrap gap-1">
                                  {player.weapons?.length ? (
                                    player.weapons.map((w: string, widx: number) => (
                                      <span key={widx} className="text-xs bg-secondary rounded px-2 py-1 text-gray-300">
                                        {w}
                                      </span>
                                    ))
                                  ) : (
                                    <span className="text-xs text-gray-500">Nothing bought</span>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
