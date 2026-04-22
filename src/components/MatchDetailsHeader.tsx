import { Clock, Download } from 'lucide-react'
import type { ActiveTab, MatchStats, Round, Player } from '../types/matches'
import { t } from '../utils/translations'

interface MatchDetailsHeaderProps {
  selectedMatch: string
  matchStats: Map<string, MatchStats>
  rounds: Round[]
  tickRate: number
  allPlayers: Player[]
  demoPath: string | null
  activeTab: ActiveTab
  setActiveTab: (tab: ActiveTab) => void
  hasRadarForCurrentMap: boolean
  buildNum: number | null
  latestCS2Build: number | null
  onWatchInCS2: () => void
  onOpenExportPanel: () => void
  onFetchChatMessages: (matchId: string) => void
}

export default function MatchDetailsHeader({
  selectedMatch,
  matchStats,
  rounds,
  tickRate,
  allPlayers,
  demoPath,
  activeTab,
  setActiveTab,
  hasRadarForCurrentMap,
  buildNum,
  latestCS2Build,
  onWatchInCS2,
  onOpenExportPanel,
  onFetchChatMessages,
}: MatchDetailsHeaderProps) {
  return (
    <div className="mb-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-6">
          <h3 className="font-semibold text-lg">Match: {selectedMatch}</h3>
          {/* Match Info Row */}
          <div className="flex items-center gap-4 text-sm text-gray-400">
            {/* Time */}
            {(() => {
              const stats = matchStats.get(selectedMatch)
              let duration = stats?.duration
              // Fallback: calculate from rounds if stats not available
              if (!duration && rounds.length > 0) {
                const firstRound = rounds[0]
                const lastRound = rounds[rounds.length - 1]
                const startTick = firstRound.startTick || 0
                const endTick = lastRound.endTick || startTick
                duration = (endTick - startTick) / tickRate
              }
              if (duration && duration > 0) {
                const minutes = Math.floor(duration / 60)
                const seconds = Math.floor(duration % 60)
                return (
                  <div className="flex items-center gap-1">
                    <Clock size={14} />
                    <span>{minutes}:{seconds.toString().padStart(2, '0')}</span>
                  </div>
                )
              }
              return null
            })()}
            {/* Rounds */}
            {(() => {
              const roundCount = rounds.length || matchStats.get(selectedMatch)?.roundCount || 0
              if (roundCount > 0) {
                return (
                  <div className="flex items-center gap-1">
                    <span>{t('matches.rounds')}: {roundCount}</span>
                  </div>
                )
              }
              return null
            })()}
            {/* Players */}
            {allPlayers.length > 0 && (
              <div className="flex items-center gap-1">
                <span>{t('matches.players')}: {allPlayers.length}</span>
              </div>
            )}
            {/* Score */}
            {(() => {
              const stats = matchStats.get(selectedMatch)
              let tWins = stats?.tWins
              let ctWins = stats?.ctWins
              // Fallback: get from last round if stats not available
              if ((!tWins && !ctWins) && rounds.length > 0) {
                const lastRound = rounds[rounds.length - 1]
                tWins = lastRound.tWins || 0
                ctWins = lastRound.ctWins || 0
              }
              if ((tWins || ctWins) && (tWins > 0 || ctWins > 0)) {
                // In the parser, first T team seen = Team A, first CT team seen = Team B
                // So T = Team A, CT = Team B
                const teamAWins = tWins || 0
                const teamBWins = ctWins || 0
                return (
                  <div className="flex items-center gap-1">
                    <span className="text-orange-400">Team A: {teamAWins}</span>
                    <span className="text-gray-500">-</span>
                    <span className="text-blue-400">Team B: {teamBWins}</span>
                  </div>
                )
              }
              return null
            })()}
            {/* Old Version badge */}
            {buildNum != null && latestCS2Build != null && String(buildNum).slice(0, 4) !== String(latestCS2Build).slice(0, 4) && (
              <div
                className="px-1.5 py-0.5 text-xs font-semibold rounded bg-amber-500/90 text-black cursor-default"
                title={`Demo build: #${buildNum} · Current: #${latestCS2Build} · This version may no longer be playable in-game`}
              >
                Old Version
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {demoPath && (
            <>
              <button
                onClick={onWatchInCS2}
                className="px-3 py-1.5 bg-accent text-white text-sm rounded hover:bg-accent/80 transition-colors flex items-center gap-1"
                title="Launch CS2 and watch this demo"
              >
                <span>🎮</span>
                <span>Watch in CS2</span>
              </button>
              {
                false && (
                  <button
                    onClick={onOpenExportPanel}
                    className="px-3 py-1.5 bg-accent text-white text-sm rounded hover:bg-accent/80 transition-colors flex items-center gap-1"
                    title="Export clips from incidents"
                  >
                    <Download size={16} />
                    <span>Export Clips</span>
                  </button>)
              }
            </>
          )}
        </div>
      </div>
      <div className="flex gap-2 border-b border-border">
        <button
          onClick={() => setActiveTab('overview')}
          className={`px-4 py-2 font-medium transition-colors ${
            activeTab === 'overview'
              ? 'text-accent border-b-2 border-accent'
              : 'text-gray-400 hover:text-white'
          }`}
        >
          {t('matches.tabs.overview')}
        </button>
        <button
          onClick={() => setActiveTab('rounds')}
          className={`px-4 py-2 font-medium transition-colors ${
            activeTab === 'rounds'
              ? 'text-accent border-b-2 border-accent'
              : 'text-gray-400 hover:text-white'
          }`}
        >
          {t('matches.tabs.rounds')}
        </button>
        <button
          onClick={() => setActiveTab('players')}
          className={`px-4 py-2 font-medium transition-colors ${
            activeTab === 'players'
              ? 'text-accent border-b-2 border-accent'
              : 'text-gray-400 hover:text-white'
          }`}
        >
          {t('matches.tabs.players')}
        </button>
        <button
          onClick={() => {
            setActiveTab('chat')
            onFetchChatMessages(selectedMatch)
          }}
          className={`px-4 py-2 font-medium transition-colors ${
            activeTab === 'chat'
              ? 'text-accent border-b-2 border-accent'
              : 'text-gray-400 hover:text-white'
          }`}
        >
          {t('matches.tabs.chat')}
        </button>
        {hasRadarForCurrentMap && (
          <button
            onClick={() => {
              setActiveTab('2d-viewer')
            }}
            className={`px-4 py-2 font-medium transition-colors ${
              activeTab === '2d-viewer'
                ? 'text-accent border-b-2 border-accent'
                : 'text-gray-400 hover:text-white'
            }`}
          >
            <span className="flex items-center gap-2">
              {t('matches.tabs.viewer2d')}
              <span className="px-1.5 py-0.5 text-xs bg-yellow-900/30 text-yellow-400 rounded border border-yellow-500/30">
                WIP
              </span>
            </span>
          </button>
        )}
      </div>
    </div>
  )
}
