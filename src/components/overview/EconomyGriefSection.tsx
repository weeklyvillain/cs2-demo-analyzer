import { useState } from 'react'
import { ChevronDown, ChevronUp, Play, Info, X, Map as MapIcon } from 'lucide-react'
import { t } from '../../utils/translations'
import type { Player, PlayerEvent } from '../../types/matches'

// Custom dollar sign icon for economy griefing
const DollarIcon = () => (
  <svg width="18" height="18" viewBox="0 0 128 128" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="64" cy="64" r="54" fill="#F4C430"/>
    <circle cx="64" cy="64" r="44" fill="#FFD966"/>
    <text x="64" y="78" textAnchor="middle" fontSize="48" fontWeight="bold" fill="#B8860B">$</text>
  </svg>
)

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

export default function EconomyGriefSection({
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
  const [selectedEvent, setSelectedEvent] = useState<any | null>(null)

  const getPlayerName = (steamId: string | null | undefined) =>
    allPlayers.find(p => p.steamId === steamId)?.name || steamId || t('matches.unknown')

  if (events.length === 0) return null

  const griefTypeLabels: Record<string, string> = {
    'equipment_mismatch': 'Wrong weapon choice',
    'no_buy_with_team': 'Not buying with team',
    'excessive_saving': 'Excessive saving',
    'full_save_high_money': 'Full save with high money',
  }

  return (
    <>
      <div className="bg-surface border border-border rounded-lg p-4">
        <div className="flex items-center justify-between mb-3">
          <button
            onClick={onToggle}
            className="flex items-center gap-2 text-lg font-semibold text-white hover:text-yellow-400 transition-colors"
          >
            <DollarIcon />
            Economy Griefing
            {expanded ? <ChevronDown size={18} className="text-gray-500" /> : <ChevronUp size={18} className="text-gray-500" />}
          </button>
        </div>
        {expanded && (
          <div className="flex flex-wrap gap-4">
            {events
              .sort((a, b) => a.roundIndex - b.roundIndex)
              .map((econ, idx) => {
                const griefType = econ.meta?.grief_type || 'unknown'
                const startMoney = econ.meta?.start_money || 0
                const moneySpent = econ.meta?.money_spent || 0
                const spendPct = econ.meta?.spend_pct || 0
                const teamAvgSpend = econ.meta?.team_avg_spend || 0
                const teamAvgMoney = econ.meta?.team_avg_money || 0
                const teamSpendPct = econ.meta?.team_spend_pct || 0

                return (
                  <div key={idx} className="bg-secondary border border-border rounded p-3 min-w-[320px]">
                    <div className="flex items-center justify-between mb-2">
                      <span className="font-medium text-white">{getPlayerName(econ.actorSteamId)}</span>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => setSelectedEvent(econ)}
                          className="p-1 hover:bg-accent/20 rounded transition-colors"
                          title="View details"
                        >
                          <Info size={14} className="text-gray-400 hover:text-accent" />
                        </button>
                        <span className="text-xs text-gray-400">Round {econ.roundIndex + 1}</span>
                        {demoPath && (
                          <div className="flex items-center gap-1">
                            {hasRadar && (
                              <button
                                onClick={() => {
                                  const previewSeconds = 5
                                  const previewTicks = previewSeconds * tickRate
                                  const targetTick = Math.max(0, econ.startTick - previewTicks)
                                  onSetViewer2D({ roundIndex: econ.roundIndex, tick: targetTick })
                                }}
                                className="p-1 hover:bg-accent/20 rounded transition-colors"
                                title={t('matches.viewIn2D')}
                              >
                                <MapIcon size={14} className="text-gray-400 hover:text-accent" />
                              </button>
                            )}
                            <button
                              onClick={() => onWatchAtTick(econ.startTick, getPlayerName(econ.actorSteamId) as string, econ.roundIndex)}
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
                      {griefTypeLabels[griefType] || griefType}
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
              })}
          </div>
        )}
      </div>

      {selectedEvent && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-surface border border-border rounded-lg max-w-md w-full max-h-[80vh] overflow-y-auto">
            <div className="sticky top-0 bg-surface border-b border-border p-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-white">
                {getPlayerName(selectedEvent.actorSteamId)} - Round {selectedEvent.roundIndex + 1}
              </h2>
              <button
                onClick={() => setSelectedEvent(null)}
                className="p-1 hover:bg-secondary rounded transition-colors"
              >
                <X size={18} className="text-gray-400" />
              </button>
            </div>

            <div className="p-4 space-y-4">
              {/* Grief type */}
              <div>
                <div className="text-xs font-medium text-gray-400 mb-1">Grief Type:</div>
                <div className="text-yellow-400 font-medium">
                  {selectedEvent.meta?.grief_type === 'equipment_mismatch' && 'Wrong weapon choice'}
                  {selectedEvent.meta?.grief_type === 'no_buy_with_team' && 'Not buying with team'}
                  {selectedEvent.meta?.grief_type === 'excessive_saving' && 'Excessive saving'}
                  {selectedEvent.meta?.grief_type === 'full_save_high_money' && 'Full save with high money'}
                  {!['equipment_mismatch', 'no_buy_with_team', 'excessive_saving', 'full_save_high_money'].includes(selectedEvent.meta?.grief_type) && selectedEvent.meta?.grief_type}
                </div>
              </div>

              {/* Economy stats */}
              <div className="bg-secondary/50 rounded p-3 space-y-2">
                <div className="flex justify-between text-xs">
                  <span className="text-gray-400">Start money:</span>
                  <span className="text-white font-medium">${selectedEvent.meta?.start_money?.toLocaleString()}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-gray-400">Spent:</span>
                  <span className="text-white font-medium">${selectedEvent.meta?.money_spent?.toLocaleString()} ({selectedEvent.meta?.spend_pct?.toFixed(1)}%)</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-gray-400">Remaining:</span>
                  <span className="text-white font-medium">${selectedEvent.meta?.remaining_money?.toLocaleString()}</span>
                </div>
              </div>

              {/* Team stats */}
              <div className="bg-secondary/50 rounded p-3 space-y-2">
                <div className="text-xs font-medium text-gray-400 mb-2">Team Average:</div>
                <div className="flex justify-between text-xs">
                  <span className="text-gray-400">Start money:</span>
                  <span className="text-white font-medium">${Math.round(selectedEvent.meta?.team_avg_money)?.toLocaleString()}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-gray-400">Spent:</span>
                  <span className="text-white font-medium">${Math.round(selectedEvent.meta?.team_avg_spend)?.toLocaleString()} ({selectedEvent.meta?.team_spend_pct?.toFixed(1)}%)</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-gray-400">Remaining:</span>
                  <span className="text-white font-medium">${Math.round(selectedEvent.meta?.team_avg_remaining)?.toLocaleString()}</span>
                </div>
              </div>

              {/* Weapons */}
              {selectedEvent.meta && (
                <div>
                  <div className="text-xs font-medium text-gray-400 mb-2">Flagged Player's Equipment:</div>
                  <div className="bg-secondary/50 rounded p-2">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-white text-sm font-medium">{getPlayerName(selectedEvent.actorSteamId)}</span>
                      <span className="text-xs text-gray-400">
                        ${selectedEvent.meta?.remaining_money}
                        <span className="ml-1 text-[10px] text-gray-500">Remaining</span>
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {selectedEvent.meta.weapon_details?.length ? (
                        selectedEvent.meta.weapon_details.map((weapon: any, widx: number) => (
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

              {/* Team Equipment */}
              {selectedEvent.meta?.other_players && selectedEvent.meta.other_players.length > 0 && (
                <div>
                  <div className="text-xs font-medium text-gray-400 mb-2">Team Equipment:</div>
                  <div className="space-y-2">
                    {selectedEvent.meta.other_players.map((player: any, pidx: number) => (
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
    </>
  )
}
