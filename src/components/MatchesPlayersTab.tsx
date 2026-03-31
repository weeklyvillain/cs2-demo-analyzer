import { useState, useMemo } from 'react'
import { Mic, Play, UserPlus, UserMinus } from 'lucide-react'
import { t } from '../utils/translations'
import type { Match, PlayerScore, Player } from '../types/matches'

type PlayerSortField = 'name' | 'teamKills' | 'teamDamage' | 'teamFlashSeconds' | 'afkSeconds'

type ScoredPlayer = PlayerScore & {
  team: string | null
  connectedMidgame?: boolean
  permanentDisconnect?: boolean
  firstConnectRound?: number | null
  disconnectRound?: number | null
}

interface Props {
  scores: PlayerScore[]
  allPlayers: Player[]
  demoPath: string | null
  selectedMatch: Match
  onPlayerClick: (player: PlayerScore) => void
  onExtractVoice: (player: PlayerScore, e?: React.MouseEvent) => void
  onExtractTeamVoice: (teamName: string, teamPlayers: PlayerScore[], e?: React.MouseEvent) => void
  onWatchPOV: (score: PlayerScore & { team?: string | null }) => void
}

export default function MatchesPlayersTab({
  scores,
  allPlayers,
  selectedMatch,
  demoPath,
  onPlayerClick,
  onExtractVoice,
  onExtractTeamVoice,
  onWatchPOV,
}: Props) {
  const [playerSortField, setPlayerSortField] = useState<PlayerSortField>('teamKills')
  const [playerSortDirection, setPlayerSortDirection] = useState<'asc' | 'desc'>('desc')

  const allPlayersWithScores = useMemo(() => {
    const scoresMap = new Map(scores.map(score => [score.steamId, score]))

    return allPlayers.map(player => {
      const score = scoresMap.get(player.steamId)
      if (score) {
        return {
          ...score,
          team: player.team,
          connectedMidgame: player.connectedMidgame,
          permanentDisconnect: player.permanentDisconnect,
          firstConnectRound: player.firstConnectRound,
          disconnectRound: player.disconnectRound,
        } as ScoredPlayer
      }
      return {
        matchId: selectedMatch.id,
        steamId: player.steamId,
        name: player.name || player.steamId,
        team: player.team,
        teamKills: 0,
        teamDamage: 0,
        teamFlashSeconds: 0,
        afkSeconds: 0,
        bodyBlockSeconds: 0,
        griefScore: 0,
        connectedMidgame: player.connectedMidgame,
        permanentDisconnect: player.permanentDisconnect,
        firstConnectRound: player.firstConnectRound,
        disconnectRound: player.disconnectRound,
      } as ScoredPlayer
    })
  }, [allPlayers, scores, selectedMatch])

  const groupedAndSortedScores = useMemo(() => {
    const teamA: ScoredPlayer[] = []
    const teamB: ScoredPlayer[] = []
    const noTeam: ScoredPlayer[] = []

    allPlayersWithScores.forEach(player => {
      if (player.team === 'A') teamA.push(player)
      else if (player.team === 'B') teamB.push(player)
      else noTeam.push(player)
    })

    const sortPlayers = (players: ScoredPlayer[]) => {
      return [...players].sort((a, b) => {
        if (a.connectedMidgame !== b.connectedMidgame) {
          if (a.connectedMidgame) return 1
          if (b.connectedMidgame) return -1
        }

        let comparison = 0
        if (playerSortField === 'name') {
          comparison = (a.name || a.steamId).localeCompare(b.name || b.steamId)
        } else if (playerSortField === 'teamKills') {
          comparison = a.teamKills - b.teamKills
        } else if (playerSortField === 'teamDamage') {
          comparison = a.teamDamage - b.teamDamage
        } else if (playerSortField === 'teamFlashSeconds') {
          comparison = a.teamFlashSeconds - b.teamFlashSeconds
        } else if (playerSortField === 'afkSeconds') {
          comparison = a.afkSeconds - b.afkSeconds
        }

        return playerSortDirection === 'asc' ? comparison : -comparison
      })
    }

    return {
      teamA: sortPlayers(teamA),
      teamB: sortPlayers(teamB),
      noTeam: sortPlayers(noTeam),
    }
  }, [allPlayersWithScores, playerSortField, playerSortDirection])

  if (allPlayersWithScores.length === 0) {
    return <div className="text-center text-gray-400 py-8">{t('matches.noPlayersAvailable')}</div>
  }

  const renderPlayerCard = (score: ScoredPlayer) => (
    <div
      key={score.steamId}
      className="border border-border/50 rounded p-3 hover:bg-surface/50 transition-colors cursor-pointer"
      onClick={() => onPlayerClick(score)}
    >
      <div className="flex items-center justify-between mb-2">
        <div
          className="font-medium text-white truncate flex-1 flex items-center gap-1.5"
          title={score.name || score.steamId}
        >
          {score.connectedMidgame && (
            <span
              className="text-blue-400 flex-shrink-0 cursor-help"
              title={score.firstConnectRound !== null && score.firstConnectRound !== undefined
                ? t('matches.firstConnectRound').replace('{round}', (score.firstConnectRound + 1).toString())
                : t('matches.connectedMidgame')}
            >
              <UserPlus size={14} />
            </span>
          )}
          {score.permanentDisconnect && (
            <span
              className="text-red-400 flex-shrink-0 cursor-help"
              title={score.disconnectRound !== null && score.disconnectRound !== undefined
                ? t('matches.disconnectRound').replace('{round}', (score.disconnectRound + 1).toString())
                : t('matches.permanentDisconnect')}
            >
              <UserMinus size={14} />
            </span>
          )}
          {score.name || (
            <button
              onClick={async (e) => {
                e.stopPropagation()
                if (window.electronAPI?.openExternal) {
                  await window.electronAPI.openExternal(`https://steamcommunity.com/profiles/${score.steamId}`)
                } else {
                  window.open(`https://steamcommunity.com/profiles/${score.steamId}`, '_blank')
                }
              }}
              className="text-accent hover:text-accent/80 underline bg-transparent border-none cursor-pointer p-0"
            >
              {score.steamId}
            </button>
          )}
        </div>
        <div className="flex items-center gap-1.5 ml-2 flex-shrink-0">
          <button
            onClick={(e) => {
              e.stopPropagation()
              onWatchPOV(score)
            }}
            disabled={!demoPath}
            className="px-2.5 py-1.5 bg-secondary hover:bg-secondary/90 disabled:bg-gray-600 disabled:cursor-not-allowed text-white text-sm rounded transition-colors flex items-center gap-1.5 whitespace-nowrap border border-border"
            title={!demoPath ? t('matches.demoFileRequired') : "Watch game from this player's POV (2x, jump on death)"}
          >
            <Play size={14} />
            <span>Watch POV</span>
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation()
              onExtractVoice(score, e)
            }}
            disabled={!demoPath}
            className="px-2.5 py-1.5 bg-accent hover:bg-accent/90 disabled:bg-gray-600 disabled:cursor-not-allowed text-white text-sm rounded transition-colors flex items-center gap-1.5 whitespace-nowrap"
            title={!demoPath ? t('matches.demoFileRequired') : t('matches.extractVoiceFor').replace('{name}', score.name)}
          >
            <Mic size={14} />
            <span>{t('matches.extractVoice')}</span>
          </button>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs text-gray-300">
        <div>
          <span className="text-gray-400">{t('matches.teamKillsLabel')}</span> {score.teamKills}
        </div>
        <div>
          <span className="text-gray-400">{t('matches.teamDamageLabel')}</span> {score.teamDamage.toFixed(1)}
        </div>
        <div>
          <span className="text-gray-400">{t('matches.flashSecondsLabel')}</span> {score.teamFlashSeconds.toFixed(1)}s
        </div>
        <div>
          <span className="text-gray-400">{t('matches.afkSecondsLabel')}</span> {score.afkSeconds.toFixed(1)}s
        </div>
      </div>
    </div>
  )

  return (
    <div className="overflow-x-auto">
      <div className="grid grid-cols-2 gap-4">
        {/* Team A Column */}
        <div className="flex flex-col">
          <div className="bg-surface/30 border-b border-border pb-2 mb-2 flex items-center justify-between px-2 py-2">
            <h3 className="text-lg font-semibold text-accent">Team A</h3>
            <button
              onClick={(e) => onExtractTeamVoice('Team A', groupedAndSortedScores.teamA, e)}
              disabled={!demoPath || groupedAndSortedScores.teamA.length === 0}
              className="px-2.5 py-1.5 bg-accent hover:bg-accent/90 disabled:bg-gray-600 disabled:cursor-not-allowed text-white text-xs rounded transition-colors flex items-center gap-1.5"
              title={!demoPath ? t('matches.demoFileRequired') : 'Extract team voice'}
            >
              <Mic size={12} />
              <span>Team Voice</span>
            </button>
          </div>
          {groupedAndSortedScores.teamA.length === 0 ? (
            <div className="text-center text-gray-400 py-4 text-sm">No players</div>
          ) : (
            <div className="space-y-2">
              {groupedAndSortedScores.teamA.map(renderPlayerCard)}
            </div>
          )}
        </div>

        {/* Team B Column */}
        <div className="flex flex-col">
          <div className="bg-surface/30 border-b border-border pb-2 mb-2 flex items-center justify-between px-2 py-2">
            <h3 className="text-lg font-semibold text-accent">Team B</h3>
            <button
              onClick={(e) => onExtractTeamVoice('Team B', groupedAndSortedScores.teamB, e)}
              disabled={!demoPath || groupedAndSortedScores.teamB.length === 0}
              className="px-2.5 py-1.5 bg-accent hover:bg-accent/90 disabled:bg-gray-600 disabled:cursor-not-allowed text-white text-xs rounded transition-colors flex items-center gap-1.5"
              title={!demoPath ? t('matches.demoFileRequired') : 'Extract team voice'}
            >
              <Mic size={12} />
              <span>Team Voice</span>
            </button>
          </div>
          {groupedAndSortedScores.teamB.length === 0 ? (
            <div className="text-center text-gray-400 py-4 text-sm">{t('matches.noPlayers')}</div>
          ) : (
            <div className="space-y-2">
              {groupedAndSortedScores.teamB.map(renderPlayerCard)}
            </div>
          )}
        </div>
      </div>

      {/* Unknown Team (if any) */}
      {groupedAndSortedScores.noTeam.length > 0 && (
        <div className="mt-6">
          <div className="bg-surface/30 border-b border-border pb-2 mb-2">
            <h3 className="text-lg font-semibold text-gray-400 px-2">Unknown Team</h3>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {groupedAndSortedScores.noTeam.map((score) => (
              <div
                key={score.steamId}
                className="border border-border/50 rounded p-3 hover:bg-surface/50 transition-colors cursor-pointer"
                onClick={() => onPlayerClick(score)}
              >
                <div className="flex items-center justify-between mb-2">
                  <div
                    className="font-medium text-white truncate flex-1 flex items-center gap-1.5"
                    title={score.name || score.steamId}
                  >
                    {score.connectedMidgame && (
                      <UserPlus
                        size={14}
                        className="text-blue-400 flex-shrink-0"
                        title={t('matches.connectedMidgame')}
                      />
                    )}
                    {score.permanentDisconnect && (
                      <UserMinus
                        size={14}
                        className="text-red-400 flex-shrink-0"
                        title={t('matches.permanentDisconnect')}
                      />
                    )}
                    {score.name || (
                      <button
                        onClick={async (e) => {
                          e.stopPropagation()
                          if (window.electronAPI?.openExternal) {
                            await window.electronAPI.openExternal(`https://steamcommunity.com/profiles/${score.steamId}`)
                          } else {
                            window.open(`https://steamcommunity.com/profiles/${score.steamId}`, '_blank')
                          }
                        }}
                        className="text-accent hover:text-accent/80 underline bg-transparent border-none cursor-pointer p-0"
                      >
                        {score.steamId}
                      </button>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 ml-2 flex-shrink-0">
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        onWatchPOV(score)
                      }}
                      disabled={!demoPath}
                      className="px-2.5 py-1.5 bg-secondary hover:bg-secondary/90 disabled:bg-gray-600 disabled:cursor-not-allowed text-white text-sm rounded transition-colors flex items-center gap-1.5 whitespace-nowrap border border-border"
                      title={!demoPath ? t('matches.demoFileRequired') : "Watch game from this player's POV (2x, jump on death)"}
                    >
                      <Play size={14} />
                      <span>Watch POV</span>
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        onExtractVoice(score, e)
                      }}
                      disabled={!demoPath}
                      className="px-2.5 py-1.5 bg-accent hover:bg-accent/90 disabled:bg-gray-600 disabled:cursor-not-allowed text-white text-sm rounded transition-colors flex items-center gap-1.5 whitespace-nowrap"
                      title={!demoPath ? t('matches.demoFileRequired') : t('matches.extractVoiceFor').replace('{name}', score.name)}
                    >
                      <Mic size={14} />
                      <span>{t('matches.extractVoice')}</span>
                    </button>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs text-gray-300">
                  <div>
                    <span className="text-gray-400">{t('matches.teamKillsLabel')}</span> {score.teamKills}
                  </div>
                  <div>
                    <span className="text-gray-400">{t('matches.teamDamageLabel')}</span> {score.teamDamage.toFixed(1)}
                  </div>
                  <div>
                    <span className="text-gray-400">{t('matches.flashSecondsLabel')}</span> {score.teamFlashSeconds.toFixed(1)}s
                  </div>
                  <div>
                    <span className="text-gray-400">{t('matches.afkSecondsLabel')}</span> {score.afkSeconds.toFixed(1)}s
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
