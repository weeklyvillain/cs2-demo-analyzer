import { useState, useEffect, useMemo } from 'react'
import Viewer2D from './Viewer2D'
import Modal from './Modal'
import PlayerModal from './PlayerModal'
import ParsingModal from './ParsingModal'
import VoicePlaybackModal from './VoicePlaybackModal'
import Toast from './Toast'
import { formatDisconnectReason } from '../utils/disconnectReason'
import { Clock, Skull, Zap, WifiOff, ChevronDown, ChevronUp, Copy, Check, ArrowUp, ArrowDown, Trash2, X, Plus, Loader2, Mic } from 'lucide-react'

interface Match {
  id: string
  map: string
  startedAt: string | null
  playerCount: number
  demoPath?: string | null
  isMissingDemo?: boolean
  createdAtIso?: string | null
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
  const [allPlayers, setAllPlayers] = useState<Array<{ steamId: string; name: string }>>([])
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
  })
  const [afkMinSeconds, setAfkMinSeconds] = useState<number>(10)
  const [flashMinSeconds, setFlashMinSeconds] = useState<number>(1.5)
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
  const [isSelectionMode, setIsSelectionMode] = useState(false)
  const [showDeleteModal, setShowDeleteModal] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [showParsingModal, setShowParsingModal] = useState(false)
  const [demoToParse, setDemoToParse] = useState<string | null>(null)
  const [demosToParse, setDemosToParse] = useState<string[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const [showVoiceModal, setShowVoiceModal] = useState(false)
  const [voicePlayerSteamId, setVoicePlayerSteamId] = useState<string>('')
  const [voicePlayerName, setVoicePlayerName] = useState<string>('')

  const fetchMatches = async () => {
    if (!window.electronAPI) {
      setError('Electron API not available')
      return
    }

    setLoading(true)
    setError(null)

    try {
      const data = await window.electronAPI.listMatches()
      setMatches(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load matches')
    } finally {
      setLoading(false)
    }
  }

  const fetchChatMessages = async (matchId: string, steamid?: string) => {
    if (!window.electronAPI) {
      setError('Electron API not available')
      return
    }

    setLoadingChat(true)
    setError(null)

    try {
      const chatData = await window.electronAPI.getMatchChat(matchId, steamid)
      setChatMessages(chatData.messages || [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load chat messages')
    } finally {
      setLoadingChat(false)
    }
  }

  const fetchMatchData = async (matchId: string) => {
    if (!window.electronAPI) {
      setError('Electron API not available')
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

  // Sort matches based on current sort settings
  const sortedMatches = useMemo(() => {
    return [...matches].sort((a, b) => {
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
  }, [matches, sortField, sortDirection, matchStats])

  // Merge all players with their scores to show all players in the tab
  const allPlayersWithScores = useMemo(() => {
    // Create a map of scores by steamId for quick lookup
    const scoresMap = new Map(scores.map(score => [score.steamId, score]))
    
    // Merge allPlayers with scores, creating entries for players without scores
    const merged = allPlayers.map(player => {
      const score = scoresMap.get(player.steamId)
      if (score) {
        return score // Player has scores, use them
      }
      // Player doesn't have scores, create a default entry
      return {
        matchId: selectedMatch || '',
        steamId: player.steamId,
        name: player.name || player.steamId,
        teamKills: 0,
        teamDamage: 0,
        teamFlashSeconds: 0,
        afkSeconds: 0,
        bodyBlockSeconds: 0,
        griefScore: 0,
      } as PlayerScore
    })
    
    return merged
  }, [allPlayers, scores, selectedMatch])

  // Sort players based on current sort settings
  const sortedScores = useMemo(() => {
    return [...allPlayersWithScores].sort((a, b) => {
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
      : 'Unknown Date'
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

  // Launch CS2 from overview (without specific event)
  const handleWatchInCS2 = async () => {
    if (!window.electronAPI) {
      setError('Electron API not available')
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
      const result = await window.electronAPI.launchCS2(demoPath, undefined, undefined)
      if (result.commands) {
        // Show a notification that commands were copied to clipboard
        const message = result.alreadyRunning
          ? `CS2 is already running! Console commands copied to clipboard:\n${result.commands}\n\nPaste into CS2 console (press ~).`
          : `CS2 launched! Console commands copied to clipboard:\n${result.commands}\n\nPaste into CS2 console (press ~) after demo loads.`
        // You could show a toast notification here if you add a toast library
        console.log(message)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to launch CS2')
    }
  }

  const handleDeleteDemo = async () => {
    const userConfirmed = window.confirm("Are you sure you want to delete this demo?");
    if (!userConfirmed) return;

    const deleteFile = window.confirm("Do you also want to delete the demo file?");

    if (!window.electronAPI) {
      setError('Electron API not available')
      return
    }

    try {
      await window.electronAPI.deleteDemo(demoPath, deleteFile);
      // Remove the demo from the matches list here
      setMatches((prevMatches) => prevMatches.filter(match => match.id !== selectedMatch));
      setSelectedMatch(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete demo')
    }
  }

  // Copy console commands to clipboard for a specific event (without launching CS2)
  const handleCopyCommand = async (event: any) => {
    if (!window.electronAPI) {
      setError('Electron API not available')
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
      
      const result = await window.electronAPI.copyCS2Commands(demoPath, targetTick, playerName)
      if (result.commands) {
        // Commands are already copied to clipboard
        setError(null)
        setToast({ message: 'Commands copied to clipboard!', type: 'success' })
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to copy commands'
      setError(errorMessage)
      setToast({ message: errorMessage, type: 'error' })
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
      setToast({ message: 'Demo file path is required to extract voice', type: 'error' })
      return
    }

    // Set player info for modal (modal will handle extraction)
    setVoicePlayerSteamId(player.steamId)
    setVoicePlayerName(player.name)
    setShowVoiceModal(true)
  }


  // Filter and group events by type
  const filteredEvents = playerEvents.filter((event) => {
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

  const toggleSelectionMode = () => {
    setIsSelectionMode(!isSelectionMode)
    if (isSelectionMode) {
      setSelectedMatches(new Set())
    }
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
      setIsSelectionMode(false)
      setShowDeleteModal(false)
      
      // If the selected match was deleted, clear selection
      if (selectedMatch && selectedMatches.has(selectedMatch)) {
        setSelectedMatch(null)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete matches')
    } finally {
      setDeleting(false)
    }
  }

  const eventTypeLabels: Record<string, string> = {
    TEAM_KILL: 'Team Kills',
    TEAM_DAMAGE: 'Team Damage',
    TEAM_FLASH: 'Team Flashes',
    AFK_STILLNESS: 'AFK Periods',
    DISCONNECT: 'Disconnects',
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
      setError('Please drop .dem files')
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
      {error && (
        <div className="mb-4 p-4 bg-red-900/20 border border-red-500/50 rounded text-red-400">
          {error}
        </div>
      )}

      {!showMatchOverview ? (
        <>
          <div className="flex justify-between items-center mb-6">
            <h2 className="text-2xl font-bold">Matches</h2>
            <div className="flex gap-2">
              {isSelectionMode && selectedMatches.size > 0 && (
                <button
                  onClick={() => setShowDeleteModal(true)}
                  className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 transition-colors flex items-center gap-2"
                >
                  <Trash2 size={16} />
                  Delete ({selectedMatches.size})
                </button>
              )}
              {isSelectionMode && (
                <div className="flex gap-2">
                  {selectedMatches.size < sortedMatches.length ? (
                    <button
                      onClick={selectAllMatches}
                      className="px-4 py-2 bg-surface border border-border text-white rounded hover:bg-surface/80 transition-colors text-sm"
                    >
                      Select All
                    </button>
                  ) : (
                    <button
                      onClick={deselectAllMatches}
                      className="px-4 py-2 bg-surface border border-border text-white rounded hover:bg-surface/80 transition-colors text-sm"
                    >
                      Deselect All
                    </button>
                  )}
                  <button
                    onClick={toggleSelectionMode}
                    className="px-4 py-2 bg-surface border border-border text-white rounded hover:bg-surface/80 transition-colors text-sm"
                  >
                    Cancel
                  </button>
                </div>
              )}
              {!isSelectionMode && (
                <>
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
                        setError(err instanceof Error ? err.message : 'Failed to open file dialog')
                      }
                    }}
                    className="px-4 py-2 bg-accent text-white rounded hover:bg-accent/80 transition-colors flex items-center gap-2"
                  >
                    <Plus size={16} />
                    Add Demo{/*(s)*/}
                  </button>
                  <button
                    onClick={toggleSelectionMode}
                    className="px-4 py-2 bg-surface border border-border text-white rounded hover:bg-surface/80 transition-colors text-sm"
                  >
                    Select
                  </button>
                  <button
                    onClick={fetchMatches}
                    disabled={loading}
                    className="px-4 py-2 bg-accent text-white rounded hover:bg-accent/80 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Refresh
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Sorting Controls */}
          {matches.length > 0 && (
            <div className="mb-4 flex items-center gap-4 flex-wrap">
              <span className="text-sm text-gray-400">Sort by:</span>
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
                      {field === 'length' ? 'Duration' : field === 'id' ? 'ID' : field === 'date' ? 'Date' : 'Map'}
                    </span>
                    {sortField === field && (
                      sortDirection === 'asc' ? <ArrowUp size={14} /> : <ArrowDown size={14} />
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}

          {loading && matches.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-4">
              <Loader2 className="w-8 h-8 text-accent animate-spin" />
              <div className="text-gray-400">Loading matches...</div>
            </div>
          ) : matches.length === 0 ? (
            <div className="text-center text-gray-400 py-16">
              <p className="text-lg mb-2">No matches found</p>
              <p className="text-sm">Parse a demo to get started.</p>
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
                    className={`bg-secondary rounded-lg border overflow-hidden transition-all hover:shadow-xl group flex flex-col relative ${
                      isSelectionMode
                        ? isSelected
                          ? 'border-accent border-2'
                          : 'border-border hover:border-accent/50'
                        : 'border-border hover:border-accent/50'
                    }`}
                  >
                    {isSelectionMode && (
                      <div className="absolute top-2 left-2 z-10">
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            toggleMatchSelection(match.id)
                          }}
                          className={`w-6 h-6 rounded border-2 flex items-center justify-center transition-colors ${
                            isSelected
                              ? 'bg-accent border-accent'
                              : 'bg-surface/80 border-border hover:border-accent'
                          }`}
                        >
                          {isSelected && <Check size={16} className="text-white" />}
                        </button>
                      </div>
                    )}
                    <button
                      onClick={() => {
                        if (isSelectionMode) {
                          toggleMatchSelection(match.id)
                        } else {
                          handleMatchClick(match.id)
                        }
                      }}
                      className="flex-1 flex flex-col"
                    >
                    <div className="relative h-64 bg-surface overflow-hidden w-full">
                      {thumbnail ? (
                        <img
                          src={thumbnail}
                          alt={match.map || 'Unknown Map'}
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
                      <div className="absolute bottom-3 left-3 right-3">
                        <div className="font-semibold text-white text-base truncate">
                          {match.map || 'Unknown Map'}
                        </div>
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
                            <span className="text-gray-500">Rounds:</span>
                            <span className="text-sm font-semibold text-accent">
                              {stats.roundCount}
                            </span>
                          </div>
                        )}
                        {stats && stats.duration > 0 && (
                          <div className="flex items-center gap-1.5">
                            <span className="text-gray-500">Duration:</span>
                            <span className="text-sm font-semibold text-accent">
                              {formatDuration(stats.duration)}
                            </span>
                          </div>
                        )}
                        {stats && (stats.tWins > 0 || stats.ctWins > 0) && (
                          <div className="flex items-center gap-1.5">
                            <span className="text-gray-500">Score:</span>
                            <span className="text-sm font-semibold text-gray-300">
                              {stats.tWins}-{stats.ctWins}
                            </span>
                          </div>
                        )}
                        <div className="flex items-center gap-1.5">
                          <span className="text-gray-500">Players:</span>
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

          {/* Delete Confirmation Modal */}
          <Modal
            isOpen={showDeleteModal}
            onClose={() => !deleting && setShowDeleteModal(false)}
            title="Ta bort matcher"
            size="md"
            footer={
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setShowDeleteModal(false)}
                  disabled={deleting}
                  className="px-4 py-2 bg-surface border border-border text-white rounded hover:bg-surface/80 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm"
                >
                  Avbryt
                </button>
                <button
                  onClick={handleDeleteSelected}
                  disabled={deleting}
                  className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm"
                >
                  {deleting ? 'Raderar...' : `Ja, radera ${selectedMatches.size} match${selectedMatches.size > 1 ? 'er' : ''}`}
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
                    Är du säker?
                  </h3>
                  <p className="text-sm text-gray-400 mb-2">
                    Detta kommer att radera {selectedMatches.size} match{selectedMatches.size > 1 ? 'er' : ''} permanent från databasen.
                  </p>
                  <p className="text-sm text-red-400 font-medium">
                    Denna åtgärd kan inte ångras.
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
                              <span>Rounds: {roundCount}</span>
                            </div>
                          )
                        }
                        return null
                      })()}
                      {/* Players */}
                      {allPlayers.length > 0 && (
                        <div className="flex items-center gap-1">
                          <span>Players: {allPlayers.length}</span>
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
                          return (
                            <div className="flex items-center gap-1">
                              <span className="text-orange-400">T: {tWins || 0}</span>
                              <span className="text-gray-500">-</span>
                              <span className="text-blue-400">CT: {ctWins || 0}</span>
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
                    Overview
                  </button>
                  <button
                    onClick={() => setActiveTab('players')}
                    className={`px-4 py-2 font-medium transition-colors ${
                      activeTab === 'players'
                        ? 'text-accent border-b-2 border-accent'
                        : 'text-gray-400 hover:text-white'
                    }`}
                  >
                    Players
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
                    Round Details
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
                    Chat Logs
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
                      2D Viewer
                      <span className="px-1.5 py-0.5 text-xs bg-yellow-900/30 text-yellow-400 rounded border border-yellow-500/30">
                        WIP
                      </span>
                    </span>
                  </button>
                </div>
              </div>

              {loading ? (
                <div className="text-center text-gray-400 py-8">Loading...</div>
              ) : activeTab === 'overview' ? (
                (() => {
                  // Aggregate statistics from all events
                  const teamKills = allEvents.filter(e => e.type === 'TEAM_KILL')
                  const teamDamage = allEvents.filter(e => e.type === 'TEAM_DAMAGE')
                  const afkDetections = allEvents.filter(e => e.type === 'AFK_STILLNESS')
                  const disconnects = allEvents.filter(e => e.type === 'DISCONNECT')
                  const teamFlashes = allEvents.filter(e => e.type === 'TEAM_FLASH')
                  
                  const totalTeamDamage = teamDamage.reduce((sum, e) => sum + (e.meta?.total_damage || 0), 0)
                  const totalAfkSeconds = afkDetections.reduce((sum, e) => {
                    // Use meta.seconds or meta.afkDuration if available, otherwise calculate from ticks
                    const duration = e.meta?.seconds || e.meta?.afkDuration || (e.endTick && e.startTick ? (e.endTick - e.startTick) / 64 : 0)
                    return sum + duration
                  }, 0)
                  const totalFlashSeconds = teamFlashes.reduce((sum, e) => sum + (e.meta?.blind_duration || 0), 0)

                  const getPlayerName = (steamId: string | null | undefined) => {
                    if (!steamId) return 'Unknown'
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
                      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
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
                            <span className="text-sm font-medium">Team Damage</span>
                          </div>
                          <div className="text-3xl font-bold mb-1 text-accent">{teamDamage.length}</div>
                          <div className="text-xs text-gray-500">Friendly fire damage events</div>
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
                            <span className="text-sm font-medium">Team Flashes</span>
                          </div>
                          <div className="text-3xl font-bold mb-1 text-accent">{filteredTeamFlashes.length}</div>
                          <div className="text-xs text-gray-500">Friendly flashbang detonations</div>
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
                              AFK Players at Round Start
                              {expandedSections.afk ? <ChevronDown size={18} className="text-gray-500" /> : <ChevronUp size={18} className="text-gray-500" />}
                            </button>
                            <div className="flex items-center gap-2">
                              <label className="text-xs text-gray-400">Min duration:</label>
                              <input
                                type="number"
                                min="0"
                                step="0.5"
                                value={effectiveAfkThreshold}
                                onChange={(e) => setAfkMinSeconds(parseFloat(e.target.value) || 0)}
                                className="w-20 px-2 py-1 bg-secondary border border-border rounded text-white text-xs"
                              />
                              <span className="text-xs text-gray-500">s</span>
                              <span className="text-xs text-gray-500">
                                ({filteredAfkDetections.length}/{afkDetections.length})
                              </span>
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
                                // Sort AFK periods by duration (longest first)
                                const sortedAfks = afks.sort((a, b) => {
                                  const durationA = a.meta?.seconds || a.meta?.afkDuration || (a.endTick && a.startTick ? (a.endTick - a.startTick) / 64 : 0)
                                  const durationB = b.meta?.seconds || b.meta?.afkDuration || (b.endTick && b.startTick ? (b.endTick - b.startTick) / 64 : 0)
                                  return durationB - durationA // Descending order (longest first)
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
                                      <span className="text-xs text-gray-400">{afks.length} AFK period{afks.length !== 1 ? 's' : ''}</span>
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
                                              <span className="text-xs text-gray-400">Round {afk.roundIndex + 1}</span>
                                              {demoPath && (
                                                <button
                                                  onClick={() => handleCopyCommand(afk)}
                                                  className="p-1 hover:bg-accent/20 rounded transition-colors"
                                                  title="Copy CS2 console commands"
                                                >
                                                  <Copy size={14} className="text-gray-400 hover:text-accent" />
                                                </button>
                                              )}
                                            </div>
                                            <div className="text-xs text-gray-400 space-y-1">
                                              <div className="flex items-center gap-2">
                                                <Clock size={12} />
                                                <span>{duration.toFixed(1)}s AFK</span>
                                              </div>
                                              {diedWhileAFK ? (
                                                <div className="flex items-center gap-2 text-red-400">
                                                  <Skull size={12} />
                                                  <span>Ended when player died</span>
                                                </div>
                                              ) : timeToFirstMovement !== undefined ? (
                                                <div className="flex items-center gap-2 text-yellow-400">
                                                  <span>Ended when player started moving</span>
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
                                No AFK detections meet the minimum threshold ({effectiveAfkThreshold}s)
                              </div>
                            )
                          })()}
                        </div>
                      )}

                      {/* Disconnects */}
                      {disconnects.length > 0 && (
                        <div className="bg-surface border border-border rounded-lg p-4">
                          <button
                            onClick={() => toggleSection('disconnects')}
                            className="flex items-center gap-2 text-lg font-semibold mb-3 text-white hover:text-gray-400 transition-colors"
                          >
                            <WifiOff size={18} />
                            Disconnects
                            {expandedSections.disconnects ? <ChevronDown size={18} className="text-gray-500" /> : <ChevronUp size={18} className="text-gray-500" />}
                          </button>
                          {expandedSections.disconnects && (
                            <div className="flex flex-wrap gap-4">
                              {disconnects.map((dc, idx) => {
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
                                          <button
                                            onClick={() => handleCopyCommand(dc)}
                                            className="p-1 hover:bg-accent/20 rounded transition-colors"
                                            title="Copy CS2 console commands"
                                          >
                                            <Copy size={14} className="text-gray-400 hover:text-accent" />
                                          </button>
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
                          <button
                            onClick={() => toggleSection('teamKills')}
                            className="flex items-center gap-2 text-lg font-semibold mb-3 text-white hover:text-red-400 transition-colors"
                          >
                            <Skull size={18} />
                            Team Kills
                            {expandedSections.teamKills ? <ChevronDown size={18} className="text-gray-500" /> : <ChevronUp size={18} className="text-gray-500" />}
                          </button>
                          {expandedSections.teamKills && (
                            <div className="flex flex-wrap gap-4">
                              {teamKills.map((kill, idx) => (
                                <div key={idx} className="bg-secondary border border-border rounded p-3 min-w-[300px]">
                                  <div className="flex items-center justify-between mb-2">
                                    <span className="font-medium text-white">{getPlayerName(kill.actorSteamId)}</span>
                                    <div className="flex items-center gap-2">
                                      <span className="text-xs text-gray-400">Round {kill.roundIndex + 1}</span>
                                      {demoPath && (
                                        <button
                                          onClick={() => handleCopyCommand(kill)}
                                          className="p-1 hover:bg-accent/20 rounded transition-colors"
                                          title="Copy CS2 console commands"
                                        >
                                          <Copy size={14} className="text-gray-400 hover:text-accent" />
                                        </button>
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
                          <button
                            onClick={() => toggleSection('teamDamage')}
                            className="flex items-center gap-2 text-lg font-semibold mb-3 text-white hover:text-accent transition-colors"
                          >
                            <Zap size={18} />
                            Team Damage
                            {expandedSections.teamDamage ? <ChevronDown size={18} className="text-gray-500" /> : <ChevronUp size={18} className="text-gray-500" />}
                          </button>
                          {expandedSections.teamDamage && (
                            <div className="flex flex-wrap gap-4">
                              {teamDamage
                                .sort((a, b) => (b.meta?.total_damage || 0) - (a.meta?.total_damage || 0))
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
                                          <span className="text-xs text-gray-400">Round {damage.roundIndex + 1}</span>
                                          {demoPath && (
                                            <button
                                              onClick={() => handleCopyCommand(damage)}
                                              className="p-1 hover:bg-accent/20 rounded transition-colors"
                                              title="Copy CS2 console commands"
                                            >
                                              <Copy size={14} className="text-gray-400 hover:text-accent" />
                                            </button>
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
                                        {damage.meta?.total_damage?.toFixed(1) || 0} damage
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
                              Team Flashes
                              {expandedSections.teamFlashes ? <ChevronDown size={18} className="text-gray-500" /> : <ChevronUp size={18} className="text-gray-500" />}
                            </button>
                            <div className="flex items-center gap-2">
                              <label className="text-xs text-gray-400">Min blind:</label>
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
                                    .sort((a, b) => (b.meta?.blind_duration || 0) - (a.meta?.blind_duration || 0))
                                    .map((flash, idx) => (
                                      <div key={idx} className="bg-secondary border border-border rounded p-3 min-w-[300px]">
                                        <div className="flex items-center justify-between mb-2">
                                          <span className="font-medium text-white">{getPlayerName(flash.actorSteamId)}</span>
                                          <div className="flex items-center gap-2">
                                            <span className="text-xs text-gray-400">Round {flash.roundIndex + 1}</span>
                                            {demoPath && (
                                              <button
                                                onClick={() => handleCopyCommand(flash)}
                                                className="p-1 hover:bg-accent/20 rounded transition-colors"
                                                title="Copy CS2 console commands"
                                              >
                                                <Copy size={14} className="text-gray-400 hover:text-accent" />
                                              </button>
                                            )}
                                          </div>
                                        </div>
                                        <div className="text-sm text-gray-300">
                                          → {getPlayerName(flash.victimSteamId || '')}
                                        </div>
                                        <div className="text-xs text-accent mt-1">
                                          {flash.meta?.blind_duration?.toFixed(1) || 0}s blind
                                        </div>
                                      </div>
                                    ))}
                                </div>
                              ) : (
                                <div className="text-center text-gray-400 py-4">
                                  No flashes meet the minimum threshold ({effectiveFlashThreshold.toFixed(1)}s)
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })()
              ) : activeTab === 'players' ? (
                allPlayersWithScores.length === 0 ? (
                  <div className="text-center text-gray-400 py-8">No players available</div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border text-left">
                          <th 
                            className="pb-2 cursor-pointer hover:text-white transition-colors select-none"
                            onClick={() => handlePlayerSort('name')}
                          >
                            <div className="flex items-center gap-1">
                              Player
                              {playerSortField === 'name' && (
                                <span className="text-xs text-gray-400">
                                  {playerSortDirection === 'asc' ? '↑' : '↓'}
                                </span>
                              )}
                            </div>
                          </th>
                          <th 
                            className="pb-2 cursor-pointer hover:text-white transition-colors select-none"
                            onClick={() => handlePlayerSort('teamKills')}
                          >
                            <div className="flex items-center gap-1">
                              Team Kills
                              {playerSortField === 'teamKills' && (
                                <span className="text-xs text-gray-400">
                                  {playerSortDirection === 'asc' ? '↑' : '↓'}
                                </span>
                              )}
                            </div>
                          </th>
                          <th 
                            className="pb-2 cursor-pointer hover:text-white transition-colors select-none"
                            onClick={() => handlePlayerSort('teamDamage')}
                          >
                            <div className="flex items-center gap-1">
                              Team Damage
                              {playerSortField === 'teamDamage' && (
                                <span className="text-xs text-gray-400">
                                  {playerSortDirection === 'asc' ? '↑' : '↓'}
                                </span>
                              )}
                            </div>
                          </th>
                          <th 
                            className="pb-2 cursor-pointer hover:text-white transition-colors select-none"
                            onClick={() => handlePlayerSort('teamFlashSeconds')}
                          >
                            <div className="flex items-center gap-1">
                              Flash Seconds
                              {playerSortField === 'teamFlashSeconds' && (
                                <span className="text-xs text-gray-400">
                                  {playerSortDirection === 'asc' ? '↑' : '↓'}
                                </span>
                              )}
                            </div>
                          </th>
                          <th 
                            className="pb-2 cursor-pointer hover:text-white transition-colors select-none"
                            onClick={() => handlePlayerSort('afkSeconds')}
                          >
                            <div className="flex items-center gap-1">
                              AFK Seconds
                              {playerSortField === 'afkSeconds' && (
                                <span className="text-xs text-gray-400">
                                  {playerSortDirection === 'asc' ? '↑' : '↓'}
                                </span>
                              )}
                            </div>
                          </th>
                          <th className="pb-2 text-left">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                      {sortedScores.map((score) => (
                        <tr
                          key={score.steamId}
                          className="border-b border-border/50 hover:bg-surface/50 transition-colors"
                        >
                          <td 
                            className="py-2 cursor-pointer"
                            onClick={() => handlePlayerClick(score)}
                          >
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
                          </td>
                          <td 
                            className="py-2 cursor-pointer"
                            onClick={() => handlePlayerClick(score)}
                          >
                            {score.teamKills}
                          </td>
                          <td 
                            className="py-2 cursor-pointer"
                            onClick={() => handlePlayerClick(score)}
                          >
                            {score.teamDamage.toFixed(1)}
                          </td>
                          <td 
                            className="py-2 cursor-pointer"
                            onClick={() => handlePlayerClick(score)}
                          >
                            {score.teamFlashSeconds.toFixed(1)}s
                          </td>
                          <td 
                            className="py-2 cursor-pointer"
                            onClick={() => handlePlayerClick(score)}
                          >
                            {score.afkSeconds.toFixed(1)}s
                          </td>
                          <td className="py-2">
                            <button
                              onClick={(e) => handleExtractVoice(score, e)}
                              disabled={!demoPath}
                              className="px-3 py-1.5 bg-accent hover:bg-accent/90 disabled:bg-gray-600 disabled:cursor-not-allowed text-white text-xs rounded transition-colors flex items-center gap-1.5"
                              title={!demoPath ? 'Demo file path required' : `Extract voice for ${score.name}`}
                            >
                              <Mic size={14} />
                              Extract Voice
                            </button>
                          </td>
                        </tr>
                      ))}
                      </tbody>
                    </table>
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
                                Score: {round.tWins} - {round.ctWins}
                              </span>
                            </div>
                          </div>

                          {stats && (
                            <div className="grid grid-cols-4 gap-4 mb-3 text-sm">
                              <div>
                                <div className="text-gray-400">Team Kills</div>
                                <div className="font-semibold text-red-400">{stats.teamKills}</div>
                              </div>
                              <div>
                                <div className="text-gray-400">Team Damage</div>
                                <div className="font-semibold text-yellow-400">
                                  {stats.teamDamage.toFixed(1)}
                                </div>
                              </div>
                              <div>
                                <div className="text-gray-400">Flash Seconds</div>
                                <div className="font-semibold text-orange-400">
                                  {stats.teamFlashSeconds.toFixed(1)}s
                                </div>
                              </div>
                              <div>
                                <div className="text-gray-400">AFK Seconds</div>
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
                                          ? `(${event.meta.weapon || `${event.meta.total_damage} dmg`})`
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
                      <label className="text-sm font-medium text-gray-300">Filter by Player:</label>
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
                        <option value="">All Players</option>
                        {scores.map((score) => (
                          <option key={score.steamId} value={score.steamId}>
                            {score.name || score.steamId}
                          </option>
                        ))}
                      </select>
                      
                      <div className="flex items-center gap-2 ml-auto">
                        <span className="text-sm text-gray-400">All Chat Only</span>
                      </div>
                    </div>
                  </div>

                  {/* Chat messages */}
                  {loadingChat ? (
                    <div className="text-center text-gray-400 py-8">Loading chat messages...</div>
                  ) : chatMessages.length === 0 ? (
                    <div className="text-center text-gray-400 py-8">No chat messages found</div>
                  ) : (
                    <div className="grid gap-4 grid-cols-1">
                      {/* All Chat Section */}
                      {(
                        <div className="bg-surface rounded-lg border border-border overflow-hidden">
                          <div className="px-4 py-3 border-b border-border bg-green-900/20">
                            <h3 className="text-lg font-semibold text-green-400">All Chat</h3>
                            <p className="text-xs text-gray-500">
                              {chatMessages.length} messages
                            </p>
                          </div>
                          <div className="max-h-[600px] overflow-y-auto">
                            {chatMessages.length === 0 ? (
                              <div className="text-center text-gray-500 py-8 text-sm">No chat messages</div>
                            ) : (
                              <div className="divide-y divide-border">
                                {chatMessages
                                  .map((msg, idx) => {
                                    const timeSeconds = msg.tick / 64
                                    const minutes = Math.floor(timeSeconds / 60)
                                    const seconds = Math.floor(timeSeconds % 60)
                                    const timeStr = `${minutes}:${seconds.toString().padStart(2, '0')}`
                                    
                                    return (
                                      <div key={`all-${idx}`} className="p-3 hover:bg-secondary/50 transition-colors">
                                        <div className="flex items-start gap-3">
                                          <div className="flex-shrink-0">
                                            <div className="text-xs font-mono text-gray-500">
                                              Round {msg.roundIndex + 1}
                                            </div>
                                            <div className="text-xs text-gray-500">{timeStr}</div>
                                          </div>
                                          <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2 mb-1">
                                              {msg.name ? (
                                                <span className="font-medium text-green-400">
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
                                                  className="font-medium text-green-400 hover:text-green-300 underline bg-transparent border-none cursor-pointer p-0"
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
                                            </div>
                                            <div className="text-sm text-gray-300 break-words">{msg.message}</div>
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
            isOpen={showParsingModal}
            onClose={() => {
              setShowParsingModal(false)
              setDemoToParse(null)
              setDemosToParse([])
            }}
            onComplete={() => {
              // Refresh matches list when parsing completes
              fetchMatches()
              const message = demosToParse.length > 0 
                ? `${demosToParse.length + 1} demos parsed successfully!`
                : 'Demo parsed successfully!'
              setToast({ message, type: 'success' })
            }}
            demoPath={demoToParse}
            demoQueue={demosToParse}
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
      </>
    </div>
  )
}

export default MatchesScreen
