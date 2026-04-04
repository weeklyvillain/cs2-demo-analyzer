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
import MatchListPanel from './MatchListPanel'
import MatchDetailsHeader from './MatchDetailsHeader'
import MatchesOverviewTab from './MatchesOverviewTab'
import MatchesRoundsTab from './MatchesRoundsTab'
import MatchesPlayersTab from './MatchesPlayersTab'
import MatchesChatTab from './MatchesChatTab'
import MatchesViewer2DTab from './MatchesViewer2DTab'
import { buildDisconnectEventMap, enrichChatWithDisconnectReasons } from '../utils/chatEnrichment'
import { formatTime, formatEventDuration } from '../utils/formatters'
import type { Match, MatchStats, PlayerScore, Round, RoundStats, PlayerEvent, ActiveTab, Player } from '../types/matches'
import { t } from '../utils/translations'

function MatchesScreen() {
  const [matches, setMatches] = useState<Match[]>([])
  const [selectedMatch, setSelectedMatch] = useState<string | null>(null)
  const [scores, setScores] = useState<PlayerScore[]>([])
  const [rounds, setRounds] = useState<Round[]>([])
  const [roundStats, setRoundStats] = useState<Map<number, RoundStats>>(new Map())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<{ message: string; type?: 'success' | 'error' | 'info' } | null>(null)
  const [activeTab, setActiveTab] = useState<ActiveTab>('overview')
  const [allEvents, setAllEvents] = useState<any[]>([])
  const [allPlayers, setAllPlayers] = useState<Player[]>([])
  const [selectedPlayer, setSelectedPlayer] = useState<PlayerScore | null>(null)
  const [playerEvents, setPlayerEvents] = useState<PlayerEvent[]>([])
  const [loadingEvents, setLoadingEvents] = useState(false)
  const [demoPath, setDemoPath] = useState<string | null>(null)
  const [tickRate, setTickRate] = useState<number>(64)
  const [chatMessages, setChatMessages] = useState<Array<{ matchId: string; roundIndex: number; tick: number; steamid: string; name: string; team: string | null; message: string; isTeamChat: boolean }>>([])
  const [viewer2D, setViewer2D] = useState<{ roundIndex: number; tick: number } | null>(null)
  const [hasRadarForCurrentMap, setHasRadarForCurrentMap] = useState(false)
  const [showMatchOverview, setShowMatchOverview] = useState(false)
  const [matchStats, setMatchStats] = useState<Map<string, MatchStats>>(new Map())
  const [sortField, setSortField] = useState<'id' | 'length' | 'map' | 'date'>('date')
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc')
  const [selectedMatches, setSelectedMatches] = useState<Set<string>>(new Set())
  const [showDeleteModal, setShowDeleteModal] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [showDemoLoadModal, setShowDemoLoadModal] = useState(false)
  const [pendingDemoAction, setPendingDemoAction] = useState<{
    demoPath: string
    startTick: number
    playerName: string
    isPov?: boolean
    playerSteamId?: string
    rounds?: Array<{ startTick: number; endTick: number }>
    deathTicks?: Array<{ roundIndex: number; tick: number }>
    tickRate?: number
  } | null>(null)
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
  const [enableDbViewer, setEnableDbViewer] = useState(false)
  const [searchQuery, setSearchQuery] = useState<string>('')
  const [showParserLogsModal, setShowParserLogsModal] = useState(false)
  const [selectedMatchForLogs, setSelectedMatchForLogs] = useState<string | null>(null)
  const [, forceUpdate] = useState(0)
  const [showExportPanel, setShowExportPanel] = useState(false)

  // Listen for language changes
  useEffect(() => {
    const interval = setInterval(() => forceUpdate((prev) => prev + 1), 1000)
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
    const interval = setInterval(loadDbViewerSetting, 1000)
    return () => clearInterval(interval)
  }, [])

  // Check if we have a radar image for the selected match's map
  useEffect(() => {
    if (!selectedMatch || !window.electronAPI) {
      setHasRadarForCurrentMap(false)
      return
    }
    const match = matches.find((m) => m.id === selectedMatch)
    const mapName = match?.map
    if (!mapName) {
      setHasRadarForCurrentMap(false)
      return
    }
    let normalizedMapName = mapName.toLowerCase()
    if (normalizedMapName === 'de_cache_b') normalizedMapName = 'de_cache'
    window.electronAPI.getRadarImage(normalizedMapName).then((result) => {
      setHasRadarForCurrentMap(result.success)
    }).catch(() => setHasRadarForCurrentMap(false))
  }, [selectedMatch, matches])

  // If 2D viewer tab is active but we don't have radar, switch back to overview
  useEffect(() => {
    if (activeTab === '2d-viewer' && !hasRadarForCurrentMap) {
      setActiveTab('overview')
    }
  }, [activeTab, hasRadarForCurrentMap])

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
    setError(null)
    try {
      const [chatData, disconnectData] = await Promise.all([
        window.electronAPI.getMatchChat(matchId, steamid),
        window.electronAPI.getMatchEvents(matchId, { type: 'DISCONNECT', steamid }),
      ])
      const messages = chatData.messages || []
      console.log('Disconnect events found:', disconnectData.events?.length || 0)
      console.log('Disconnect messages in chat:', messages.filter((m: any) => m.message?.toLowerCase().includes('left the game')).length)
      const disconnectEventMap = buildDisconnectEventMap(disconnectData.events || [])
      const enriched = enrichChatWithDisconnectReasons(messages, disconnectEventMap)
      setChatMessages(enriched.sort((a: any, b: any) => a.tick - b.tick))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load chat messages')
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
      if (roundsData.tickRate) setTickRate(roundsData.tickRate)
      const match = matches.find((m) => m.id === matchId)
      if (match?.demoPath) setDemoPath(match.demoPath)

      const statsByRound = new Map<number, RoundStats>()
      for (const round of roundsData.rounds || []) {
        const roundEvents = (eventsData.events || []).filter((e: any) => e.roundIndex === round.roundIndex)
        const teamKills = roundEvents.filter((e: any) => e.type === 'TEAM_KILL').length
        const teamDamage = roundEvents.filter((e: any) => e.type === 'TEAM_DAMAGE').reduce((sum: number, e: any) => sum + (e.meta?.total_damage || 0), 0)
        const teamFlash = roundEvents.filter((e: any) => e.type === 'TEAM_FLASH').reduce((sum: number, e: any) => sum + (e.meta?.blind_duration || 0), 0)
        const afk = roundEvents.filter((e: any) => e.type === 'AFK_STILLNESS').reduce((sum: number, e: any) => {
          const duration = e.meta?.seconds || e.meta?.afkDuration || (e.endTick && e.startTick ? (e.endTick - e.startTick) / 64 : 0)
          return sum + duration
        }, 0)
        const visibleEventsForRound = roundEvents.filter((e: any) => e.type !== 'KILL')
        statsByRound.set(round.roundIndex, {
          roundIndex: round.roundIndex,
          teamKills,
          teamDamage,
          teamFlashSeconds: teamFlash,
          afkSeconds: afk,
          events: visibleEventsForRound.map((e: any) => ({
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
    if (window.electronAPI?.onMatchesList) {
      window.electronAPI.onMatchesList((matches) => { setMatches(matches) })
      return () => { window.electronAPI.removeAllListeners('matches:list') }
    }
  }, [])

  // Fetch stats for all matches (in parallel batches; yield to UI between batches)
  const STATS_BATCH_SIZE = 20
  useEffect(() => {
    const defaultStats: MatchStats = { roundCount: 0, duration: 0, teamKills: 0, teamDamage: 0, afkSeconds: 0, teamFlashSeconds: 0, disconnects: 0, tWins: 0, ctWins: 0 }

    const fetchOneMatchStats = async (match: Match): Promise<{ id: string; stats: MatchStats }> => {
      try {
        const [roundsData, eventsData, scoresData] = await Promise.all([
          window.electronAPI!.getMatchRounds(match.id),
          window.electronAPI!.getMatchEvents(match.id),
          window.electronAPI!.getMatchSummary(match.id),
        ])
        const rounds = roundsData.rounds || []
        const events = eventsData.events || []
        const scores = scoresData.players || []
        let roundCount = rounds.length
        let duration = 0, tWins = 0, ctWins = 0
        if (rounds.length > 0) {
          const firstRound = rounds[0]
          const lastRound = rounds[rounds.length - 1]
          const startTick = firstRound.startTick || 0
          const endTick = lastRound.endTick || startTick
          duration = (endTick - startTick) / 64
          if (lastRound.tWins !== undefined) tWins = lastRound.tWins
          if (lastRound.ctWins !== undefined) ctWins = lastRound.ctWins
        }
        const teamKills = events.filter((e: any) => e.type === 'TEAM_KILL').length
        const teamDamage = events.filter((e: any) => e.type === 'TEAM_DAMAGE').reduce((sum: number, e: any) => sum + (e.meta?.damage || 0), 0)
        const afkSeconds = scores.reduce((sum: number, score: any) => sum + (score.afkSeconds || 0), 0)
        const teamFlashSeconds = events.filter((e: any) => e.type === 'TEAM_FLASH').reduce((sum: number, e: any) => sum + (e.meta?.blind_duration || 0), 0)
        const disconnects = events.filter((e: any) => e.type === 'DISCONNECT').length
        return { id: match.id, stats: { roundCount, duration, teamKills, teamDamage, afkSeconds, teamFlashSeconds, disconnects, tWins, ctWins } }
      } catch {
        return { id: match.id, stats: defaultStats }
      }
    }

    const fetchAllMatchStats = async () => {
      if (!window.electronAPI || matches.length === 0) return
      const statsMap = new Map<string, MatchStats>()
      for (let i = 0; i < matches.length; i += STATS_BATCH_SIZE) {
        const batch = matches.slice(i, i + STATS_BATCH_SIZE)
        const results = await Promise.all(batch.map((match) => fetchOneMatchStats(match)))
        results.forEach(({ id, stats }) => statsMap.set(id, stats))
        setMatchStats(new Map(statsMap))
        await new Promise((r) => requestAnimationFrame(r))
      }
    }
    fetchAllMatchStats()
  }, [matches])

  // Filter matches by search query
  const filteredMatches = useMemo(() => {
    if (!searchQuery.trim()) return matches
    const query = searchQuery.toLowerCase().trim()
    return matches.filter(match =>
      match.id.toLowerCase().includes(query) ||
      match.map?.toLowerCase().includes(query) ||
      match.source?.toLowerCase().includes(query)
    )
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
        const getEpochTime = (match: Match): number => {
          if (match.startedAt) { const epoch = new Date(match.startedAt).getTime(); if (!isNaN(epoch)) return epoch }
          if (match.createdAtIso) { const epoch = new Date(match.createdAtIso).getTime(); if (!isNaN(epoch)) return epoch }
          return 0
        }
        const aEpoch = getEpochTime(a), bEpoch = getEpochTime(b)
        if (aEpoch === 0 && bEpoch === 0) comparison = 0
        else if (aEpoch === 0) comparison = 1
        else if (bEpoch === 0) comparison = -1
        else comparison = aEpoch - bEpoch
      }
      return sortDirection === 'asc' ? comparison : -comparison
    })
  }, [filteredMatches, sortField, sortDirection, matchStats])

  const getPlayerName = (steamId: string) => {
    const player = scores.find((p) => p.steamId === steamId)
    return player?.name || steamId
  }

  const handleMatchClick = (matchId: string) => {
    fetchMatchData(matchId)
    setShowMatchOverview(true)
  }

  const handleContextMenuAction = async (action: 'delete' | 'open' | 'showInDb' | 'reparse' | 'select' | 'showLogs', match: Match) => {
    if (action === 'delete') {
      // If the match is already in a multi-selection, delete all selected matches.
      // Otherwise, delete only the right-clicked match.
      if (!selectedMatches.has(match.id)) {
        setSelectedMatches(new Set([match.id]))
      }
      setShowDeleteModal(true)
    } else if (action === 'open' && match.demoPath) {
      try {
        await window.electronAPI?.showFileInFolder(match.demoPath)
      } catch (err) {
        setToast({ message: t('matches.failedToOpenFileLocation'), type: 'error' })
      }
    } else if (action === 'showInDb') {
      localStorage.setItem('dbViewerSelectedMatch', match.id)
      window.dispatchEvent(new CustomEvent('navigateToDbViewer', { detail: { matchId: match.id } }))
    } else if (action === 'reparse' && match.demoPath) {
      setDemoToParse(match.demoPath)
      setShowParsingModal(true)
    } else if (action === 'select') {
      toggleMatchSelection(match.id)
    } else if (action === 'showLogs') {
      setSelectedMatchForLogs(match.id)
      setShowParserLogsModal(true)
    }
  }

  const handlePlayerClick = async (player: PlayerScore) => {
    if (!window.electronAPI || !selectedMatch) return
    setSelectedPlayer(player)
    setLoadingEvents(true)
    try {
      const eventsData = await window.electronAPI.getMatchEvents(selectedMatch, { steamid: player.steamId })
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

  const getExportableEvents = (): ClipRange[] => {
    if (!allEvents || allEvents.length === 0) return []
    return allEvents.map((event, index) => ({
      id: `${selectedMatch}_${event.roundIndex}_${event.startTick}_${event.type}_${index}`,
      startTick: event.startTick,
      endTick: event.endTick || event.startTick + 320,
      label: `${event.type} - Round ${event.roundIndex + 1}`,
      eventType: event.type,
      playerName: event.actorSteamId ? getPlayerName(event.actorSteamId) : 'Unknown Player',
      playerSteamId: event.actorSteamId,
    }))
  }

  const handleWatchInCS2 = async () => {
    if (!window.electronAPI) { setError(t('matches.electronApiNotAvailable')); return }
    if (!demoPath) {
      const path = await window.electronAPI.openFileDialog()
      if (!path) { setError('Demo file path is required to launch CS2'); return }
      setDemoPath(path)
      handleWatchInCS2()
      return
    }
    try {
      const result = await window.electronAPI.launchCS2(demoPath, undefined, undefined, false)
      if (result.error) { setToast({ message: result.error, type: 'error' }); return }
      if (result.needsDemoLoad) { setPendingDemoAction({ demoPath, startTick: 0, playerName: '' }); setShowDemoLoadModal(true); return }
      if (result.success) {
        setError(null)
        const message = result.alreadyRunning ? (result.needsDemoLoad === false ? t('matches.loadingDemo') : t('matches.loadingNewDemo')) : t('matches.launchingCS2')
        setToast({ message, type: 'success' })
      }
      if (result.commands) {
        const message = result.alreadyRunning ? t('matches.cs2AlreadyRunning').replace('{commands}', result.commands) : t('matches.cs2Launched').replace('{commands}', result.commands)
        console.log(message)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('matches.failedToLaunchCS2'))
    }
  }

  const handleDeleteDemo = async () => {
    const userConfirmed = window.confirm(t('matches.deleteDemoConfirm'))
    if (!userConfirmed) return
    const deleteFile = window.confirm(t('matches.deleteDemoFileConfirm'))
    if (!window.electronAPI) { setError(t('matches.electronApiNotAvailable')); return }
    try {
      await window.electronAPI.deleteDemo(demoPath, deleteFile)
      setMatches((prevMatches) => prevMatches.filter(match => match.id !== selectedMatch))
      setSelectedMatch(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('matches.failedToDeleteDemo'))
    }
  }

  const handleCopyChatMessage = async (message: string) => {
    try {
      await navigator.clipboard.writeText(message)
      setToast({ message: t('matches.chatMessageCopied'), type: 'success' })
    } catch (err) {
      console.error('Failed to copy chat message:', err)
      setToast({ message: t('matches.failedToCopyChat'), type: 'error' })
    }
  }

  const handleCopyPlayerChat = async () => {
    if (chatMessages.length === 0) return
    try {
      const timeSeconds = (tick: number) => {
        const totalSeconds = tick / 64
        const minutes = Math.floor(totalSeconds / 60)
        const seconds = Math.floor(totalSeconds % 60)
        return `${minutes}:${seconds.toString().padStart(2, '0')}`
      }
      const filteredMessages = chatMessages.filter(msg => (msg.name || msg.steamid) !== '*server*')
      if (filteredMessages.length === 0) { setToast({ message: t('matches.noChatToCopy'), type: 'info' }); return }
      const chatText = filteredMessages.map(msg => {
        const timeStr = timeSeconds(msg.tick)
        const playerName = msg.name || msg.steamid
        const teamTag = msg.team ? `[${msg.team}] ` : ''
        return `[Round ${msg.roundIndex + 1}] [${timeStr}] ${teamTag}${playerName}: ${msg.message}`
      }).join('\n')
      await navigator.clipboard.writeText(chatText)
      setToast({ message: t('matches.chatForPlayerCopied').replace('{name}', t('matches.allPlayers')), type: 'success' })
    } catch (err) {
      console.error('Failed to copy player chat:', err)
      setToast({ message: t('matches.failedToCopyPlayerChat'), type: 'error' })
    }
  }

  const launchAtTick = async (tick: number, playerName: string) => {
    if (!window.electronAPI || !demoPath) return
    try {
      const result = await window.electronAPI.launchCS2(demoPath, tick, playerName, false)
      if (result.error) { setToast({ message: result.error, type: 'error' }); return }
      if (result.needsDemoLoad) { setPendingDemoAction({ demoPath, startTick: tick, playerName }); setShowDemoLoadModal(true); return }
      if (result.success) {
        setError(null)
        const message = result.alreadyRunning ? (result.needsDemoLoad === false ? t('matches.jumpingToEvent') : t('matches.loadingDemoAndJumping')) : t('matches.launchingCS2')
        setToast({ message, type: 'success' })
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : t('matches.failedToLaunchOrSend')
      setError(errorMessage)
      setToast({ message: errorMessage, type: 'error' })
    }
  }

  const handleWatchAtTick = async (tick: number, playerName: string, _roundIndex: number) => {
    if (!window.electronAPI) { setError(t('matches.electronApiNotAvailable')); return }
    if (!demoPath) { setError('Demo file path is required.'); return }
    await launchAtTick(tick, playerName)
  }

  const handleCopyCommand = async (event: any) => {
    if (!window.electronAPI) { setError(t('matches.electronApiNotAvailable')); return }
    if (!demoPath) { setError('Demo file path is required. Please set it in the overview.'); return }
    const playerName = getPlayerName(event.actorSteamId)
    if (event.type === 'TEAM_KILL' && event.actorSteamId && event.victimSteamId && window.electronAPI.overlay.sendIncident) {
      await window.electronAPI.overlay.sendIncident({
        matchId: selectedMatch, tick: event.startTick, eventType: event.type,
        offender: { name: getPlayerName(event.actorSteamId), steamId: event.actorSteamId },
        victim: { name: getPlayerName(event.victimSteamId), steamId: event.victimSteamId },
      })
    }
    await launchAtTick(event.startTick, playerName)
  }

  const handleConfirmDemoLoad = async () => {
    if (!pendingDemoAction || !window.electronAPI) { setShowDemoLoadModal(false); setPendingDemoAction(null); return }
    try {
      if (pendingDemoAction.isPov && pendingDemoAction.playerSteamId != null && pendingDemoAction.rounds != null && pendingDemoAction.deathTicks != null) {
        const result = await window.electronAPI.launchCS2POV(pendingDemoAction.demoPath, pendingDemoAction.playerName, pendingDemoAction.playerSteamId, pendingDemoAction.rounds, pendingDemoAction.deathTicks, pendingDemoAction.tickRate ?? 64, true)
        if (result.error) { setError(result.error); setToast({ message: result.error, type: 'error' }) }
        else if (result.success) { setError(null); setToast({ message: 'Loading demo and starting POV playback...', type: 'success' }) }
      } else {
        const result = await window.electronAPI.launchCS2(pendingDemoAction.demoPath, pendingDemoAction.startTick, pendingDemoAction.playerName, true)
        if (result.error) { setError(result.error); setToast({ message: result.error, type: 'error' }) }
        else if (result.success) {
          setError(null)
          const message = pendingDemoAction.startTick > 0 ? 'Loading new demo and jumping to event...' : 'Loading new demo from start...'
          setToast({ message, type: 'success' })
        }
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

  const handleWatchPOV = async (score: PlayerScore & { team?: string | null }) => {
    if (!window.electronAPI) { setToast({ message: t('matches.electronApiNotAvailable'), type: 'error' }); return }
    if (!demoPath) {
      const path = await window.electronAPI.openFileDialog(false, 'demo')
      if (!path) { setToast({ message: 'Demo file path is required to watch POV', type: 'error' }); return }
      setDemoPath(path)
      setTimeout(() => handleWatchPOV(score), 0)
      return
    }
    if (!selectedMatch) { setToast({ message: 'No match selected', type: 'error' }); return }
    try {
      const { deathTicks: deathTicksList } = await window.electronAPI.getMatchPlayerDeathTicks(selectedMatch, score.steamId)
      const roundsForPov = rounds.map((r) => ({ startTick: r.startTick, endTick: r.endTick }))
      const result = await window.electronAPI.launchCS2POV(demoPath, score.name || score.steamId, score.steamId, roundsForPov, deathTicksList, tickRate, false)
      if (result.error) { setToast({ message: result.error, type: 'error' }); return }
      if (result.needsDemoLoad) {
        setPendingDemoAction({ demoPath, startTick: rounds[0]?.startTick ?? 0, playerName: score.name || score.steamId, isPov: true, playerSteamId: score.steamId, rounds: roundsForPov, deathTicks: deathTicksList, tickRate })
        setShowDemoLoadModal(true)
        return
      }
      if (result.success) setToast({ message: 'Starting POV playback (2x, jump on death)...', type: 'success' })
    } catch (err) {
      setToast({ message: err instanceof Error ? err.message : 'Failed to start POV', type: 'error' })
    }
  }

  const handleExtractVoice = (player: PlayerScore, e?: React.MouseEvent) => {
    e?.stopPropagation()
    if (!demoPath || !selectedMatch) { setToast({ message: t('matches.demoFileRequired'), type: 'error' }); return }
    setVoicePlayerSteamId(player.steamId)
    setVoicePlayerName(player.name)
    setShowVoiceModal(true)
  }

  const handleExtractTeamVoice = (teamName: string, teamPlayers: PlayerScore[], e?: React.MouseEvent) => {
    e?.stopPropagation()
    if (!demoPath || !selectedMatch) { setToast({ message: t('matches.demoFileRequired'), type: 'error' }); return }
    setTeamCommsName(teamName)
    setTeamCommsPlayers(teamPlayers.map((player) => ({ steamId: player.steamId, name: player.name || player.steamId })))
    setShowTeamCommsModal(true)
  }

  // Filter and group events by type (for PlayerModal)
  const eventTypeLabels: Record<string, string> = {
    TEAM_KILL: t('matches.sections.teamKills'),
    TEAM_DAMAGE: t('matches.sections.teamDamage'),
    TEAM_FLASH: t('matches.sections.teamFlashes'),
    AFK_STILLNESS: t('matches.sections.afk'),
    DISCONNECT: t('matches.sections.disconnects'),
    ECONOMY_GRIEF: 'Economy Griefing',
  }

  const toggleMatchSelection = (matchId: string) => {
    setSelectedMatches((prev) => {
      const next = new Set(prev)
      if (next.has(matchId)) next.delete(matchId)
      else next.add(matchId)
      return next
    })
  }

  const handleDeleteSelected = async () => {
    if (selectedMatches.size === 0) return
    setDeleting(true)
    setError(null)
    try {
      await window.electronAPI.deleteMatches(Array.from(selectedMatches))
      setMatches((prev) => prev.filter(m => !selectedMatches.has(m.id)))
      setSelectedMatches(new Set())
      setShowDeleteModal(false)
      if (selectedMatch && selectedMatches.has(selectedMatch)) setSelectedMatch(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('matches.failedToDeleteMatches'))
    } finally {
      setDeleting(false)
    }
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (!isDragging) setIsDragging(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (!e.currentTarget.contains(e.relatedTarget as Node)) setIsDragging(false)
  }

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
    const files = Array.from(e.dataTransfer.files)
    const demoFiles = files.filter(file => file.name.endsWith('.dem'))
    if (demoFiles.length === 0) { setError(t('matches.dropFiles')); return }
    const filePaths = demoFiles.map(file => (file as any).path || file.name).filter(Boolean)
    if (filePaths.length === 1) {
      setDemoToParse(filePaths[0]); setDemosToParse([]); setShowParsingModal(true)
    } else {
      setDemoToParse(filePaths[0]); setDemosToParse(filePaths.slice(1)); setShowParsingModal(true)
    }
  }

  const handleAddDemo = async () => {
    if (!window.electronAPI) return
    const result = await window.electronAPI.openFileDialog(false, 'demo')
    if (!result) return
    const path = Array.isArray(result) ? result[0] : result
    if (!path) return
    setDemoToParse(path)
    setDemosToParse([])
    setShowParsingModal(true)
  }

  return (
    <div
      className={`flex-1 flex flex-col p-6 overflow-auto transition-colors ${isDragging ? 'bg-accent/10 border-2 border-dashed border-accent' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {!showMatchOverview ? (
        <MatchListPanel
          matches={matches}
          sortedMatches={sortedMatches}
          matchStats={matchStats}
          loading={loading}
          searchQuery={searchQuery}
          setSearchQuery={setSearchQuery}
          sortField={sortField}
          setSortField={setSortField}
          sortDirection={sortDirection}
          setSortDirection={setSortDirection}
          selectedMatches={selectedMatches}
          showDeleteModal={showDeleteModal}
          setShowDeleteModal={setShowDeleteModal}
          deleting={deleting}
          enableDbViewer={enableDbViewer}
          onMatchClick={(matchId) => handleMatchClick(matchId)}
          onContextMenuAction={(action, match) => handleContextMenuAction(action, match)}
          onToggleMatchSelection={(matchId) => toggleMatchSelection(matchId)}
          onClearSelection={() => setSelectedMatches(new Set())}
          onDeleteSelected={handleDeleteSelected}
          onAddDemo={handleAddDemo}
        />
      ) : (
        <div className="flex-1 flex flex-col min-h-0">
          {/* Back Button */}
          <div className="mb-4">
            <button
              onClick={() => { setShowMatchOverview(false); setSelectedMatch(null) }}
              className="flex items-center gap-2 px-4 py-2 bg-surface border border-border rounded hover:bg-surface/80 transition-colors"
            >
              <span>←</span>
              <span>Back to Matches</span>
            </button>
          </div>

          {/* Match Details */}
          <div className="flex-1 bg-secondary rounded-lg border border-border p-4 overflow-auto min-h-0 [scrollbar-gutter:stable]">
            {selectedMatch ? (
              <>
                <MatchDetailsHeader
                  selectedMatch={selectedMatch}
                  matchStats={matchStats}
                  rounds={rounds}
                  tickRate={tickRate}
                  allPlayers={allPlayers}
                  demoPath={demoPath}
                  activeTab={activeTab}
                  setActiveTab={setActiveTab}
                  hasRadarForCurrentMap={hasRadarForCurrentMap}
                  onWatchInCS2={handleWatchInCS2}
                  onDeleteDemo={handleDeleteDemo}
                  onOpenExportPanel={() => setShowExportPanel(true)}
                  onFetchChatMessages={fetchChatMessages}
                />

                {loading ? (
                  <div className="text-center text-gray-400 py-8">{t('matches.loading')}</div>
                ) : activeTab === 'overview' ? (
                  <MatchesOverviewTab
                    allEvents={allEvents}
                    allPlayers={allPlayers}
                    demoPath={demoPath}
                    tickRate={tickRate}
                    hasRadarForCurrentMap={hasRadarForCurrentMap}
                    onSetViewer2D={setViewer2D}
                    onWatchAtTick={handleWatchAtTick}
                    onToast={setToast}
                  />
                ) : activeTab === 'rounds' ? (
                  <MatchesRoundsTab
                    rounds={rounds}
                    roundStats={roundStats}
                    allPlayers={allPlayers}
                    demoPath={demoPath}
                    tickRate={tickRate}
                    hasRadarForCurrentMap={hasRadarForCurrentMap}
                    onWatchAtTick={handleWatchAtTick}
                    onSetViewer2D={setViewer2D}
                  />
                ) : activeTab === 'players' ? (
                  <MatchesPlayersTab
                    scores={scores}
                    allPlayers={allPlayers}
                    demoPath={demoPath}
                    selectedMatch={matches.find(m => m.id === selectedMatch)!}
                    onPlayerClick={handlePlayerClick}
                    onExtractVoice={handleExtractVoice}
                    onExtractTeamVoice={handleExtractTeamVoice}
                    onWatchPOV={handleWatchPOV}
                  />
                ) : activeTab === 'chat' ? (
                  <MatchesChatTab
                    chatMessages={chatMessages}
                    scores={scores}
                    selectedMatchId={selectedMatch}
                    onFetchChatMessages={fetchChatMessages}
                    onCopyMessage={handleCopyChatMessage}
                    onCopyAllChat={handleCopyPlayerChat}
                  />
                ) : activeTab === '2d-viewer' && hasRadarForCurrentMap ? (
                  selectedMatch ? (
                    <div className="flex-1 min-h-0">
                      <MatchesViewer2DTab
                        matchId={selectedMatch}
                        roundIndex={-1}
                        initialTick={rounds.length > 0 ? rounds[0].startTick : 0}
                        roundStartTick={rounds.length > 0 ? rounds[0].startTick : 0}
                        roundEndTick={rounds.length > 0 ? rounds[rounds.length - 1].endTick : 0}
                        mapName={matches.find(m => m.id === selectedMatch)?.map || ''}
                        onClose={() => {}}
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
              <div className="text-center text-gray-400 py-8">Select a match to view details</div>
            )}
          </div>
        </div>
      )}

      <>
        {/* Demo Load Confirmation Modal */}
        <Modal
          isOpen={showDemoLoadModal}
          onClose={() => { setShowDemoLoadModal(false); setPendingDemoAction(null) }}
          title="Load Different Demo?"
          size="md"
        >
          <div className="space-y-4">
            <p className="text-gray-300">CS2 is currently playing a different demo. Do you want to load the new demo?</p>
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
              onClick={() => { setShowDemoLoadModal(false); setPendingDemoAction(null) }}
              className="px-4 py-2 bg-surface hover:bg-surface/80 text-white rounded transition-colors"
            >Cancel</button>
            <button onClick={handleConfirmDemoLoad} className="px-4 py-2 bg-accent hover:bg-accent/80 text-white rounded transition-colors">Load Demo</button>
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
              if (round) setViewer2D({ roundIndex, tick })
            }}
            show2DViewer={hasRadarForCurrentMap}
            demoPath={demoPath}
            tickRate={tickRate}
            getPlayerName={getPlayerName}
            formatTime={formatTime}
            formatEventDuration={formatEventDuration}
            eventTypeLabels={eventTypeLabels}
            rounds={rounds}
          />
        )}

        {/* 2D Viewer Modal (only when radar available for map) */}
        {viewer2D && selectedMatch && hasRadarForCurrentMap && (
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
        {(demoToParse != null || demosToParse.length > 0) && (
          <ParsingModal
            demosToParse={demoToParse != null ? [demoToParse, ...demosToParse] : demosToParse}
            onClose={() => { setShowParsingModal(false); setDemoToParse(null); setDemosToParse([]) }}
            isMinimized={!showParsingModal}
            onRunInBackground={() => setShowParsingModal(false)}
          />
        )}

        {/* Voice Playback Modal */}
        <VoicePlaybackModal
          isOpen={showVoiceModal}
          onClose={() => setShowVoiceModal(false)}
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
          onClose={() => { setShowParserLogsModal(false); setSelectedMatchForLogs(null) }}
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
