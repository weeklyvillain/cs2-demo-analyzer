import { useState, useEffect } from 'react'
import IncidentPanel from './IncidentPanel'
import EventsList from './EventsList'
import DebugCommandPanel from './DebugCommandPanel'
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

function OverlayScreen() {
  const [isInteractive, setIsInteractive] = useState(false)
  const [incident, setIncident] = useState<Incident | null>(null)
  const [debugMode, setDebugMode] = useState(false)
  const [showEventsList, setShowEventsList] = useState(false)
  const [isLoadingFromEvent, setIsLoadingFromEvent] = useState(false)
  const [selectedPlayerFilter, setSelectedPlayerFilter] = useState<string>('all')

  useEffect(() => {
    // Load initial interactive state
    const loadState = async () => {
      if (window.electronAPI) {
        const interactive = await window.electronAPI.overlay.getInteractive()
        setIsInteractive(interactive)
      }
    }

    loadState()

    // Listen for interactive state changes
    if (window.electronAPI) {
      window.electronAPI.overlay.onInteractive((value) => {
        setIsInteractive(value)
      })

      // Listen for incident updates
      window.electronAPI.overlay.onIncident((incidentData) => {
        setIncident(incidentData)
        // Always default to events list when incident is received
        if (incidentData) {
          setShowEventsList(true)
        } else {
          setShowEventsList(false)
        }
      })

      // Load debug mode setting
      window.electronAPI.settings.getDebugMode().then(setDebugMode)
    }
  }, [])

  const toggleInteractive = async () => {
    if (window.electronAPI) {
      const newValue = !isInteractive
      await window.electronAPI.overlay.setInteractive(newValue)
      setIsInteractive(newValue)
    }
  }

  const handleEventSelect = async (event: Event) => {
    if (!incident || !incident.matchId) return

    // Get player names from the match data
    let offenderName = incident.offender.name
    let victimName = incident.victim.name

    try {
      // Fetch player data to get names if we have steamIds
      if (event.actorSteamId || event.victimSteamId) {
        const playersResult = await window.electronAPI.getMatchPlayers(incident.matchId)
        if (playersResult && playersResult.players) {
          if (event.actorSteamId) {
            const actorPlayer = playersResult.players.find(p => p.steamId === event.actorSteamId)
            if (actorPlayer) {
              offenderName = actorPlayer.name
            }
          }
          if (event.victimSteamId) {
            const victimPlayer = playersResult.players.find(p => p.steamId === event.victimSteamId)
            if (victimPlayer) {
              victimName = victimPlayer.name
            }
          }
        }
      }
    } catch (err) {
      console.error('[OverlayScreen] Failed to fetch player names:', err)
      // Continue with existing names if fetch fails
    }

    // Update incident with the selected event's tick and show perspective panel
    const updatedIncident: Incident = {
      ...incident,
      tick: event.startTick,
      eventType: event.type, // Add event type
      // Update offender/victim based on the event
      offender: event.actorSteamId
        ? {
            name: offenderName,
            steamId: event.actorSteamId,
            userId: incident.offender.userId,
            entityIndex: incident.offender.entityIndex,
          }
        : incident.offender,
      victim: event.victimSteamId
        ? {
            name: victimName,
            steamId: event.victimSteamId,
            userId: incident.victim.userId,
            entityIndex: incident.victim.entityIndex,
          }
        : incident.victim,
    }

    // Send updated incident to main process
    if (window.electronAPI?.overlay.sendIncident) {
      await window.electronAPI.overlay.sendIncident(updatedIncident)
    }

    setIncident(updatedIncident)
    setShowEventsList(false)
    setIsLoadingFromEvent(true) // Trigger loading state

    // Automatically jump to the event tick and spectate the offender
    if (window.electronAPI?.overlay.actions.viewOffender) {
      try {
        await window.electronAPI.overlay.actions.viewOffender()
      } catch (err) {
        console.error('[OverlayScreen] Failed to view offender after event select:', err)
        setIsLoadingFromEvent(false) // Clear loading on error
      }
    }
  }
  
  // Listen for action results to clear loading state
  useEffect(() => {
    if (!window.electronAPI) return

    const handleActionResult = (result: { success: boolean; action: string; player?: string; error?: string; clearLoadingOnly?: boolean }) => {
      // Clear loading when player has been successfully selected (clearLoadingOnly means spectate completed)
      if (result.clearLoadingOnly) {
        setIsLoadingFromEvent(false)
      }
    }

    window.electronAPI.overlay.onActionResult(handleActionResult)
    
    // Cleanup is handled by the overlay API
  }, [])

  const handleBackToEvents = () => {
    setShowEventsList(true)
  }

  return (
    <div className="w-full h-full bg-transparent pointer-events-none">
      {/* Events list or Incident panel - only visible when interactive and there's an incident, top-left */}
      {incident && isInteractive && (
        <div className="absolute top-4 left-4 pointer-events-auto z-50">
          {showEventsList ? (
            <EventsList
              incident={incident}
              interactive={isInteractive}
              onEventSelect={handleEventSelect}
              onBack={handleBackToEvents}
              selectedPlayerFilter={selectedPlayerFilter}
              onPlayerFilterChange={setSelectedPlayerFilter}
            />
          ) : (
            <IncidentPanel
              incident={incident}
              interactive={isInteractive}
              onBack={handleBackToEvents}
              externalLoading={isLoadingFromEvent}
            />
          )}
        </div>
      )}

      {/* Debug command panel - top-right when debug mode is enabled and interactive */}
      <DebugCommandPanel enabled={debugMode} />

      {/* Overlay controls - only visible when interactive */}
      {isInteractive && (
        <div className="absolute bottom-4 right-4 pointer-events-auto z-50">
          <div className="bg-primary/90 rounded-lg p-4 shadow-lg max-w-md">
            <h2 className="text-white text-lg font-semibold mb-2">CS2 Demo Overlay</h2>
            <p className="text-gray-300 text-sm mb-4">
              Overlay is in interactive mode. Click outside to make it click-through again.
            </p>
            <button
              onClick={toggleInteractive}
              className="bg-accent hover:bg-accent/80 text-white px-4 py-2 rounded transition-colors"
            >
              Make Click-Through
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default OverlayScreen
