import { useState, useEffect, useRef } from 'react'
import { ArrowLeft, ChevronDown } from 'lucide-react'
import type { Incident } from '../types/electron'

interface Event {
  type: string
  roundIndex: number
  startTick: number
  endTick: number | null
  actorSteamId: string | null
  victimSteamId: string | null
  severity: number | null
  confidence: number | null
  meta: any
}

interface Player {
  steamId: string
  name: string
}

interface EventsListProps {
  incident: Incident
  interactive: boolean
  onEventSelect: (event: Event) => void
  onBack: () => void
  selectedPlayerFilter?: string
  onPlayerFilterChange?: (filter: string) => void
}

function EventsList({ incident, interactive, onEventSelect, onBack, selectedPlayerFilter: externalFilter, onPlayerFilterChange }: EventsListProps) {
  const [allEvents, setAllEvents] = useState<Event[]>([])
  const [filteredEvents, setFilteredEvents] = useState<Event[]>([])
  const [players, setPlayers] = useState<Player[]>([])
  const [selectedPlayerFilter, setSelectedPlayerFilter] = useState<string>(externalFilter || 'all')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  
  // Sync with external filter if provided
  useEffect(() => {
    if (externalFilter !== undefined) {
      setSelectedPlayerFilter(externalFilter)
    }
  }, [externalFilter])
  
  const handleFilterChange = (filter: string) => {
    setSelectedPlayerFilter(filter)
    if (onPlayerFilterChange) {
      onPlayerFilterChange(filter)
    }
  }

  // Fetch players and events
  useEffect(() => {
    if (!incident.matchId || !window.electronAPI) {
      setError('Match ID not available')
      setLoading(false)
      return
    }

    const fetchData = async () => {
      try {
        setLoading(true)
        setError(null)

        // Fetch players
        const playersResult = await window.electronAPI.getMatchPlayers(incident.matchId!)
        if (playersResult && playersResult.players) {
          setPlayers(playersResult.players)
        }

        // Fetch all events for the match
        const allEventsResult = await window.electronAPI.getMatchEvents(incident.matchId!)
        if (allEventsResult && allEventsResult.events) {
          // Remove duplicates and filter out normal kills (but keep team kills)
          const uniqueEvents = Array.from(
            new Map(
              allEventsResult.events.map(e => [`${e.startTick}-${e.type}-${e.actorSteamId}`, e])
            ).values()
          )
            .filter(e => e.type !== 'KILL') // Only filter out normal kills, keep TEAM_KILL
            .sort((a, b) => a.startTick - b.startTick)

          setAllEvents(uniqueEvents)
        }
      } catch (err) {
        console.error('[EventsList] Error fetching data:', err)
        setError(err instanceof Error ? err.message : 'Failed to fetch data')
      } finally {
        setLoading(false)
      }
    }

    fetchData()
  }, [incident.matchId])

  // Filter events based on selected player (only show events where they are the offender/actor)
  useEffect(() => {
    if (selectedPlayerFilter === 'all') {
      setFilteredEvents(allEvents)
    } else {
      // Filter by specific player steamId - only show events where they are the offender (actor)
      setFilteredEvents(
        allEvents.filter(e => e.actorSteamId === selectedPlayerFilter)
      )
    }
  }, [selectedPlayerFilter, allEvents])

  const formatEventType = (type: string): string => {
    return type
      .split('_')
      .map(word => word.charAt(0) + word.slice(1).toLowerCase())
      .join(' ')
  }

  const formatTick = (tick: number): string => {
    // Convert tick to approximate time (assuming 64 tick rate)
    const seconds = Math.floor(tick / 64)
    const minutes = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${minutes}:${secs.toString().padStart(2, '0')}`
  }

  const getPlayerName = (steamId: string | null): string => {
    if (!steamId) return 'Unknown'
    const player = players.find(p => p.steamId === steamId)
    return player ? player.name : steamId
  }

  if (!interactive) {
    return null
  }

  return (
    <div className="bg-primary/95 backdrop-blur-sm rounded-lg border border-border/50 p-4 shadow-xl min-w-[400px] max-w-md max-h-[600px] flex flex-col">
      <div className="flex items-center gap-3 mb-4">
        <h3 className="text-white text-base font-semibold">Events</h3>
      </div>

      {/* Player filter dropdown */}
      <div className="mb-3">
        <select
          value={selectedPlayerFilter}
          onChange={(e) => handleFilterChange(e.target.value)}
          className="w-full bg-surface/50 border border-border/50 rounded px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-accent/50 appearance-none cursor-pointer"
          style={{
            backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23ffffff' d='M6 9L1 4h10z'/%3E%3C/svg%3E")`,
            backgroundRepeat: 'no-repeat',
            backgroundPosition: 'right 0.75rem center',
            paddingRight: '2.5rem',
          }}
        >
          <option value="all">All Players</option>
          {players.map((player) => (
            <option key={player.steamId} value={player.steamId}>
              {player.name}
            </option>
          ))}
        </select>
      </div>

      {loading ? (
        <div className="flex-1 flex items-center justify-center py-8">
          <div className="text-gray-400 text-sm">Loading events...</div>
        </div>
      ) : error ? (
        <div className="flex-1 flex items-center justify-center py-8">
          <div className="text-red-400 text-sm">{error}</div>
        </div>
      ) : filteredEvents.length === 0 ? (
        <div className="flex-1 flex items-center justify-center py-8">
          <div className="text-gray-400 text-sm">No events found</div>
        </div>
      ) : (
        <div
          ref={scrollContainerRef}
          className="flex-1 overflow-y-auto space-y-1 pr-2"
          style={{ maxHeight: '500px' }}
        >
          {filteredEvents.map((event, index) => (
            <button
              key={index}
              onClick={() => onEventSelect(event)}
              className="w-full bg-surface/50 rounded p-2.5 text-left hover:bg-surface/70 active:bg-surface/80 transition-colors border border-border/30"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <div className="text-white text-sm font-semibold truncate">
                    {formatEventType(event.type)}
                  </div>
                  <div className="text-gray-400 text-xs mt-1">
                    <div>Offender: {getPlayerName(event.actorSteamId)}</div>
                    {event.victimSteamId && (
                      <div>Victim: {getPlayerName(event.victimSteamId)}</div>
                    )}
                  </div>
                  <div className="text-gray-400 text-xs mt-0.5">
                    Tick: {event.startTick.toLocaleString()} ({formatTick(event.startTick)})
                  </div>
                  {event.roundIndex !== undefined && (
                    <div className="text-gray-500 text-xs mt-0.5">
                      Round {event.roundIndex + 1}
                    </div>
                  )}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      {filteredEvents.length > 0 && (
        <div className="text-xs text-gray-400 mt-3 pt-3 border-t border-border/30">
          {filteredEvents.length} event{filteredEvents.length !== 1 ? 's' : ''}
        </div>
      )}
    </div>
  )
}

export default EventsList
