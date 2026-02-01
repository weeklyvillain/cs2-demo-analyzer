import { useState, useEffect, useMemo } from 'react'
import Viewer2D from './Viewer2D'
import Modal from './Modal'
import PlayerModal from './PlayerModal'
import ParsingModal from './ParsingModal'
import VoicePlaybackModal from './VoicePlaybackModal'
import TeamCommsModal from './TeamCommsModal'
import ParserLogsModal from './ParserLogsModal'
import Toast from './Toast'
import { ClipExportPanel } from './ClipExportPanel'
import type { ClipRange } from './ClipExportPanel'
import { formatDisconnectReason } from '../utils/disconnectReason'
import { t } from '../utils/translations'
import { Clock, Skull, Zap, WifiOff, ChevronDown, ChevronUp, Copy, Play, Check, ArrowUp, ArrowDown, Trash2, X, Plus, Loader2, Mic, FolderOpen, Database, RefreshCw, Upload, Map as MapIcon, UserPlus, UserMinus, FileText, Download, Info } from 'lucide-react'

// Custom dollar sign icon for economy griefing
const DollarIcon = () => (
  <svg width="18" height="18" viewBox="0 0 128 128" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="64" cy="64" r="54" fill="#F4C430"/>
    <circle cx="64" cy="64" r="44" fill="#FFD966"/>
    <text x="64" y="78" textAnchor="middle" fontSize="48" fontWeight="bold" fill="#B8860B">$</text>
  </svg>
)

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

interface Match {
  id: string
  map: string
  startedAt: string | null
  playerCount: number
  demoPath?: string | null
  isMissingDemo?: boolean
  createdAtIso?: string | null
  source?: string | null
}

interface MatchStats {
  roundCount: number
  duration: number // Duration in seconds
  teamKills: number
  teamDamage: number
  afkSeconds: number
  teamFlashSeconds: number
  disconnects: number
  tWins: number
  ctWins: number
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
  economyGriefCount: number
  griefScore: number
}

interface Round {
  roundIndex: number
  startTick: number
  endTick: number
  freezeEndTick: number | null
  tWins: number
  ctWins: number
  winner: string | null
}

interface RoundStats {
  roundIndex: number
  teamKills: number
  teamDamage: number
  teamFlashSeconds: number
  afkSeconds: number
  events: Array<{
    type: string
    actorSteamId: string
    victimSteamId: string | null
    startTick: number
    endTick: number | null
    meta: any
  }>
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

function MatchesScreen() {
  const [matches, setMatches] = useState<Match[]>([])
  const [selectedMatch, setSelectedMatch] = useState<string | null>(null)
  const [scores, setScores] = useState<PlayerScore[]>([])
  const [rounds, setRounds] = useState<Round[]>([])
  const [roundStats, setRoundStats] = useState<Map<number, RoundStats>>(new Map())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<{ message: string; type?: 'success' | 'error' | 'info' } | null>(null)
  const [activeTab, setActiveTab] = useState<'overview' | 'players' | 'rounds' | 'chat' | '2d-viewer'>('overview')
  const [allEvents, setAllEvents] = useState<any[]>([])
  const [allPlayers, setAllPlayers] = useState<Array<{ 
    steamId: string
    name: string
    team: string | null
    connectedMidgame?: boolean
    permanentDisconnect?: boolean
    firstConnectRound?: number | null
    disconnectRound?: number | null
  }>>([])
  const [selectedPlayer, setSelectedPlayer] = useState<PlayerScore | null>(null)
  const [playerEvents, setPlayerEvents] = useState<PlayerEvent[]>([])
  const [loadingEvents, setLoadingEvents] = useState(false)
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set())
  const [expandedSections, setExpandedSections] = useState({
    afk: true,
    teamKills: true,
    teamDamage: true,
    disconnects: true,
    teamFlashes: true,
    economy: true,
    bodyBlock: true,
  })
  const [selectedEconomyEvent, setSelectedEconomyEvent] = useState<any | null>(null)
  const [afkMinSeconds, setAfkMinSeconds] = useState<number>(10)
  const [flashMinSeconds, setFlashMinSeconds] = useState<number>(1.5)
  const [afkSortBy, setAfkSortBy] = useState<'round' | 'duration'>('round')
  const [demoPath, setDemoPath] = useState<string | null>(null)
  const [tickRate, setTickRate] = useState<number>(64) // Default tick rate
  const [chatMessages, setChatMessages] = useState<Array<{ matchId: string; roundIndex: number; tick: number; steamid: string; name: string; team: string | null; message: string; isTeamChat: boolean }>>([])
  const [loadingChat, setLoadingChat] = useState(false)
  const [chatFilterSteamId, setChatFilterSteamId] = useState<string | null>(null)
  const [chatViewMode, setChatViewMode] = useState<'all-chat'>('all-chat')
  const [viewer2D, setViewer2D] = useState<{ roundIndex: number; tick: number } | null>(null)
  const [showMatchOverview, setShowMatchOverview] = useState(false)
  const [matchStats, setMatchStats] = useState<Map<string, MatchStats>>(new Map())
  const [sortField, setSortField] = useState<'id' | 'length' | 'map' | 'date'>('date')
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc')
  const [playerSortField, setPlayerSortField] = useState<'name' | 'teamKills' | 'teamDamage' | 'teamFlashSeconds' | 'afkSeconds'>('teamKills')
  const [playerSortDirection, setPlayerSortDirection] = useState<'asc' | 'desc'>('desc')
  const [selectedMatches, setSelectedMatches] = useState<Set<string>>(new Set())
  const [showDeleteModal, setShowDeleteModal] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [showDemoLoadModal, setShowDemoLoadModal] = useState(false)
  const [pendingDemoAction, setPendingDemoAction] = useState<{ demoPath: string; startTick: number; playerName: string } | null>(null)
  const [showParsingModal, setShowParsingModal] = useState(false)
  const [demoToParse, setDemoToParse] = useState<string | null>(null)
  const [demosToParse, setDemosToParse] = useState<string[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const [showVoiceModal, setShowVoiceModal] = useState(false)
  const [voicePlayerSteamId, setVoicePlayerSteamId] = useState<string>('')
  const [voicePlayerName, setVoicePlayerName] = useState<string>('')
  const [showTeamCommsModal, setShowTeamCommsModal] = useState(false)
  const [teamCommsPlayers, setTeamCommsPlayers] = useState<Array<{ steamId: string; name: string }>>([])
  const [teamCommsName, setTeamCommsName] = useState<string>('')
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; match: Match } | null>(null)
  const [enableDbViewer, setEnableDbViewer] = useState(false)
  const [searchQuery, setSearchQuery] = useState<string>('')
  const [showParserLogsModal, setShowParserLogsModal] = useState(false)
  const [selectedMatchForLogs, setSelectedMatchForLogs] = useState<string | null>(null)
  const [, forceUpdate] = useState(0) // Force re-render when language changes
  const [showExportPanel, setShowExportPanel] = useState(false)

  // Listen for language changes
  useEffect(() => {
    const checkLanguage = () => {
      forceUpdate((prev) => prev + 1)
    }
    // Check language every second (simple polling approach)
    const interval = setInterval(checkLanguage, 1000)
    return () => clearInterval(interval)
  }, [])

  // Load DB viewer setting
  useEffect(() => {
    const loadDbViewerSetting = async () => {
      if (window.electronAPI) {
        const value = await window.electronAPI.getSetting('enable_db_viewer', 'false')
        setEnableDbViewer(value === 'true')
      }
    }
    loadDbViewerSetting()
    
    // Listen for setting changes
    const interval = setInterval(loadDbViewerSetting, 1000)
    return () => clearInterval(interval)
  }, [])

  const fetchMatches = async () => {
    if (!window.electronAPI) {
      setError(t('matches.electronApiNotAvailable'))
      return
    }

    setLoading(true)
    setError(null)

    try {
      const data = await window.electronAPI.listMatches()
      setMatches(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('matches.failedToLoadMatches'))
    } finally {
      setLoading(false)
    }
  }

  const fetchChatMessages = async (matchId: string, steamid?: string) => {
    if (!window.electronAPI) {
      setError(t('matches.electronApiNotAvailable'))
      return
    }

    setLoadingChat(true)
    setError(null)

    try {
      const chatData = await window.electronAPI.getMatchChat(matchId, steamid)
      const messages = chatData.messages || []
      
      // Also fetch disconnect events to enrich disconnect messages with reason
      const disconnectEvents = await window.electronAPI.getMatchEvents(matchId, {
        type: 'DISCONNECT',
        steamid: steamid
      })
      
      // Create a map of disconnect events by steamid and tick (for matching)
      const disconnectEventMap = new Map<string, any>()
      ;(disconnectEvents.events || []).forEach((event: any) => {
        if (event.actorSteamId) {
          // Parse meta if it's a string
          if (event.meta && typeof event.meta === 'string') {
            try {
              event.meta = JSON.parse(event.meta)
            } catch (e) {
              console.warn('Failed to parse disconnect event meta:', e)
            }
          }
          // Use steamid + tick as key for matching
          const key = `${event.actorSteamId}-${event.startTick}`
          disconnectEventMap.set(key, event)
        }
      })
      
      console.log('Disconnect events found:', disconnectEvents.events?.length || 0)
      console.log('Disconnect messages in chat:', messages.filter((m: any) => m.message?.toLowerCase().includes('left the game')).length)
      
      // Update disconnect messages in chat with disconnect reason
      const enrichedMessages = messages.map((msg: any) => {
        // Check if this is a disconnect message (contains "left the game" or similar)
        const isDisconnectMessage = msg.message && (
          msg.message.toLowerCase().includes('left the game') ||
          msg.message.toLowerCase().includes('disconnected') ||
          msg.message.toLowerCase().includes('disconnect')
        )
        
        if (isDisconnectMessage && msg.steamid) {
          // Try to find matching disconnect event
          // Match by steamid and tick (within ±500 ticks tolerance for better matching)
          let matchingEvent: any = null
          let closestTickDiff = Infinity
          
          for (const [key, event] of disconnectEventMap.entries()) {
            if (key.startsWith(`${msg.steamid}-`)) {
              const eventTick = event.startTick || 0
              const msgTick = msg.tick || 0
              const tickDiff = Math.abs(eventTick - msgTick)
              // Match if within ±500 ticks and closer than previous match
              if (tickDiff <= 500 && tickDiff < closestTickDiff) {
                matchingEvent = event
                closestTickDiff = tickDiff
              }
            }
          }
          
          if (matchingEvent) {
            // Parse meta if it's a string
            let reason: any = null
            if (matchingEvent.meta) {
              if (typeof matchingEvent.meta === 'string') {
                try {
                  const parsedMeta = JSON.parse(matchingEvent.meta)
                  reason = parsedMeta.reason
                } catch {
                  reason = matchingEvent.meta.reason
                }
              } else {
                reason = matchingEvent.meta.reason
              }
            }
            
            if (reason) {
              console.log('Found disconnect reason for', msg.steamid, ':', reason)
              // Update message with disconnect reason
              return {
                ...msg,
                message: `${msg.message} (${formatDisconnectReason(reason)})`
              }
            } else {
              console.log('No reason found for disconnect event:', matchingEvent)
            }
          } else {
            console.log('No matching disconnect event found for message:', msg.message, 'steamid:', msg.steamid, 'tick:', msg.tick)
          }
        }
        return msg
      })
      
      // Combine and sort by tick
      const allMessages = enrichedMessages.sort((a, b) => a.tick - b.tick)
      setChatMessages(allMessages)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load chat messages')
    } finally {
      setLoadingChat(false)
    }
  }

  const fetchMatchData = async (matchId: string) => {
    if (!window.electronAPI) {
      setError(t('matches.electronApiNotAvailable'))
      return
    }

    setLoading(true)
    setError(null)
    setSelectedMatch(matchId)
    setActiveTab('overview')

    try {
      // Fetch summary, players, rounds, and events
      const [summaryData, playersData, roundsData, eventsData] = await Promise.all([
        window.electronAPI.getMatchSummary(matchId),
        window.electronAPI.getMatchPlayers(matchId),
        window.electronAPI.getMatchRounds(matchId),
        window.electronAPI.getMatchEvents(matchId),
      ])

      setScores(summaryData.players || [])
      setAllPlayers(playersData.players || [])
      setRounds(roundsData.rounds || [])
      setAllEvents(eventsData.events || [])
      
      // Get tick rate from rounds data
      if (roundsData.tickRate) {
        setTickRate(roundsData.tickRate)
      }
      
      // Get demo path from match data if available
      const match = matches.find((m) => m.id === matchId)
      if (match?.demoPath) {
        setDemoPath(match.demoPath)
      }

      // Group events by round and calculate stats
      const statsByRound = new Map<number, RoundStats>()
      
      for (const round of roundsData.rounds || []) {
        const roundEvents = (eventsData.events || []).filter(
          (e: any) => e.roundIndex === round.roundIndex
        )

        const teamKills = roundEvents.filter((e: any) => e.type === 'TEAM_KILL').length
        const teamDamage = roundEvents
          .filter((e: any) => e.type === 'TEAM_DAMAGE')
          .reduce((sum: number, e: any) => sum + (e.meta?.total_damage || 0), 0)
        const teamFlash = roundEvents
          .filter((e: any) => e.type === 'TEAM_FLASH')
          .reduce((sum: number, e: any) => sum + (e.meta?.blind_duration || 0), 0)
        const afk = roundEvents
          .filter((e: any) => e.type === 'AFK_STILLNESS')
          .reduce((sum: number, e: any) => {
            // Use meta.seconds or meta.afkDuration if available, otherwise calculate from ticks
            const duration = e.meta?.seconds || e.meta?.afkDuration || (e.endTick && e.startTick ? (e.endTick - e.startTick) / 64 : 0)
            return sum + duration
          }, 0)

        statsByRound.set(round.roundIndex, {
          roundIndex: round.roundIndex,
          teamKills,
          teamDamage,
          teamFlashSeconds: teamFlash,
          afkSeconds: afk,
          events: roundEvents.map((e: any) => ({
            type: e.type,
            actorSteamId: e.actorSteamId,
            victimSteamId: e.victimSteamId,
            startTick: e.startTick,
            endTick: e.endTick,
            meta: e.meta,
          })),
        })
      }

      setRoundStats(statsByRound)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load match data')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchMatches()
    
    // Listen for matches list updates (e.g., after parsing completes)
    if (window.electronAPI?.onMatchesList) {
      window.electronAPI.onMatchesList((matches) => {
        setMatches(matches)
      })
      
      return () => {
        window.electronAPI.removeAllListeners('matches:list')
      }
    }
  }, [])

  // Fetch stats for all matches
  useEffect(() => {
    const fetchAllMatchStats = async () => {
      if (!window.electronAPI || matches.length === 0) return

      const statsMap = new Map<string, MatchStats>()
      
      for (const match of matches) {
        try {
          const [roundsData, eventsData, scoresData] = await Promise.all([
            window.electronAPI.getMatchRounds(match.id),
            window.electronAPI.getMatchEvents(match.id),
            window.electronAPI.getMatchSummary(match.id),
          ])
          
          const rounds = roundsData.rounds || []
          const events = eventsData.events || []
          const scores = scoresData.players || []
          
          // Calculate basic stats
          let roundCount = rounds.length
          let duration = 0
          let tWins = 0
          let ctWins = 0
          
          if (rounds.length > 0) {
            const firstRound = rounds[0]
            const lastRound = rounds[rounds.length - 1]
            const tickRate = 64
            const startTick = firstRound.startTick || 0
            const endTick = lastRound.endTick || startTick
            duration = (endTick - startTick) / tickRate
            
            // Get wins from last round
            if (lastRound.tWins !== undefined) tWins = lastRound.tWins
            if (lastRound.ctWins !== undefined) ctWins = lastRound.ctWins
          }
          
          // Calculate event stats
          const teamKills = events.filter((e: any) => e.type === 'TEAM_KILL').length
          const teamDamage = events
            .filter((e: any) => e.type === 'TEAM_DAMAGE')
            .reduce((sum: number, e: any) => sum + (e.meta?.damage || 0), 0)
          
          // Use pre-calculated AFK seconds from player_scores (sum across all players)
          const afkSeconds = scores.reduce((sum: number, score: any) => sum + (score.afkSeconds || 0), 0)
          
          const teamFlashSeconds = events
            .filter((e: any) => e.type === 'TEAM_FLASH')
            .reduce((sum: number, e: any) => sum + (e.meta?.blind_duration || 0), 0)
          
          const disconnects = events.filter((e: any) => e.type === 'DISCONNECT').length
          
          statsMap.set(match.id, {
            roundCount,
            duration,
            teamKills,
            teamDamage,
            afkSeconds,
            teamFlashSeconds,
            disconnects,
            tWins,
            ctWins,
          })
        } catch (err) {
          // If we can't fetch stats, set defaults
          statsMap.set(match.id, {
            roundCount: 0,
            duration: 0,
            teamKills: 0,
            teamDamage: 0,
            afkSeconds: 0,
            teamFlashSeconds: 0,
            disconnects: 0,
            tWins: 0,
            ctWins: 0,
          })
        }
      }
      
      setMatchStats(statsMap)
    }

    fetchAllMatchStats()
  }, [matches])

  // Filter matches by search query
  const filteredMatches = useMemo(() => {
    if (!searchQuery.trim()) {
      return matches
    }
    
    const query = searchQuery.toLowerCase().trim()
    return matches.filter(match => {
      // Search in match ID
      if (match.id.toLowerCase().includes(query)) {
        return true
      }
      // Search in map name
      if (match.map?.toLowerCase().includes(query)) {
        return true
      }
      // Search in source
      if (match.source?.toLowerCase().includes(query)) {
        return true
      }
      return false
    })
  }, [matches, searchQuery])

  // Sort matches based on current sort settings
  const sortedMatches = useMemo(() => {
    return [...filteredMatches].sort((a, b) => {
      let comparison = 0
      
      if (sortField === 'id') {
        comparison = a.id.localeCompare(b.id)
      } else if (sortField === 'length') {
        const aDuration = matchStats.get(a.id)?.duration || 0
        const bDuration = matchStats.get(b.id)?.duration || 0
        comparison = aDuration - bDuration
      } else if (sortField === 'map') {
        comparison = (a.map || '').localeCompare(b.map || '')
      } else if (sortField === 'date') {
        // Sort by date using epoch timestamps
        // Use startedAt if available, otherwise fall back to createdAtIso
        const getEpochTime = (match: Match): number => {
          if (match.startedAt) {
            const epoch = new Date(match.startedAt).getTime()
            // Check if date is valid (not NaN)
            if (!isNaN(epoch)) {
              return epoch
            }
          }
          // Fallback to createdAtIso if startedAt is not available or invalid
          if (match.createdAtIso) {
            const epoch = new Date(match.createdAtIso).getTime()
            if (!isNaN(epoch)) {
              return epoch
            }
          }
          // Return 0 for invalid/null dates (will be sorted to end)
          return 0
        }
        
        const aEpoch = getEpochTime(a)
        const bEpoch = getEpochTime(b)
        
        if (aEpoch === 0 && bEpoch === 0) {
          comparison = 0
        } else if (aEpoch === 0) {
          comparison = 1 // a goes to end
        } else if (bEpoch === 0) {
          comparison = -1 // b goes to end
        } else {
          comparison = aEpoch - bEpoch
        }
      }
      
      return sortDirection === 'asc' ? comparison : -comparison
    })
  }, [filteredMatches, sortField, sortDirection, matchStats])

  // Merge all players with their scores to show all players in the tab
  const allPlayersWithScores = useMemo(() => {
    // Create a map of scores by steamId for quick lookup
    const scoresMap = new Map(scores.map(score => [score.steamId, score]))
    
    // Merge allPlayers with scores, creating entries for players without scores
    const merged = allPlayers.map(player => {
      const score = scoresMap.get(player.steamId)
      if (score) {
        // Preserve team information and status flags from player data
        return { 
          ...score, 
          team: player.team,
          connectedMidgame: player.connectedMidgame,
          permanentDisconnect: player.permanentDisconnect,
          firstConnectRound: player.firstConnectRound,
          disconnectRound: player.disconnectRound,
        } as PlayerScore & { 
          team: string | null
          connectedMidgame?: boolean
          permanentDisconnect?: boolean
          firstConnectRound?: number | null
          disconnectRound?: number | null
        }
      }
      // Player doesn't have scores, create a default entry
      return {
        matchId: selectedMatch || '',
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
      } as PlayerScore & { 
        team: string | null
        connectedMidgame?: boolean
        permanentDisconnect?: boolean
        firstConnectRound?: number | null
        disconnectRound?: number | null
      }
    })
    
    return merged
  }, [allPlayers, scores, selectedMatch])

  // Group and sort players by team, then by sort settings
  const groupedAndSortedScores = useMemo(() => {
    // Group players by team
    const teamA: Array<PlayerScore & { team: string | null }> = []
    const teamB: Array<PlayerScore & { team: string | null }> = []
    const noTeam: Array<PlayerScore & { team: string | null }> = []
    
    allPlayersWithScores.forEach(player => {
      if (player.team === 'A') {
        teamA.push(player)
      } else if (player.team === 'B') {
        teamB.push(player)
      } else {
        noTeam.push(player)
      }
    })
    
    // Sort function
    const sortPlayers = (players: Array<PlayerScore & { team: string | null; connectedMidgame?: boolean }>) => {
      return [...players].sort((a, b) => {
        // First, sort by connectedMidgame (mid-game connected players last)
        if (a.connectedMidgame !== b.connectedMidgame) {
          if (a.connectedMidgame) return 1  // a is mid-game, put it last
          if (b.connectedMidgame) return -1 // b is mid-game, put it last
        }
        
        let comparison = 0
        
        if (playerSortField === 'name') {
          const aName = a.name || a.steamId
          const bName = b.name || b.steamId
          comparison = aName.localeCompare(bName)
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

  // Handle player table column sorting
  const handlePlayerSort = (field: 'name' | 'teamKills' | 'teamDamage' | 'teamFlashSeconds' | 'afkSeconds') => {
    if (playerSortField === field) {
      // Toggle direction if clicking the same field
      setPlayerSortDirection(playerSortDirection === 'asc' ? 'desc' : 'asc')
    } else {
      // Set new field and default to descending for numeric fields, ascending for name
      setPlayerSortField(field)
      setPlayerSortDirection(field === 'name' ? 'asc' : 'desc')
    }
  }

  // Group matches by date
  const groupedMatches = matches.reduce((acc, match) => {
    const date = match.startedAt
      ? new Date(match.startedAt).toLocaleDateString()
      : t('matches.unknownDate')
    if (!acc[date]) {
      acc[date] = []
    }
    acc[date].push(match)
    return acc
  }, {} as Record<string, Match[]>)

  const getPlayerName = (steamId: string) => {
    const player = scores.find((p) => p.steamId === steamId)
    return player?.name || steamId
  }

  const getSourceIcon = (source: string | null | undefined): string | null => {
    if (!source || source === 'unknown') {
      return null
    }
    
    // Map source names to icon filenames (use white icons for dark theme)
    const sourceIconMap: Record<string, string> = {
      'faceit': 'faceit-white.png',
      'cevo': 'cevo-white.png',
      'challengermode': 'challengermode.png',
      'esl': 'esl-white.png',
      'ebot': 'ebot.png',
      'esea': 'esea-white.png',
      'popflash': 'popflash-white.png',
      'esportal': 'esportal-white.png',
      'fastcup': 'fastcup-white.png',
      'gamersclub': 'gamersclub-white.png',
      'renown': 'renown-white.png',
      'matchzy': 'matchzy.png',
      'valve': 'valve-white.png',
      'perfectworld': 'perfectworld-white.png',
      '5eplay': '5eplay.png',
      'esplay': 'esplay.png',
    }
    
    const iconName = sourceIconMap[source.toLowerCase()]
    if (!iconName) {
      return null
    }
    
    // Return path to icon in resources/sources
    return `resources/sources/${iconName}`
  }

  const getMapThumbnail = (mapName: string | null | undefined) => {
    if (!mapName) return null
    // Normalize map name: de_cache_b -> de_cache
    let mapKey = mapName.toLowerCase()
    if (mapKey === 'de_cache_b') {
      mapKey = 'de_cache'
    }
    try {
      // Check if we have it in resources
      return `map://${mapKey}.png`
    } catch {
      // Fallback to cs-demo-manager path (would need to be copied or served)
      return null
    }
  }

  const formatDuration = (seconds: number): string => {
    if (seconds < 60) {
      return `${Math.round(seconds)}s`
    }
    const minutes = Math.floor(seconds / 60)
    const remainingSeconds = Math.round(seconds % 60)
    if (minutes < 60) {
      return `${minutes}m ${remainingSeconds}s`
    }
    const hours = Math.floor(minutes / 60)
    const remainingMinutes = minutes % 60
    return `${hours}h ${remainingMinutes}m`
  }

  const handleMatchClick = (matchId: string) => {
    fetchMatchData(matchId)
    setShowMatchOverview(true)
  }

  const handleContextMenu = (e: React.MouseEvent, match: Match) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY, match })
  }

  const handleContextMenuAction = async (action: 'delete' | 'open' | 'showInDb' | 'reparse' | 'select' | 'showLogs', match: Match) => {
    setContextMenu(null)

    if (action === 'delete') {
      setSelectedMatches(new Set([match.id]))
      setShowDeleteModal(true)
    } else if (action === 'open' && match.demoPath) {
      try {
        await window.electronAPI?.showFileInFolder(match.demoPath)
      } catch (err) {
        setToast({ message: t('matches.failedToOpenFileLocation'), type: 'error' })
      }
    } else if (action === 'showInDb') {
      // Store match ID in localStorage for DBViewerScreen to pick up
      localStorage.setItem('dbViewerSelectedMatch', match.id)
      // Trigger navigation via custom event
      window.dispatchEvent(new CustomEvent('navigateToDbViewer', { detail: { matchId: match.id } }))
    } else if (action === 'reparse' && match.demoPath) {
      // Set the demo to parse and open the parsing modal
      setDemoToParse(match.demoPath)
      setShowParsingModal(true)
    } else if (action === 'select') {
      // Toggle selection for this match
      toggleMatchSelection(match.id)
    } else if (action === 'showLogs') {
      // Show parser logs modal
      setSelectedMatchForLogs(match.id)
      setShowParserLogsModal(true)
    }
  }

  // Close context menu on click outside
  useEffect(() => {
    const handleClickOutside = () => {
      setContextMenu(null)
    }
    if (contextMenu) {
      document.addEventListener('click', handleClickOutside)
      return () => document.removeEventListener('click', handleClickOutside)
    }
  }, [contextMenu])

  const handlePlayerClick = async (player: PlayerScore) => {
    if (!window.electronAPI || !selectedMatch) return

    setSelectedPlayer(player)
    setLoadingEvents(true)

    try {
      const eventsData = await window.electronAPI.getMatchEvents(selectedMatch, {
        steamid: player.steamId,
      })

      setPlayerEvents(eventsData.events || [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load player events')
    } finally {
      setLoadingEvents(false)
    }
  }

  const closeModal = () => {
    setSelectedPlayer(null)
    setPlayerEvents([])
  }

  // Convert events to ClipRange format for export
  const getExportableEvents = (): ClipRange[] => {
    if (!allEvents || allEvents.length === 0) return []
    
    return allEvents.map((event, index) => ({
      // Include index to ensure uniqueness when multiple events occur at same tick
      id: `${selectedMatch}_${event.roundIndex}_${event.startTick}_${event.type}_${index}`,
      startTick: event.startTick,
      endTick: event.endTick || event.startTick + 320, // ~5 sec default at 64 tick
      label: `${event.type} - Round ${event.roundIndex + 1}`,
      eventType: event.type,
      playerName: event.actorSteamId ? getPlayerName(event.actorSteamId) : 'Unknown Player',
      playerSteamId: event.actorSteamId,
    }))
  }

  // Launch CS2 from overview (without specific event)
  const handleWatchInCS2 = async () => {
    if (!window.electronAPI) {
      setError(t('matches.electronApiNotAvailable'))
      return
    }
    
    if (!demoPath) {
      // If we don't have the demo path, try to prompt for it
      const path = await window.electronAPI.openFileDialog()
      if (!path) {
        setError('Demo file path is required to launch CS2')
        return
      }
      setDemoPath(path)
      // Retry with the path
      handleWatchInCS2()
      return
    }

    try {
      // Launch CS2 without jumping to a specific tick or player
      // Check if CS2 is running and if we need to load a different demo
      const result = await window.electronAPI.launchCS2(demoPath, undefined, undefined, false)
      
      // Check for errors (e.g., Akros running)
      if (result.error) {
        setToast({ message: result.error, type: 'error' })
        return
      }
      
      if (result.needsDemoLoad) {
        // Need to confirm loading a different demo
        setPendingDemoAction({ demoPath, startTick: 0, playerName: '' })
        setShowDemoLoadModal(true)
        return
      }
      
      if (result.success) {
        setError(null)
        const message = result.alreadyRunning 
          ? (result.needsDemoLoad === false ? t('matches.loadingDemo') : t('matches.loadingNewDemo'))
          : t('matches.launchingCS2')
        setToast({ message, type: 'success' })
      }
      
      if (result.commands) {
        // Show a notification that commands were copied to clipboard
        const message = result.alreadyRunning
          ? t('matches.cs2AlreadyRunning').replace('{commands}', result.commands)
          : t('matches.cs2Launched').replace('{commands}', result.commands)
        // You could show a toast notification here if you add a toast library
        console.log(message)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('matches.failedToLaunchCS2'))
    }
  }

  const handleDeleteDemo = async () => {
    const userConfirmed = window.confirm(t('matches.deleteDemoConfirm'));
    if (!userConfirmed) return;

    const deleteFile = window.confirm(t('matches.deleteDemoFileConfirm'));

    if (!window.electronAPI) {
      setError(t('matches.electronApiNotAvailable'))
      return
    }

    try {
      await window.electronAPI.deleteDemo(demoPath, deleteFile);
      // Remove the demo from the matches list here
      setMatches((prevMatches) => prevMatches.filter(match => match.id !== selectedMatch));
      setSelectedMatch(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('matches.failedToDeleteDemo'))
    }
  }

  // Copy chat message to clipboard
  const handleCopyChatMessage = async (message: string) => {
    try {
      await navigator.clipboard.writeText(message)
      setToast({ message: t('matches.chatMessageCopied'), type: 'success' })
    } catch (err) {
      console.error('Failed to copy chat message:', err)
      setToast({ message: t('matches.failedToCopyChat'), type: 'error' })
    }
  }

  // Copy all chat messages for a player to clipboard
  const handleCopyPlayerChat = async () => {
    if (chatMessages.length === 0) return
    
    try {
      const timeSeconds = (tick: number) => {
        const totalSeconds = tick / 64
        const minutes = Math.floor(totalSeconds / 60)
        const seconds = Math.floor(totalSeconds % 60)
        return `${minutes}:${seconds.toString().padStart(2, '0')}`
      }
      
      // Filter out server messages
      const filteredMessages = chatMessages.filter(msg => {
        const playerName = msg.name || msg.steamid
        return playerName !== '*server*'
      })
      
      if (filteredMessages.length === 0) {
        setToast({ message: t('matches.noChatToCopy'), type: 'info' })
        return
      }
      
      const chatText = filteredMessages.map(msg => {
        const timeStr = timeSeconds(msg.tick)
        const playerName = msg.name || msg.steamid
        const teamTag = msg.team ? `[${msg.team}] ` : ''
        return `[Round ${msg.roundIndex + 1}] [${timeStr}] ${teamTag}${playerName}: ${msg.message}`
      }).join('\n')
      
      await navigator.clipboard.writeText(chatText)
      const playerName = chatFilterSteamId 
        ? scores.find(s => s.steamId === chatFilterSteamId)?.name || chatFilterSteamId
        : t('matches.allPlayers')
      setToast({ message: t('matches.chatForPlayerCopied').replace('{name}', playerName), type: 'success' })
    } catch (err) {
      console.error('Failed to copy player chat:', err)
      setToast({ message: t('matches.failedToCopyPlayerChat'), type: 'error' })
    }
  }

  // Watch event in CS2 (launches CS2 if not running, loads demo, and jumps to event)
  const handleCopyCommand = async (event: any) => {
    if (!window.electronAPI) {
      setError(t('matches.electronApiNotAvailable'))
      return
    }
    
    if (!demoPath) {
      setError('Demo file path is required. Please set it in the overview.')
      return
    }

    try {
      // Get player name from actorSteamId
      const playerName = getPlayerName(event.actorSteamId)
      
      // Calculate tick 5 seconds before the event
      const previewSeconds = 5
      const previewTicks = previewSeconds * tickRate
      const targetTick = Math.max(0, event.startTick - previewTicks)
      
      // If this is a team kill event, send incident to overlay
      if (event.type === 'TEAM_KILL' && event.actorSteamId && event.victimSteamId) {
        const offenderName = getPlayerName(event.actorSteamId)
        const victimName = getPlayerName(event.victimSteamId)
        
        // Send incident to overlay
        if (window.electronAPI.overlay.sendIncident) {
          await window.electronAPI.overlay.sendIncident({
            matchId: selectedMatch,
            tick: event.startTick,
            eventType: event.type,
            offender: {
              name: offenderName,
              steamId: event.actorSteamId,
              // userId and entityIndex are optional and can be added later if available
            },
            victim: {
              name: victimName,
              steamId: event.victimSteamId,
              // userId and entityIndex are optional and can be added later if available
            },
          })
        }
      }
      
      // Check if CS2 is running - if not, launch it; if yes, just send commands
      // Use launchCS2 which handles both cases and waits for demo to load
      const result = await window.electronAPI.launchCS2(demoPath, event.startTick, playerName, false)
      
      // Check for errors (e.g., Akros running)
      if (result.error) {
        setToast({ message: result.error, type: 'error' })
        return
      }
      
      if (result.needsDemoLoad) {
        // Need to confirm loading a different demo
        setPendingDemoAction({ demoPath, startTick: event.startTick, playerName })
        setShowDemoLoadModal(true)
        return
      }
      
      if (result.success) {
        setError(null)
        const message = result.alreadyRunning 
          ? (result.needsDemoLoad === false ? t('matches.jumpingToEvent') : t('matches.loadingDemoAndJumping'))
          : t('matches.launchingCS2')
        setToast({ message, type: 'success' })
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : t('matches.failedToLaunchOrSend')
      setError(errorMessage)
      setToast({ message: errorMessage, type: 'error' })
    }
  }

  const handleConfirmDemoLoad = async () => {
    if (!pendingDemoAction || !window.electronAPI) {
      setShowDemoLoadModal(false)
      setPendingDemoAction(null)
      return
    }

    try {
      const result = await window.electronAPI.launchCS2(
        pendingDemoAction.demoPath,
        pendingDemoAction.startTick,
        pendingDemoAction.playerName,
        true // confirmLoadDemo = true
      )
      
      // Check for errors (e.g., Akros running)
      if (result.error) {
        setError(result.error)
        setToast({ message: result.error, type: 'error' })
        setShowDemoLoadModal(false)
        setPendingDemoAction(null)
        return
      }
      
      if (result.success) {
        setError(null)
        // Show different message based on whether we're jumping to an event or loading from start
        const message = pendingDemoAction.startTick > 0 
          ? 'Loading new demo and jumping to event...'
          : 'Loading new demo from start...'
        setToast({ message, type: 'success' })
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : t('matches.failedToLoadDemo')
      setError(errorMessage)
      setToast({ message: errorMessage, type: 'error' })
    } finally {
      setShowDemoLoadModal(false)
      setPendingDemoAction(null)
    }
  }

  const formatTime = (tick: number, tickRate: number = 64) => {
    const seconds = tick / tickRate
    const minutes = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${minutes}:${secs.toString().padStart(2, '0')}`
  }

  const formatEventDuration = (startTick: number, endTick: number | null, tickRate: number = 64) => {
    if (!endTick) return 'N/A'
    const duration = (endTick - startTick) / tickRate
    return `${duration.toFixed(1)}s`
  }

  // Handle voice extraction for a player - just open modal
  const handleExtractVoice = (player: PlayerScore, e?: React.MouseEvent) => {
    e?.stopPropagation() // Prevent row click
    
    if (!demoPath || !selectedMatch) {
      setToast({ message: t('matches.demoFileRequired'), type: 'error' })
      return
    }

    // Set player info for modal (modal will handle extraction)
    setVoicePlayerSteamId(player.steamId)
    setVoicePlayerName(player.name)
    setShowVoiceModal(true)
  }

  const handleExtractTeamVoice = (teamName: string, teamPlayers: PlayerScore[], e?: React.MouseEvent) => {
    e?.stopPropagation()

    if (!demoPath || !selectedMatch) {
      setToast({ message: t('matches.demoFileRequired'), type: 'error' })
      return
    }

    const mappedPlayers = teamPlayers.map((player) => ({
      steamId: player.steamId,
      name: player.name || player.steamId,
    }))

    setTeamCommsName(teamName)
    setTeamCommsPlayers(mappedPlayers)
    setShowTeamCommsModal(true)
  }


  // Filter and group events by type
  const filteredEvents = playerEvents.filter((event) => {
    // Exclude regular kills - only show team kills
    if (event.type === 'KILL' || event.type === 'KILLS') {
      return false
    }
    // Filter AFK events by minimum duration
    if (event.type === 'AFK_STILLNESS') {
      const duration = event.meta?.seconds || (event.endTick && event.startTick
        ? (event.endTick - event.startTick) / 64
        : 0)
      return duration >= afkMinSeconds
    }
    return true
  })

  // Group events by type and sort
  const eventsByType = filteredEvents.reduce((acc, event) => {
    if (!acc[event.type]) {
      acc[event.type] = []
    }
    acc[event.type].push(event)
    return acc
  }, {} as Record<string, PlayerEvent[]>)

  // Sort events within each type
  Object.keys(eventsByType).forEach((eventType) => {
    if (eventType === 'TEAM_DAMAGE') {
      // Sort team damage by highest damage first
      eventsByType[eventType].sort((a, b) => {
        const damageA = a.meta?.total_damage || 0
        const damageB = b.meta?.total_damage || 0
        return damageB - damageA
      })
    } else {
      // Sort other events by round, then by start tick
      eventsByType[eventType].sort((a, b) => {
        if (a.roundIndex !== b.roundIndex) {
          return a.roundIndex - b.roundIndex
        }
        return a.startTick - b.startTick
      })
    }
  })

  const toggleSection = (eventType: string) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev)
      if (next.has(eventType)) {
        next.delete(eventType)
      } else {
        next.add(eventType)
      }
      return next
    })
  }

  const toggleMatchSelection = (matchId: string) => {
    setSelectedMatches((prev) => {
      const next = new Set(prev)
      if (next.has(matchId)) {
        next.delete(matchId)
      } else {
        next.add(matchId)
      }
      return next
    })
  }

  const selectAllMatches = () => {
    setSelectedMatches(new Set(sortedMatches.map(m => m.id)))
  }

  const deselectAllMatches = () => {
    setSelectedMatches(new Set())
  }

  const handleDeleteSelected = async () => {
    if (selectedMatches.size === 0) return

    setDeleting(true)
    setError(null)

    try {
      const matchIds = Array.from(selectedMatches)
      const result = await window.electronAPI.deleteMatches(matchIds)
      
      // Remove deleted matches from state
      setMatches((prev) => prev.filter(m => !selectedMatches.has(m.id)))
      setSelectedMatches(new Set())
      setShowDeleteModal(false)
      
      // If the selected match was deleted, clear selection
      if (selectedMatch && selectedMatches.has(selectedMatch)) {
        setSelectedMatch(null)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('matches.failedToDeleteMatches'))
    } finally {
      setDeleting(false)
    }
  }

  const eventTypeLabels: Record<string, string> = {
    TEAM_KILL: t('matches.sections.teamKills'),
    TEAM_DAMAGE: t('matches.sections.teamDamage'),
    TEAM_FLASH: t('matches.sections.teamFlashes'),
    AFK_STILLNESS: t('matches.sections.afk'),
    DISCONNECT: t('matches.sections.disconnects'),
  }

  // Drag and drop handlers for parsing demos
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (!isDragging) {
      setIsDragging(true)
    }
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    // Only set isDragging to false if we're leaving the main container
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragging(false)
    }
  }

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)

    const files = Array.from(e.dataTransfer.files)
    const demoFiles = files.filter(file => file.name.endsWith('.dem'))
    
    if (demoFiles.length === 0) {
      setError(t('matches.dropFiles'))
      return
    }

    // Extract file paths (Electron provides path property)
    const filePaths = demoFiles.map(file => (file as any).path || file.name).filter(Boolean)
    
    if (filePaths.length === 1) {
      // Single file - use existing single-file parsing modal
      setDemoToParse(filePaths[0])
      setDemosToParse([])
      setShowParsingModal(true)
    } else {
      // Multiple files - queue them for sequential parsing
      // First file goes to demoToParse, rest go to queue
      setDemoToParse(filePaths[0])
      setDemosToParse(filePaths.slice(1))
      setShowParsingModal(true)
    }
  }

  return (
    <div 
      className={`flex-1 flex flex-col p-6 overflow-auto transition-colors ${
        isDragging ? 'bg-accent/10 border-2 border-dashed border-accent' : ''
      }`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >

      {!showMatchOverview ? (
        <>
          <div className="flex justify-between items-center mb-6">
            <h2 className="text-2xl font-bold">{t('matches.title')}</h2>
            <div className="flex gap-2">
              {selectedMatches.size > 0 && (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-gray-400">
                    {t('matches.selected').replace('{count}', selectedMatches.size.toString()).replace('{plural}', selectedMatches.size !== 1 ? 'es' : '')}
                  </span>
                  <button
                    onClick={() => setShowDeleteModal(true)}
                    className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 transition-colors flex items-center gap-2"
                  >
                    <Trash2 size={16} />
                    {t('matches.deleteSelected')}
                  </button>
                  <button
                    onClick={deselectAllMatches}
                    className="px-4 py-2 bg-surface border border-border text-white rounded hover:bg-surface/80 transition-colors text-sm"
                  >
                    {t('matches.deselectAll')}
                  </button>
                </div>
              )}
              <button
                onClick={async () => {
                  if (!window.electronAPI) return
                  try {
                    const paths = await window.electronAPI.openFileDialog(true) // Allow multiple
                    if (paths) {
                      const filePaths = Array.isArray(paths) ? paths : [paths]
                      if (filePaths.length === 1) {
                        // Single file - use existing single-file parsing modal
                        setDemoToParse(filePaths[0])
                        setDemosToParse([])
                        setShowParsingModal(true)
                      } else {
                        // Multiple files - queue them for sequential parsing
                        // First file goes to demoToParse, rest go to queue
                        setDemoToParse(filePaths[0])
                        setDemosToParse(filePaths.slice(1))
                        setShowParsingModal(true)
                      }
                    }
                  } catch (err) {
                    setError(err instanceof Error ? err.message : t('matches.failedToOpenFileDialog'))
                  }
                }}
                className="px-4 py-2 bg-accent text-white rounded hover:bg-accent/80 transition-colors flex items-center gap-2"
              >
                <Plus size={16} />
                {t('matches.addDemo')}
              </button>
            </div>
          </div>

          {/* Search and Sorting Controls */}
          {matches.length > 0 && (
            <div className="mb-4 space-y-3">
              {/* Search Bar */}
              <div className="relative">
                <input
                  type="text"
                  placeholder={t('matches.searchPlaceholder')}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full px-4 py-2 pl-10 bg-surface border border-border rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent"
                />
                <div className="absolute left-3 top-1/2 transform -translate-y-1/2">
                  <svg
                    className="w-5 h-5 text-gray-500"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                    />
                  </svg>
                </div>
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery('')}
                    className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-500 hover:text-white transition-colors"
                    title={t('matches.clearSearch')}
                  >
                    <X size={18} />
                  </button>
                )}
              </div>
              
              {/* Results count */}
              {searchQuery && (
                <div className="text-sm text-gray-400">
                  {t('matches.showingResults').replace('{showing}', sortedMatches.length.toString()).replace('{total}', matches.length.toString())}
                </div>
              )}
              
              {/* Sort Controls */}
              <div className="flex items-center gap-4 flex-wrap">
                <span className="text-sm text-gray-400">{t('matches.sortBy')}</span>
                <div className="flex gap-2">
                {(['date', 'id', 'length', 'map'] as const).map((field) => (
                  <button
                    key={field}
                    onClick={() => {
                      if (sortField === field) {
                        setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc')
                      } else {
                        setSortField(field)
                        // Default to desc for date (newest first), asc for others
                        setSortDirection(field === 'date' ? 'desc' : 'asc')
                      }
                    }}
                    className={`px-3 py-1.5 rounded text-sm font-medium transition-colors flex items-center gap-1.5 ${
                      sortField === field
                        ? 'bg-accent text-white'
                        : 'bg-surface text-gray-300 hover:bg-surface/80'
                    }`}
                  >
                    <span className="capitalize">
                      {field === 'length' ? t('matches.duration') : field === 'id' ? t('settings.id') : field === 'date' ? t('settings.date') : t('settings.map')}
                    </span>
                    {sortField === field && (
                      sortDirection === 'asc' ? <ArrowUp size={14} /> : <ArrowDown size={14} />
                    )}
                  </button>
                ))}
                </div>
              </div>
            </div>
          )}

          {loading && matches.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-4">
              <Loader2 className="w-8 h-8 text-accent animate-spin" />
              <div className="text-gray-400">{t('matches.loading')}</div>
            </div>
          ) : (searchQuery && sortedMatches.length === 0) ? (
            <div className="flex flex-col items-center justify-center py-16 gap-4">
              <div className="text-center text-gray-400">
                <p className="text-lg mb-2">{t('matches.noMatches')}</p>
                <p className="text-sm">{t('matches.noMatchesSearch').replace('{query}', searchQuery)}</p>
                <button
                  onClick={() => setSearchQuery('')}
                  className="mt-4 px-4 py-2 bg-accent hover:bg-accent/80 text-white rounded transition-colors text-sm"
                >
                  {t('matches.clearSearch')}
                </button>
              </div>
            </div>
          ) : matches.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-4">
              <div className="text-center text-gray-400">
                <Upload className="w-16 h-16 mx-auto mb-4 text-gray-500 opacity-50" />
                <p className="text-lg mb-2">{t('matches.noMatches')}</p>
                <p className="text-sm mb-4">{t('matches.parseToStart')}</p>
                <div className="mt-6 p-4 bg-surface/50 rounded-lg border border-gray-700/50 max-w-md">
                  <p className="text-sm text-gray-300 mb-2 font-medium">{t('matches.dragDrop')}</p>
                  <p className="text-xs text-gray-400">
                    {t('matches.dragDropDesc')}
                  </p>
                </div>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-2 xl:grid-cols-4 gap-4">
              {sortedMatches.map((match) => {
                const thumbnail = getMapThumbnail(match.map)
                const stats = matchStats.get(match.id)
                const isSelected = selectedMatches.has(match.id)
                return (
                  <div
                    key={match.id}
                    onContextMenu={(e) => handleContextMenu(e, match)}
                    className={`bg-secondary rounded-lg border overflow-hidden transition-all hover:shadow-xl group flex flex-col relative ${
                      isSelected
                        ? 'border-accent border-2'
                        : 'border-border hover:border-accent/50'
                    }`}
                  >
                    {isSelected && (
                      <div className="absolute top-2 left-2 z-10">
                        <div className="w-6 h-6 rounded border-2 flex items-center justify-center bg-accent border-accent">
                          <Check size={16} className="text-white" />
                        </div>
                      </div>
                    )}
                    <button
                      onClick={(e) => {
                        if (e.ctrlKey || e.metaKey) {
                          // CTRL + Click (or CMD + Click on Mac) to toggle selection
                          e.preventDefault()
                          e.stopPropagation()
                          toggleMatchSelection(match.id)
                        } else {
                          // Normal click to open match
                          handleMatchClick(match.id)
                        }
                      }}
                      className="flex-1 flex flex-col"
                    >
                    <div className="relative h-64 bg-surface overflow-hidden w-full">
                      {thumbnail ? (
                        <img
                          src={thumbnail}
                          alt={match.map || t('matches.unknownMap')}
                          className="w-full h-full object-cover object-center group-hover:scale-110 transition-transform duration-300"
                          onError={(e) => {
                            // Hide image on error
                            e.currentTarget.style.display = 'none'
                          }}
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-surface to-secondary">
                          <span className="text-4xl">🗺️</span>
                        </div>
                      )}
                      <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" />
                      <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between gap-2">
                        <div className="font-semibold text-white text-base truncate">
                          {match.map || 'Unknown Map'}
                        </div>
                        {match.source && getSourceIcon(match.source) && (
                          <img
                            src={getSourceIcon(match.source)!}
                            alt={match.source}
                            className="h-5 w-5 flex-shrink-0 object-contain"
                            title={match.source}
                            onError={(e) => {
                              // Hide icon on error
                              e.currentTarget.style.display = 'none'
                            }}
                          />
                        )}
                      </div>
                    </div>
                    <div className="p-4 bg-secondary border-t border-border/50">
                      <div className="text-sm font-bold text-white font-mono mb-3 truncate text-left" title={match.id}>
                        {match.id}
                      </div>
                      
                      {/* Stats Row */}
                      <div className="flex items-center gap-3 flex-wrap text-xs">
                        {stats && stats.roundCount > 0 && (
                          <div className="flex items-center gap-1.5">
                            <span className="text-gray-500">{t('matches.rounds')}:</span>
                            <span className="text-sm font-semibold text-accent">
                              {stats.roundCount}
                            </span>
                          </div>
                        )}
                        {stats && stats.duration > 0 && (
                          <div className="flex items-center gap-1.5">
                            <span className="text-gray-500">{t('matches.duration')}:</span>
                            <span className="text-sm font-semibold text-accent">
                              {formatDuration(stats.duration)}
                            </span>
                          </div>
                        )}
                        {stats && (stats.tWins > 0 || stats.ctWins > 0) && (
                          <div className="flex items-center gap-1.5">
                            <span className="text-gray-500">{t('matches.score')}:</span>
                            <span className="text-sm font-semibold text-gray-300">
                              {t('matches.teamA')} {stats.tWins} - {t('matches.teamB')} {stats.ctWins}
                            </span>
                          </div>
                        )}
                        <div className="flex items-center gap-1.5">
                          <span className="text-gray-500">{t('matches.players')}:</span>
                          <span className="text-sm font-semibold text-gray-300">
                            {match.playerCount}
                          </span>
                        </div>
                      </div>
                    </div>
                  </button>
                  </div>
                )
              })}
            </div>
          )}

          {/* Context Menu */}
          {contextMenu && (
            <div
              className="fixed z-50 bg-secondary border border-border rounded-lg shadow-xl py-1 min-w-[180px]"
              style={{
                left: `${Math.min(contextMenu.x, window.innerWidth - 200)}px`,
                top: `${Math.min(contextMenu.y, window.innerHeight - 150)}px`,
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                onClick={() => handleContextMenuAction('open', contextMenu.match)}
                disabled={!contextMenu.match.demoPath}
                className="w-full text-left px-4 py-2 text-sm text-white hover:bg-surface disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
              >
                <FolderOpen className="w-4 h-4" />
                {t('matches.openFolder')}
              </button>
              <button
                onClick={() => handleContextMenuAction('reparse', contextMenu.match)}
                disabled={!contextMenu.match.demoPath}
                className="w-full text-left px-4 py-2 text-sm text-white hover:bg-surface disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
              >
                <RefreshCw className="w-4 h-4" />
                {t('matches.reparseDemo')}
              </button>
              {enableDbViewer && (
                <button
                  onClick={() => handleContextMenuAction('showInDb', contextMenu.match)}
                  className="w-full text-left px-4 py-2 text-sm text-white hover:bg-surface transition-colors flex items-center gap-2"
                >
                  <Database className="w-4 h-4" />
                  {t('matches.showInDb')}
                </button>
              )}
              <button
                onClick={() => handleContextMenuAction('showLogs', contextMenu.match)}
                className="w-full text-left px-4 py-2 text-sm text-white hover:bg-surface transition-colors flex items-center gap-2"
              >
                <FileText className="w-4 h-4" />
                Show Parser Logs
              </button>
              {selectedMatches.has(contextMenu.match.id) ? (
                <button
                  onClick={() => handleContextMenuAction('select', contextMenu.match)}
                  className="w-full text-left px-4 py-2 text-sm text-white hover:bg-surface transition-colors flex items-center gap-2"
                >
                  <X className="w-4 h-4" />
                  {t('matches.deselect')}
                </button>
              ) : (
                <button
                  onClick={() => handleContextMenuAction('select', contextMenu.match)}
                  className="w-full text-left px-4 py-2 text-sm text-white hover:bg-surface transition-colors flex items-center gap-2"
                >
                  <Check className="w-4 h-4" />
                  {t('matches.select')} (CTRL + Click)
                </button>
              )}
              <div className="border-t border-border my-1" />
              <button
                onClick={() => handleContextMenuAction('delete', contextMenu.match)}
                className="w-full text-left px-4 py-2 text-sm text-red-400 hover:bg-red-900/20 transition-colors flex items-center gap-2"
              >
                <Trash2 className="w-4 h-4" />
                Delete
              </button>
            </div>
          )}

          {/* Delete Confirmation Modal */}
          <Modal
            isOpen={showDeleteModal}
            onClose={() => !deleting && setShowDeleteModal(false)}
            title={t('matches.deleteMatches')}
            size="md"
            footer={
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setShowDeleteModal(false)}
                  disabled={deleting}
                  className="px-4 py-2 bg-surface border border-border text-white rounded hover:bg-surface/80 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm"
                >
                  {t('settings.cancel')}
                </button>
                <button
                  onClick={handleDeleteSelected}
                  disabled={deleting}
                  className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm"
                >
                  {deleting ? t('settings.deleting') : t('matches.deleteButton').replace('{count}', selectedMatches.size.toString()).replace('{plural}', selectedMatches.size > 1 ? 'er' : '')}
                </button>
              </div>
            }
          >
            <div className="space-y-4">
              <div className="flex items-start gap-3">
                <div className="flex-shrink-0 w-12 h-12 rounded-full bg-red-500/20 flex items-center justify-center">
                  <Trash2 className="w-6 h-6 text-red-400" />
                </div>
                <div className="flex-1">
                  <h3 className="text-lg font-semibold text-white mb-2">
                    {t('matches.deleteConfirmTitle')}
                  </h3>
                  <p className="text-sm text-gray-400 mb-2">
                    {t('matches.deleteConfirmDesc').replace('{count}', selectedMatches.size.toString()).replace('{plural}', selectedMatches.size > 1 ? 'er' : '')}
                  </p>
                  <p className="text-sm text-red-400 font-medium">
                    {t('matches.deleteConfirmWarning')}
                  </p>
                </div>
              </div>
            </div>
          </Modal>
        </>
      ) : (
        <div className="flex-1 flex flex-col min-h-0">
          {/* Back Button */}
          <div className="mb-4">
            <button
              onClick={() => {
                setShowMatchOverview(false)
                setSelectedMatch(null)
              }}
              className="flex items-center gap-2 px-4 py-2 bg-surface border border-border rounded hover:bg-surface/80 transition-colors"
            >
              <span>←</span>
              <span>Back to Matches</span>
            </button>
          </div>

          {/* Match Details */}
          <div className="flex-1 bg-secondary rounded-lg border border-border p-4 overflow-auto min-h-0">
            {selectedMatch ? (
            <>
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
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {demoPath && (
                      <>
                        <button
                          onClick={handleWatchInCS2}
                          className="px-3 py-1.5 bg-accent text-white text-sm rounded hover:bg-accent/80 transition-colors flex items-center gap-1"
                          title="Launch CS2 and watch this demo"
                        >
                          <span>🎮</span>
                          <span>Watch in CS2</span>
                        </button>
                        {
                          false && (
                            <button
                              onClick={() => setShowExportPanel(true)}
                              className="px-3 py-1.5 bg-accent text-white text-sm rounded hover:bg-accent/80 transition-colors flex items-center gap-1"
                              title="Export clips from incidents"
                            >
                              <Download size={16} />
                              <span>Export Clips</span>
                            </button>)
                        }
                        <button
                          onClick={handleDeleteDemo}
                          className="px-3 py-1.5 bg-accent text-white text-sm rounded hover:bg-accent/80 transition-colors flex items-center gap-1"
                          title="Delete this demo"
                        >
                          <span>🗑️</span>
                          <span>Delete Demo</span>
                        </button>
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
                      setActiveTab('rounds')
                    }}
                    className={`px-4 py-2 font-medium transition-colors ${
                      activeTab === 'rounds'
                        ? 'text-accent border-b-2 border-accent'
                        : 'text-gray-400 hover:text-white'
                    }`}
                  >
                    {t('matches.tabs.rounds')}
                  </button>
                  <button
                    onClick={() => {
                      setActiveTab('chat')
                      if (selectedMatch) {
                        fetchChatMessages(selectedMatch, chatFilterSteamId || undefined)
                      }
                    }}
                    className={`px-4 py-2 font-medium transition-colors ${
                      activeTab === 'chat'
                        ? 'text-accent border-b-2 border-accent'
                        : 'text-gray-400 hover:text-white'
                    }`}
                  >
                    {t('matches.tabs.chat')}
                  </button>
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
                </div>
              </div>

              {loading ? (
                <div className="text-center text-gray-400 py-8">{t('matches.loading')}</div>
              ) : activeTab === 'overview' ? (
                (() => {
                  // Aggregate statistics from all events
                  const teamKills = allEvents.filter(e => e.type === 'TEAM_KILL')
                  const teamDamage = allEvents.filter(e => e.type === 'TEAM_DAMAGE')
                  const afkDetections = allEvents.filter(e => e.type === 'AFK_STILLNESS')
                  const disconnects = allEvents.filter(e => e.type === 'DISCONNECT')
                  const teamFlashes = allEvents.filter(e => e.type === 'TEAM_FLASH')
                  const economyGriefs = allEvents.filter(e => e.type === 'ECONOMY_GRIEF')
                  const bodyBlocks = allEvents.filter(e => e.type === 'BODY_BLOCK')
                  
                  const totalTeamDamage = teamDamage.reduce((sum, e) => sum + (e.meta?.total_damage || 0), 0)
                  const totalAfkSeconds = afkDetections.reduce((sum, e) => {
                    // Use meta.seconds or meta.afkDuration if available, otherwise calculate from ticks
                    const duration = e.meta?.seconds || e.meta?.afkDuration || (e.endTick && e.startTick ? (e.endTick - e.startTick) / 64 : 0)
                    return sum + duration
                  }, 0)
                  const totalFlashSeconds = teamFlashes.reduce((sum, e) => sum + (e.meta?.blind_duration || 0), 0)

                  const getPlayerName = (steamId: string | null | undefined) => {
                    if (!steamId) return t('matches.unknown')
                    // First try to find in allPlayers (complete list)
                    const player = allPlayers.find(p => p.steamId === steamId)
                    if (player) return player.name
                    // Fallback to scores (might have different name)
                    const scorePlayer = scores.find(s => s.steamId === steamId)
                    return scorePlayer?.name || steamId
                  }

                  const formatTime = (seconds: number) => {
                    const mins = Math.floor(seconds / 60)
                    const secs = Math.floor(seconds % 60)
                    return `${mins}:${secs.toString().padStart(2, '0')}`
                  }

                  const toggleSection = (section: keyof typeof expandedSections) => {
                    setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }))
                  }

                  // Calculate all AFK durations and flash durations for auto-adjustment
                  const afkDurations = afkDetections.map(e => {
                    return e.meta?.seconds || e.meta?.afkDuration || (e.endTick && e.startTick ? (e.endTick - e.startTick) / 64 : 0)
                  }).filter(d => d > 0).sort((a, b) => a - b)
                  
                  const flashDurations = teamFlashes.map(e => e.meta?.blind_duration || 0).filter(d => d > 0).sort((a, b) => a - b)
                  
                  // Auto-adjust thresholds: if no events shown but events exist, lower threshold to show at least one
                  let effectiveAfkThreshold = afkMinSeconds
                  if (afkDetections.length > 0) {
                    const filtered = afkDetections.filter((e) => {
                      const duration = e.meta?.seconds || e.meta?.afkDuration || (e.endTick && e.startTick ? (e.endTick - e.startTick) / 64 : 0)
                      return duration >= effectiveAfkThreshold
                    })
                    if (filtered.length === 0 && afkDurations.length > 0) {
                      // Lower threshold to the minimum duration found
                      effectiveAfkThreshold = afkDurations[0]
                    }
                  }
                  
                  let effectiveFlashThreshold = flashMinSeconds
                  if (teamFlashes.length > 0) {
                    const filtered = teamFlashes.filter((e) => {
                      const blindDuration = e.meta?.blind_duration || 0
                      return blindDuration >= effectiveFlashThreshold
                    })
                    if (filtered.length === 0 && flashDurations.length > 0) {
                      // Lower threshold to the minimum duration found
                      effectiveFlashThreshold = flashDurations[0]
                    }
                  }
                  
                  // Filter AFK and flash events based on effective thresholds
                  const filteredAfkDetections = afkDetections.filter((e) => {
                    const duration = e.meta?.seconds || e.meta?.afkDuration || (e.endTick && e.startTick ? (e.endTick - e.startTick) / 64 : 0)
                    return duration >= effectiveAfkThreshold
                  })
                  
                  const filteredTeamFlashes = teamFlashes.filter((e) => {
                    const blindDuration = e.meta?.blind_duration || 0
                    return blindDuration >= effectiveFlashThreshold
                  })

                  return (
                    <div className="flex flex-col gap-6 p-6">

                      {/* Summary Cards */}
                      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-7 gap-3">
                        <div className="bg-surface border border-border rounded-lg p-4">
                          <div className="flex items-center gap-2 mb-2 text-gray-400">
                            <Clock size={16} />
                            <span className="text-sm font-medium">AFK Detections</span>
                          </div>
                          <div className="text-3xl font-bold mb-1 text-white">{filteredAfkDetections.length}</div>
                          <div className="text-xs text-gray-500">No movement after freezetime</div>
                        </div>
                        <div className="bg-surface border border-border rounded-lg p-4">
                          <div className="flex items-center gap-2 mb-2 text-gray-400">
                            <Skull size={16} />
                            <span className="text-sm font-medium">Team Kills</span>
                          </div>
                          <div className="text-3xl font-bold mb-1 text-red-400">{teamKills.length}</div>
                          <div className="text-xs text-gray-500">Friendly fire kills</div>
                        </div>
                        <div className="bg-surface border border-border rounded-lg p-4">
                          <div className="flex items-center gap-2 mb-2 text-gray-400">
                            <Zap size={16} />
                            <span className="text-sm font-medium">{t('matches.sections.teamDamage')}</span>
                          </div>
                          <div className="text-3xl font-bold mb-1 text-accent">{teamDamage.length}</div>
                          <div className="text-xs text-gray-500">{t('matches.friendlyFireDamage')}</div>
                        </div>
                        <div className="bg-surface border border-border rounded-lg p-4">
                          <div className="flex items-center gap-2 mb-2 text-gray-400">
                            <WifiOff size={16} />
                            <span className="text-sm font-medium">Disconnects</span>
                          </div>
                          <div className="text-3xl font-bold mb-1 text-gray-400">{disconnects.length}</div>
                          <div className="text-xs text-gray-500">Player disconnection events</div>
                        </div>
                        <div className="bg-surface border border-border rounded-lg p-4">
                          <div className="flex items-center gap-2 mb-2 text-gray-400">
                            <Zap size={16} />
                            <span className="text-sm font-medium">{t('matches.sections.teamFlashes')}</span>
                          </div>
                          <div className="text-3xl font-bold mb-1 text-accent">{filteredTeamFlashes.length}</div>
                          <div className="text-xs text-gray-500">{t('matches.friendlyFlashbangs')}</div>
                        </div>
                        <div className="bg-surface border border-border rounded-lg p-4">
                          <div className="flex items-center gap-2 mb-2 text-gray-400">
                            <DollarIcon />
                            <span className="text-sm font-medium">Economy Grief</span>
                          </div>
                          <div className="text-3xl font-bold mb-1 text-yellow-400">{economyGriefs.length}</div>
                          <div className="text-xs text-gray-500">Poor buy decisions</div>
                        </div>
                        <div className="bg-surface border border-border rounded-lg p-4">
                          <div className="flex items-center gap-2 mb-2 text-gray-400">
                            <BodyBlockIcon />
                            <span className="text-sm font-medium">Body Block</span>
                          </div>
                          <div className="text-3xl font-bold mb-1 text-purple-400">{bodyBlocks.length}</div>
                          <div className="text-xs text-gray-500">Head stacking incidents</div>
                        </div>
                      </div>

                      {/* AFK Detections */}
                      {afkDetections.length > 0 && (
                        <div className="bg-surface border border-border rounded-lg p-4">
                          <div className="flex items-center justify-between mb-3">
                            <button
                              onClick={() => toggleSection('afk')}
                              className="flex items-center gap-2 text-lg font-semibold text-white hover:text-accent transition-colors"
                            >
                              <Clock size={18} />
                              {t('matches.afkPlayersAtRoundStart')}
                              {expandedSections.afk ? <ChevronDown size={18} className="text-gray-500" /> : <ChevronUp size={18} className="text-gray-500" />}
                            </button>
                            <div className="flex items-center gap-4">
                              <div className="flex items-center gap-2">
                                <label className="text-xs text-gray-400">{t('matches.sortBy')}</label>
                                <select
                                  value={afkSortBy}
                                  onChange={(e) => setAfkSortBy(e.target.value as 'round' | 'duration')}
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
                                  onChange={(e) => setAfkMinSeconds(parseFloat(e.target.value) || 0)}
                                  className="w-20 px-2 py-1 bg-secondary border border-border rounded text-white text-xs"
                                />
                                <span className="text-xs text-gray-500">{t('matches.seconds')}</span>
                                <span className="text-xs text-gray-500">
                                  ({filteredAfkDetections.length}/{afkDetections.length})
                                </span>
                              </div>
                            </div>
                          </div>
                          {expandedSections.afk && (() => {
                            // Filter and group AFK events by player (already filtered above, but group here)
                            const filteredAFKs = filteredAfkDetections

                            // Group by player (actorSteamId)
                            const groupedByPlayer = new Map<string, typeof filteredAFKs>()
                            filteredAFKs.forEach((afk) => {
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
                                  if (afkSortBy === 'round') {
                                    return a.roundIndex - b.roundIndex
                                  } else if (afkSortBy === 'duration') {
                                    const durationA = a.meta?.seconds || a.meta?.afkDuration || (a.endTick && a.startTick ? (a.endTick - a.startTick) / tickRate : 0)
                                    const durationB = b.meta?.seconds || b.meta?.afkDuration || (b.endTick && b.startTick ? (b.endTick - b.startTick) / tickRate : 0)
                                    return durationB - durationA // Descending order (longest first)
                                  }
                                  return 0
                                })
                                return {
                                  playerId,
                                  playerName: getPlayerName(playerId),
                                  afks: sortedAfks
                                }
                              })
                              .sort((a, b) => a.playerName.localeCompare(b.playerName))

                            return filteredAFKs.length > 0 ? (
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
                                                  <button
                                                    onClick={() => {
                                                      const round = rounds.find(r => r.roundIndex === afk.roundIndex)
                                                      if (round) {
                                                        const previewSeconds = 5
                                                        const previewTicks = previewSeconds * tickRate
                                                        const targetTick = Math.max(round.startTick || 0, afk.startTick - previewTicks)
                                                        setViewer2D({ roundIndex: afk.roundIndex, tick: targetTick })
                                                      }
                                                    }}
                                                    className="p-1 hover:bg-accent/20 rounded transition-colors"
                                                    title={t('matches.viewIn2D')}
                                                  >
                                                    <MapIcon size={14} className="text-gray-400 hover:text-accent" />
                                                  </button>
                                                  <button
                                                    onClick={() => handleCopyCommand(afk)}
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
                      )}

                      {/* Disconnects */}
                      {disconnects.length > 0 && (
                        <div className="bg-surface border border-border rounded-lg p-4">
                          <div className="flex items-center justify-between mb-3">
                            <button
                              onClick={() => toggleSection('disconnects')}
                              className="flex items-center gap-2 text-lg font-semibold text-white hover:text-gray-400 transition-colors"
                            >
                              <WifiOff size={18} />
                              Disconnects
                              {expandedSections.disconnects ? <ChevronDown size={18} className="text-gray-500" /> : <ChevronUp size={18} className="text-gray-500" />}
                            </button>
                          </div>
                          {expandedSections.disconnects && (
                            <div className="flex flex-wrap gap-4">
                              {disconnects
                                .sort((a, b) => a.roundIndex - b.roundIndex)
                                .map((dc, idx) => {
                                const disconnectTime = dc.meta?.disconnect_time ? formatTime(dc.meta.disconnect_time) : 'N/A'
                                const reconnected = dc.meta?.reconnected === true
                                const reconnectTime = dc.meta?.reconnect_time ? formatTime(dc.meta.reconnect_time) : null
                                const duration = dc.meta?.disconnect_duration ? `${dc.meta.disconnect_duration.toFixed(1)}s` : null
                                const reason = formatDisconnectReason(dc.meta?.reason)
                                
                                return (
                                  <div key={idx} className="bg-secondary border border-border rounded p-3 min-w-[300px]">
                                    <div className="flex items-center justify-between mb-2">
                                      <span className="font-medium text-white">{getPlayerName(dc.actorSteamId)}</span>
                                      <div className="flex items-center gap-2">
                                        <span className="text-xs text-gray-400">Round {dc.roundIndex + 1}/{rounds.length}</span>
                                        {demoPath && (
                                          <div className="flex items-center gap-1">
                                            <button
                                              onClick={() => {
                                                const round = rounds.find(r => r.roundIndex === dc.roundIndex)
                                                if (round) {
                                                  const previewSeconds = 5
                                                  const previewTicks = previewSeconds * tickRate
                                                  const targetTick = Math.max(round.startTick || 0, dc.startTick - previewTicks)
                                                  setViewer2D({ roundIndex: dc.roundIndex, tick: targetTick })
                                                }
                                              }}
                                              className="p-1 hover:bg-accent/20 rounded transition-colors"
                                              title="View in 2D"
                                            >
                                              <MapIcon size={14} className="text-gray-400 hover:text-accent" />
                                            </button>
                                            <button
                                              onClick={() => handleCopyCommand(dc)}
                                              className="p-1 hover:bg-accent/20 rounded transition-colors"
                                              title="Watch this event in CS2"
                                            >
                                              <Play size={14} className="text-gray-400 hover:text-accent" />
                                            </button>
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                    <div className="text-xs text-gray-400 mt-1">
                                      <div className="flex items-center gap-1">
                                        <span className="font-medium">Reason:</span>
                                        <span>{reason}</span>
                                      </div>
                                    </div>
                                    <div className="text-xs text-gray-400 mt-1">
                                      <div className="flex items-center gap-1">
                                        <span className="font-medium">Disconnected:</span>
                                        <span>{disconnectTime}</span>
                                      </div>
                                    </div>
                                    {reconnected ? (
                                      <>
                                        <div className="text-xs text-green-400 mt-1">
                                          <div className="flex items-center gap-1">
                                            <span className="font-medium">Reconnected:</span>
                                            <span>{reconnectTime}</span>
                                          </div>
                                        </div>
                                        {duration && (
                                          <div className="text-xs text-gray-400 mt-1">
                                            <div className="flex items-center gap-1">
                                              <span className="font-medium">Duration:</span>
                                              <span>{duration}</span>
                                            </div>
                                          </div>
                                        )}
                                      </>
                                    ) : (
                                      <div className="text-xs text-red-400 mt-1">
                                        Did not reconnect
                                      </div>
                                    )}
                                  </div>
                                )
                              })}
                            </div>
                          )}
                        </div>
                      )}

                      {/* Team Kills */}
                      {teamKills.length > 0 && (
                        <div className="bg-surface border border-border rounded-lg p-4">
                          <div className="flex items-center justify-between mb-3">
                            <button
                              onClick={() => toggleSection('teamKills')}
                              className="flex items-center gap-2 text-lg font-semibold text-white hover:text-red-400 transition-colors"
                            >
                              <Skull size={18} />
                              Team Kills
                              {expandedSections.teamKills ? <ChevronDown size={18} className="text-gray-500" /> : <ChevronUp size={18} className="text-gray-500" />}
                            </button>
                          </div>
                          {expandedSections.teamKills && (
                            <div className="flex flex-wrap gap-4">
                              {teamKills
                                .sort((a, b) => a.roundIndex - b.roundIndex)
                                .map((kill, idx) => (
                                <div key={idx} className="bg-secondary border border-border rounded p-3 min-w-[300px]">
                                  <div className="flex items-center justify-between mb-2">
                                    <span className="font-medium text-white">{getPlayerName(kill.actorSteamId)}</span>
                                    <div className="flex items-center gap-2">
                                      <span className="text-xs text-gray-400">Round {kill.roundIndex + 1}</span>
                                      {demoPath && (
                                        <div className="flex items-center gap-1">
                                          <button
                                            onClick={() => {
                                              const round = rounds.find(r => r.roundIndex === kill.roundIndex)
                                              if (round) {
                                                const previewSeconds = 5
                                                const previewTicks = previewSeconds * tickRate
                                                const targetTick = Math.max(round.startTick || 0, kill.startTick - previewTicks)
                                                setViewer2D({ roundIndex: kill.roundIndex, tick: targetTick })
                                              }
                                            }}
                                            className="p-1 hover:bg-accent/20 rounded transition-colors"
                                            title="View in 2D"
                                          >
                                            <MapIcon size={14} className="text-gray-400 hover:text-accent" />
                                          </button>
                                          <button
                                            onClick={() => handleCopyCommand(kill)}
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
                                    → {getPlayerName(kill.victimSteamId || '')}
                                  </div>
                                  {kill.meta?.weapon && (
                                    <div className="text-xs text-gray-400 mt-1">
                                      {kill.meta.weapon}
                                    </div>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}

                      {/* Team Damage */}
                      {teamDamage.length > 0 && (
                        <div className="bg-surface border border-border rounded-lg p-4">
                          <div className="flex items-center justify-between mb-3">
                            <button
                              onClick={() => toggleSection('teamDamage')}
                              className="flex items-center gap-2 text-lg font-semibold text-white hover:text-accent transition-colors"
                            >
                              <Zap size={18} />
                              {t('matches.sections.teamDamage')}
                              {expandedSections.teamDamage ? <ChevronDown size={18} className="text-gray-500" /> : <ChevronUp size={18} className="text-gray-500" />}
                            </button>
                          </div>
                          {expandedSections.teamDamage && (
                            <div className="flex flex-wrap gap-4">
                              {teamDamage
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
                                              <button
                                                onClick={() => {
                                                  const round = rounds.find(r => r.roundIndex === damage.roundIndex)
                                                  if (round) {
                                                    const previewSeconds = 5
                                                    const previewTicks = previewSeconds * tickRate
                                                    const targetTick = Math.max(round.startTick || 0, damage.startTick - previewTicks)
                                                    setViewer2D({ roundIndex: damage.roundIndex, tick: targetTick })
                                                  }
                                                }}
                                                className="p-1 hover:bg-accent/20 rounded transition-colors"
                                                title="View in 2D"
                                              >
                                                <MapIcon size={14} className="text-gray-400 hover:text-accent" />
                                              </button>
                                              <button
                                                onClick={() => handleCopyCommand(damage)}
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
                      )}

                      {/* Team Flashes */}
                      {teamFlashes.length > 0 && (
                        <div className="bg-surface border border-border rounded-lg p-4">
                          <div className="flex items-center justify-between mb-3">
                            <button
                              onClick={() => toggleSection('teamFlashes')}
                              className="flex items-center gap-2 text-lg font-semibold text-white hover:text-accent transition-colors"
                            >
                              <Zap size={18} />
                              {t('matches.sections.teamFlashes')}
                              {expandedSections.teamFlashes ? <ChevronDown size={18} className="text-gray-500" /> : <ChevronUp size={18} className="text-gray-500" />}
                            </button>
                            <div className="flex items-center gap-2">
                              <label className="text-xs text-gray-400">{t('matches.minBlind')}</label>
                              <input
                                type="number"
                                min="0"
                                step="0.1"
                                value={effectiveFlashThreshold}
                                onChange={(e) => setFlashMinSeconds(parseFloat(e.target.value) || 0)}
                                className="w-20 px-2 py-1 bg-secondary border border-border rounded text-white text-xs"
                              />
                              <span className="text-xs text-gray-500">s</span>
                              <span className="text-xs text-gray-500">
                                ({filteredTeamFlashes.length}/{teamFlashes.length})
                              </span>
                            </div>
                          </div>
                          {expandedSections.teamFlashes && (
                            <>
                              {filteredTeamFlashes.length > 0 ? (
                                <div className="flex flex-wrap gap-4">
                                  {filteredTeamFlashes
                                    .sort((a, b) => a.roundIndex - b.roundIndex)
                                    .map((flash, idx) => (
                                      <div key={idx} className="bg-secondary border border-border rounded p-3 min-w-[300px]">
                                        <div className="flex items-center justify-between mb-2">
                                          <span className="font-medium text-white">{getPlayerName(flash.actorSteamId)}</span>
                                          <div className="flex items-center gap-2">
                                            <span className="text-xs text-gray-400">Round {flash.roundIndex + 1}</span>
                                            {demoPath && (
                                              <div className="flex items-center gap-1">
                                                <button
                                                  onClick={() => {
                                                    const round = rounds.find(r => r.roundIndex === flash.roundIndex)
                                                    if (round) {
                                                      const previewSeconds = 5
                                                      const previewTicks = previewSeconds * tickRate
                                                      const targetTick = Math.max(round.startTick || 0, flash.startTick - previewTicks)
                                                      setViewer2D({ roundIndex: flash.roundIndex, tick: targetTick })
                                                    }
                                                  }}
                                                  className="p-1 hover:bg-accent/20 rounded transition-colors"
                                                  title="View in 2D"
                                                >
                                                  <MapIcon size={14} className="text-gray-400 hover:text-accent" />
                                                </button>
                                                <button
                                                  onClick={() => handleCopyCommand(flash)}
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
                      )}

                      {/* Economy Griefing */}
                      {economyGriefs.length > 0 && (
                        <div className="bg-surface border border-border rounded-lg p-4">
                          <div className="flex items-center justify-between mb-3">
                            <button
                              onClick={() => toggleSection('economy')}
                              className="flex items-center gap-2 text-lg font-semibold text-white hover:text-yellow-400 transition-colors"
                            >
                              <DollarIcon />
                              Economy Griefing
                              {expandedSections.economy ? <ChevronDown size={18} className="text-gray-500" /> : <ChevronUp size={18} className="text-gray-500" />}
                            </button>
                          </div>
                          {expandedSections.economy && (
                            <div className="flex flex-wrap gap-4">
                              {economyGriefs
                                .sort((a, b) => a.roundIndex - b.roundIndex)
                                .map((econ, idx) => {
                                  const griefType = econ.meta?.grief_type || 'unknown'
                                  const startMoney = econ.meta?.start_money || 0
                                  const moneySpent = econ.meta?.money_spent || 0
                                  const spendPct = econ.meta?.spend_pct || 0
                                  const teamAvgSpend = econ.meta?.team_avg_spend || 0
                                  const teamAvgMoney = econ.meta?.team_avg_money || 0
                                  const teamSpendPct = econ.meta?.team_spend_pct || 0
                                  const griefTypeLabels: Record<string, string> = {
                                    'equipment_mismatch': 'Wrong weapon choice',
                                    'no_buy_with_team': 'Not buying with team',
                                    'excessive_saving': 'Excessive saving',
                                    'full_save_high_money': 'Full save with high money',
                                  }

                                  return (
                                    <div key={idx} className="bg-secondary border border-border rounded p-3 min-w-[320px]">
                                      <div className="flex items-center justify-between mb-2">
                                        <span className="font-medium text-white">{getPlayerName(econ.actorSteamId)}</span>
                                        <div className="flex items-center gap-2">
                                          <button
                                            onClick={() => setSelectedEconomyEvent(econ)}
                                            className="p-1 hover:bg-accent/20 rounded transition-colors"
                                            title="View details"
                                          >
                                            <Info size={14} className="text-gray-400 hover:text-accent" />
                                          </button>
                                          <span className="text-xs text-gray-400">Round {econ.roundIndex + 1}</span>
                                          {demoPath && (
                                            <div className="flex items-center gap-1">
                                              <button
                                                onClick={() => {
                                                  const round = rounds.find(r => r.roundIndex === econ.roundIndex)
                                                  if (round) {
                                                    const targetTick = round.freezeEndTick || round.startTick
                                                    setViewer2D({ roundIndex: econ.roundIndex, tick: targetTick })
                                                  }
                                                }}
                                                className="p-1 hover:bg-accent/20 rounded transition-colors"
                                                title="View in 2D"
                                              >
                                                <MapIcon size={14} className="text-gray-400 hover:text-accent" />
                                              </button>
                                              <button
                                                onClick={() => handleCopyCommand(econ)}
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
                      )}
                      {selectedEconomyEvent && (
                        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
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
                              {/* Grief type */}
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

                              {/* Economy stats */}
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

                              {/* Team stats */}
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

                              {/* Weapons */}
                              {selectedEconomyEvent.meta && (
                                <div>
                                  <div className="text-xs font-medium text-gray-400 mb-2">Flagged Player's Equipment:</div>
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

                              {/* Team Equipment */}
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

                      {/* Body Block (Head Stacking) */}
                      {bodyBlocks.length > 0 && (
                        <div className="bg-surface border border-border rounded-lg p-4">
                          <div className="flex items-center justify-between mb-3">
                            <button
                              onClick={() => toggleSection('bodyBlock')}
                              className="flex items-center gap-2 text-lg font-semibold text-white hover:text-purple-400 transition-colors"
                            >
                              <BodyBlockIcon />
                              Body Block (Head Stacking)
                              {expandedSections.bodyBlock ? <ChevronDown size={18} className="text-gray-500" /> : <ChevronUp size={18} className="text-gray-500" />}
                            </button>
                          </div>
                          {expandedSections.bodyBlock && (
                            <div className="flex flex-wrap gap-4">
                              {bodyBlocks
                                .sort((a, b) => a.roundIndex - b.roundIndex)
                                .map((block, idx) => {
                                  const seconds = block.meta?.seconds || 0
                                  const stackedTicks = block.meta?.stacked_ticks || 0
                                  const minXYDist = block.meta?.min_xy_distance || 0
                                  const avgXYDist = block.meta?.avg_xy_distance || 0
                                  const avgZDelta = block.meta?.avg_z_delta || 0

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
                                          {demoPath && (
                                            <div className="flex items-center gap-1">
                                              <button
                                                onClick={() => {
                                                  const round = rounds.find(r => r.roundIndex === block.roundIndex)
                                                  if (round && block.startTick) {
                                                    const previewSeconds = 3
                                                    const previewTicks = previewSeconds * tickRate
                                                    const targetTick = Math.max(round.startTick || 0, block.startTick - previewTicks)
                                                    setViewer2D({ roundIndex: block.roundIndex, tick: targetTick })
                                                  }
                                                }}
                                                className="p-1 hover:bg-accent/20 rounded transition-colors"
                                                title="View in 2D"
                                              >
                                                <MapIcon size={14} className="text-gray-400 hover:text-accent" />
                                              </button>
                                              <button
                                                onClick={() => handleCopyCommand(block)}
                                                className="p-1 hover:bg-accent/20 rounded transition-colors"
                                                title="Watch this event in CS2"
                                              >
                                                <Play size={14} className="text-gray-400 hover:text-accent" />
                                              </button>
                                            </div>
                                          )}
                                        </div>
                                      </div>
                                      <div className="text-xs text-purple-400 font-medium mb-2">
                                        Head stacking detected
                                      </div>
                                      <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                                        <div className="text-gray-400">
                                          <span className="font-medium">Duration:</span>
                                        </div>
                                        <div className="text-white">
                                          {seconds.toFixed(1)}s ({stackedTicks} ticks)
                                        </div>
                                        <div className="text-gray-400">
                                          <span className="font-medium">Min XY dist:</span>
                                        </div>
                                        <div className="text-white">
                                          {minXYDist.toFixed(1)} units
                                        </div>
                                        <div className="text-gray-400">
                                          <span className="font-medium">Avg XY dist:</span>
                                        </div>
                                        <div className="text-white">
                                          {avgXYDist.toFixed(1)} units
                                        </div>
                                        <div className="text-gray-400">
                                          <span className="font-medium">Avg Z delta:</span>
                                        </div>
                                        <div className="text-white">
                                          {avgZDelta.toFixed(1)} units
                                        </div>
                                      </div>
                                    </div>
                                  )
                                })}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })()
              ) : activeTab === 'players' ? (
                allPlayersWithScores.length === 0 ? (
                  <div className="text-center text-gray-400 py-8">{t('matches.noPlayersAvailable')}</div>
                ) : (
                  <div className="overflow-x-auto">
                    <div className="grid grid-cols-2 gap-4">
                      {/* Team A Column */}
                      <div className="flex flex-col">
                        <div className="bg-surface/30 border-b border-border pb-2 mb-2 flex items-center justify-between px-2 py-2">
                          <h3 className="text-lg font-semibold text-accent">Team A</h3>
                          <button
                            onClick={(e) => handleExtractTeamVoice('Team A', groupedAndSortedScores.teamA, e)}
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
                            {groupedAndSortedScores.teamA.map((score) => (
                              <div
                                key={score.steamId}
                                className="border border-border/50 rounded p-3 hover:bg-surface/50 transition-colors cursor-pointer"
                                onClick={() => handlePlayerClick(score)}
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
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      handleExtractVoice(score, e)
                                    }}
                                    disabled={!demoPath}
                                    className="px-3 py-1.5 bg-accent hover:bg-accent/90 disabled:bg-gray-600 disabled:cursor-not-allowed text-white text-sm rounded transition-colors flex items-center gap-1.5 ml-2 flex-shrink-0 whitespace-nowrap"
                                    title={!demoPath ? t('matches.demoFileRequired') : t('matches.extractVoiceFor').replace('{name}', score.name)}
                                  >
                                    <Mic size={14} />
                                    <span>{t('matches.extractVoice')}</span>
                                  </button>
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
                        )}
                      </div>

                      {/* Team B Column */}
                      <div className="flex flex-col">
                        <div className="bg-surface/30 border-b border-border pb-2 mb-2 flex items-center justify-between px-2 py-2">
                          <h3 className="text-lg font-semibold text-accent">Team B</h3>
                          <button
                            onClick={(e) => handleExtractTeamVoice('Team B', groupedAndSortedScores.teamB, e)}
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
                            {groupedAndSortedScores.teamB.map((score) => (
                              <div
                                key={score.steamId}
                                className="border border-border/50 rounded p-3 hover:bg-surface/50 transition-colors cursor-pointer"
                                onClick={() => handlePlayerClick(score)}
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
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      handleExtractVoice(score, e)
                                    }}
                                    disabled={!demoPath}
                                    className="px-3 py-1.5 bg-accent hover:bg-accent/90 disabled:bg-gray-600 disabled:cursor-not-allowed text-white text-sm rounded transition-colors flex items-center gap-1.5 ml-2 flex-shrink-0 whitespace-nowrap"
                                    title={!demoPath ? t('matches.demoFileRequired') : t('matches.extractVoiceFor').replace('{name}', score.name)}
                                  >
                                    <Mic size={14} />
                                    <span>{t('matches.extractVoice')}</span>
                                  </button>
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
                              onClick={() => handlePlayerClick(score)}
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
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    handleExtractVoice(score, e)
                                  }}
                                  disabled={!demoPath}
                                  className="px-3 py-1.5 bg-accent hover:bg-accent/90 disabled:bg-gray-600 disabled:cursor-not-allowed text-white text-sm rounded transition-colors flex items-center gap-1.5 ml-2"
                                  title={!demoPath ? t('matches.demoFileRequired') : t('matches.extractVoiceFor').replace('{name}', score.name)}
                                >
                                  <Mic size={14} />
                                  <span>{t('matches.extractVoice')}</span>
                                </button>
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
              ) : activeTab === 'rounds' ? (
                <div className="space-y-4">
                  {rounds.length === 0 ? (
                    <div className="text-center text-gray-400 py-8">No rounds available</div>
                  ) : (
                    rounds.map((round) => {
                      const stats = roundStats.get(round.roundIndex)
                      return (
                        <div
                          key={round.roundIndex}
                          className="bg-surface rounded-lg border border-border p-4"
                        >
                          <div className="flex justify-between items-center mb-3">
                            <h4 className="font-semibold">Round {round.roundIndex + 1}</h4>
                            <div className="text-sm text-gray-400">
                              {round.winner && (
                                <span className="mr-2">Winner: {round.winner}</span>
                              )}
                              <span>
                                Score: Team A {round.tWins} - Team B {round.ctWins}
                              </span>
                            </div>
                          </div>

                          {stats && (
                            <div className="grid grid-cols-4 gap-4 mb-3 text-sm">
                              <div>
                                <div className="text-gray-400">{t('matches.teamKills')}</div>
                                <div className="font-semibold text-red-400">{stats.teamKills}</div>
                              </div>
                              <div>
                                <div className="text-gray-400">{t('matches.teamDamage')}</div>
                                <div className="font-semibold text-yellow-400">
                                  {stats.teamDamage.toFixed(1)}
                                </div>
                              </div>
                              <div>
                                <div className="text-gray-400">{t('matches.flashSeconds')}</div>
                                <div className="font-semibold text-orange-400">
                                  {stats.teamFlashSeconds.toFixed(1)}s
                                </div>
                              </div>
                              <div>
                                <div className="text-gray-400">{t('matches.afkSeconds')}</div>
                                <div className="font-semibold text-blue-400">
                                  {stats.afkSeconds.toFixed(1)}s
                                </div>
                              </div>
                            </div>
                          )}

                          {stats && stats.events.length > 0 && (
                            <div className="mt-3">
                              <div className="text-xs font-semibold text-gray-500 uppercase mb-2">
                                Events
                              </div>
                              <div className="space-y-1 text-xs">
                                {stats.events.map((event, idx) => (
                                  <div
                                    key={idx}
                                    className="flex items-center gap-2 text-gray-300 bg-surface/50 p-2 rounded"
                                  >
                                    <span className="font-mono text-accent">{event.type}</span>
                                    <span className="text-gray-400">
                                      {getPlayerName(event.actorSteamId)}
                                    </span>
                                    {event.victimSteamId && (
                                      <>
                                        <span className="text-gray-500">→</span>
                                        <span className="text-gray-400">
                                          {getPlayerName(event.victimSteamId)}
                                        </span>
                                      </>
                                    )}
                                    {event.meta && (
                                      <span className="text-gray-500 ml-auto">
                                        {event.meta.weapon || event.meta.total_damage
                                          ? `(${event.meta.weapon || `${event.meta.total_damage} ${t('matches.dmg')}`})`
                                          : ''}
                                      </span>
                                    )}
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      )
                    })
                  )}
                </div>
              ) : activeTab === 'chat' ? (
                <div className="space-y-4">
                  {/* Filter by player and view mode */}
                  <div className="bg-surface rounded-lg border border-border p-4">
                    <div className="flex items-center gap-4 flex-wrap">
                      <label className="text-sm font-medium text-gray-300">{t('matches.filterByPlayer')}</label>
                      <select
                        value={chatFilterSteamId || ''}
                        onChange={(e) => {
                          const steamId = e.target.value || null
                          setChatFilterSteamId(steamId)
                          if (selectedMatch) {
                            fetchChatMessages(selectedMatch, steamId || undefined)
                          }
                        }}
                        className="px-3 py-1.5 bg-secondary border border-border rounded text-white text-sm focus:outline-none focus:ring-1 focus:ring-accent"
                      >
                        <option value="">{t('matches.allPlayers')}</option>
                        {scores.map((score) => (
                          <option key={score.steamId} value={score.steamId}>
                            {score.name || score.steamId}
                          </option>
                        ))}
                      </select>
                      
                      <div className="flex items-center gap-2 ml-auto">
                        {chatMessages.length > 0 && (
                          <button
                            onClick={handleCopyPlayerChat}
                            className="px-3 py-1.5 bg-secondary hover:bg-secondary/80 border border-border rounded text-white text-sm flex items-center gap-2 transition-colors"
                            title={t('matches.copyAllChat')}
                          >
                            <Copy size={14} />
                            {t('matches.copyAll')}
                          </button>
                        )}
                        <span className="text-sm text-gray-400">{t('matches.allChatOnly')}</span>
                      </div>
                    </div>
                  </div>

                  {/* Chat messages */}
                  {loadingChat ? (
                    <div className="text-center text-gray-400 py-8">{t('matches.loadingChat')}</div>
                  ) : chatMessages.length === 0 ? (
                    <div className="text-center text-gray-400 py-8">{t('matches.noChatMessages')}</div>
                  ) : (
                    <div className="grid gap-4 grid-cols-1">
                      {/* All Chat Section */}
                      {(
                        <div className="bg-surface rounded-lg border border-border overflow-hidden">
                          <div className="px-4 py-3 border-b border-border bg-accent/20">
                            <h3 className="text-lg font-semibold text-accent">{t('matches.allChat')}</h3>
                            <p className="text-xs text-gray-500">
                              {chatMessages.length} {t('matches.messages')}
                            </p>
                          </div>
                          <div className="max-h-[600px] overflow-y-auto">
                            {chatMessages.length === 0 ? (
                              <div className="text-center text-gray-500 py-8 text-sm">{t('matches.noChatMessagesInSection')}</div>
                            ) : (
                              <div className="divide-y divide-border">
                                {chatMessages
                                  .map((msg, idx) => {
                                    const timeSeconds = msg.tick / 64
                                    const minutes = Math.floor(timeSeconds / 60)
                                    const seconds = Math.floor(timeSeconds % 60)
                                    const timeStr = `${minutes}:${seconds.toString().padStart(2, '0')}`
                                    
                                    const fullMessage = `${msg.name || msg.steamid}: ${msg.message}`
                                    const isServer = (msg.name || msg.steamid || '').toLowerCase() === '*server*'
                                    
                                    return (
                                      <div key={`all-${idx}`} className="p-3 hover:bg-secondary/50 transition-colors group">
                                        <div className="flex items-start gap-3">
                                          <div className="flex-shrink-0">
                                            <div className="text-xs font-mono text-gray-500">
                                              {t('matches.round')} {msg.roundIndex + 1}
                                            </div>
                                            <div className="text-xs text-gray-500">{timeStr}</div>
                                          </div>
                                          <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2 mb-1">
                                              {msg.name ? (
                                                <span className={`font-medium text-accent ${isServer ? 'italic' : ''}`}>
                                                  {msg.name}
                                                </span>
                                              ) : (
                                                <button
                                                  onClick={async () => {
                                                    if (window.electronAPI?.openExternal) {
                                                      await window.electronAPI.openExternal(`https://steamcommunity.com/profiles/${msg.steamid}`)
                                                    } else {
                                                      window.open(`https://steamcommunity.com/profiles/${msg.steamid}`, '_blank')
                                                    }
                                                  }}
                                                  className="font-medium text-accent hover:text-accent/80 underline bg-transparent border-none cursor-pointer p-0"
                                                >
                                                  {msg.steamid}
                                                </button>
                                              )}
                                              {msg.team && (
                                                <span className={`text-xs text-gray-500 px-1.5 py-0.5 rounded ${
                                                  msg.team === 'T' 
                                                    ? 'bg-orange-900/20' 
                                                    : 'bg-blue-900/20'
                                                }`}>
                                                  {msg.team}
                                                </span>
                                              )}
                                              <button
                                                onClick={() => handleCopyChatMessage(fullMessage)}
                                                className="ml-auto p-1 hover:bg-accent/20 rounded transition-colors opacity-0 group-hover:opacity-100"
                                                title={t('matches.copyMessage')}
                                              >
                                                <Copy size={14} className="text-gray-400 hover:text-accent" />
                                              </button>
                                            </div>
                                            <div className="text-sm text-gray-300 break-words">
                                              {msg.message}
                                              {(msg as any).isDisconnect && (msg as any).steamid && (
                                                <span className="text-xs text-gray-500 ml-2">
                                                  ({getPlayerName((msg as any).steamid)})
                                                </span>
                                              )}
                                            </div>
                                          </div>
                                        </div>
                                      </div>
                                    )
                                  })}
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ) : activeTab === '2d-viewer' ? (
                selectedMatch ? (
                  <div className="flex-1 min-h-0">
                    <Viewer2D
                      matchId={selectedMatch}
                      roundIndex={-1} // -1 means full game (all rounds)
                      initialTick={rounds.length > 0 ? rounds[0].startTick : 0}
                      roundStartTick={rounds.length > 0 ? rounds[0].startTick : 0}
                      roundEndTick={rounds.length > 0 ? rounds[rounds.length - 1].endTick : 0}
                      mapName={matches.find(m => m.id === selectedMatch)?.map || ''}
                      onClose={() => {}} // No close button needed in tab mode
                      isFullGame={true}
                      allRounds={rounds}
                    />
                  </div>
                ) : (
                  <div className="text-center text-gray-400 py-8">Select a match to view the 2D map</div>
                )
              ) : null}
            </>
          ) : (
            <div className="text-center text-gray-400 py-8">
              Select a match to view details
            </div>
          )}
          </div>
        </div>
      )}

      <>
        {/* Demo Load Confirmation Modal */}
        <Modal
          isOpen={showDemoLoadModal}
          onClose={() => {
            setShowDemoLoadModal(false)
            setPendingDemoAction(null)
          }}
          title="Load Different Demo?"
          size="md"
        >
          <div className="space-y-4">
            <p className="text-gray-300">
              CS2 is currently playing a different demo. Do you want to load the new demo?
            </p>
            {pendingDemoAction && (
              <div className="bg-surface/50 rounded p-3 space-y-2 text-sm">
                <div>
                  <span className="text-gray-400">New demo:</span>
                  <div className="text-white font-mono text-xs mt-1 break-all">
                    {pendingDemoAction.demoPath.split(/[/\\]/).pop() || pendingDemoAction.demoPath}
                  </div>
                </div>
              </div>
            )}
          </div>
          <div className="flex justify-end gap-3 mt-6">
            <button
              onClick={() => {
                setShowDemoLoadModal(false)
                setPendingDemoAction(null)
              }}
              className="px-4 py-2 bg-surface hover:bg-surface/80 text-white rounded transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleConfirmDemoLoad}
              className="px-4 py-2 bg-accent hover:bg-accent/80 text-white rounded transition-colors"
            >
              Load Demo
            </button>
          </div>
        </Modal>

        {/* Player Details Modal */}
        {selectedPlayer && (
          <PlayerModal
            player={selectedPlayer}
            events={playerEvents}
            loading={loadingEvents}
            onClose={closeModal}
            onCopyCommand={handleCopyCommand}
            onView2D={(roundIndex, tick) => {
              const round = rounds.find(r => r.roundIndex === roundIndex)
              if (round) {
                setViewer2D({ roundIndex, tick })
              }
            }}
            demoPath={demoPath}
            tickRate={tickRate}
            getPlayerName={getPlayerName}
            formatTime={formatTime}
            formatEventDuration={formatEventDuration}
            eventTypeLabels={eventTypeLabels}
            collapsedSections={collapsedSections}
            toggleSection={toggleSection}
            afkMinSeconds={afkMinSeconds}
            flashMinSeconds={flashMinSeconds}
            setAfkMinSeconds={setAfkMinSeconds}
            setFlashMinSeconds={setFlashMinSeconds}
            afkSortBy={afkSortBy}
            setAfkSortBy={setAfkSortBy}
            filteredEvents={filteredEvents}
            eventsByType={eventsByType}
          />
        )}

        {/* 2D Viewer Modal */}
        {viewer2D && selectedMatch && (
          <Viewer2D
            matchId={selectedMatch}
            roundIndex={viewer2D.roundIndex}
            initialTick={viewer2D.tick}
            roundStartTick={rounds.find(r => r.roundIndex === viewer2D.roundIndex)?.startTick || 0}
            roundEndTick={rounds.find(r => r.roundIndex === viewer2D.roundIndex)?.endTick || 0}
            mapName={matches.find(m => m.id === selectedMatch)?.map || ''}
            onClose={() => setViewer2D(null)}
          />
        )}

        {/* Toast Notification */}
        <Toast
          message={toast?.message || ''}
          type={toast?.type || 'success'}
          isVisible={toast !== null}
          onClose={() => setToast(null)}
        />

        {/* Parsing Modal */}
        {demoToParse && (
          <ParsingModal
            demosToParse={[demoToParse, ...demosToParse]}
            onClose={() => {
              setShowParsingModal(false)
              setDemoToParse(null)
              setDemosToParse([])
            }}
          />
        )}

        {/* Voice Playback Modal */}
        <VoicePlaybackModal
          isOpen={showVoiceModal}
          onClose={() => {
            setShowVoiceModal(false)
          }}
          demoPath={demoPath}
          playerSteamId={voicePlayerSteamId}
          playerName={voicePlayerName}
        />

        {/* Team Voice Modal */}
        <TeamCommsModal
          isOpen={showTeamCommsModal}
          onClose={() => setShowTeamCommsModal(false)}
          demoPath={demoPath}
          teamName={teamCommsName}
          players={teamCommsPlayers}
        />

        {/* Parser Logs Modal */}
        <ParserLogsModal
          isOpen={showParserLogsModal}
          onClose={() => {
            setShowParserLogsModal(false)
            setSelectedMatchForLogs(null)
          }}
          matchId={selectedMatchForLogs || ''}
        />

        {/* Clip Export Panel */}
        {showExportPanel && selectedMatch && demoPath && (
          <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
            <div className="max-w-3xl w-full max-h-[90vh] overflow-auto">
              <ClipExportPanel
                demoPath={demoPath}
                matchId={selectedMatch}
                incidents={getExportableEvents()}
                onClose={() => setShowExportPanel(false)}
              />
            </div>
          </div>
        )}
      </>
    </div>
  )
}

export default MatchesScreen
