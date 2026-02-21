import { useState, useEffect, useRef, useCallback } from 'react'
import IncidentPanel from './IncidentPanel'
import EventsList from './EventsList'
import DebugCommandPanel from './DebugCommandPanel'
import type { Incident } from '../types/electron'
import { parseAcceleratorToIcons, getKeyboardIconDataUrl } from '../utils/keyboardIcons'

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
  const [isHovered, setIsHovered] = useState(false)
  const [hotkey, setHotkey] = useState<string>('Ctrl+Shift+O')
  const [keyboardIcons, setKeyboardIcons] = useState<Map<string, string>>(new Map())
  const hoverDebounceTimer = useRef<NodeJS.Timeout | null>(null)
  const lastHoverState = useRef<boolean>(false)

  // Debounced hover state update
  const updateHoverState = useCallback((hovered: boolean) => {
    // Only send if state changed
    if (hovered === lastHoverState.current) {
      return
    }

    // Clear existing timer
    if (hoverDebounceTimer.current) {
      clearTimeout(hoverDebounceTimer.current)
    }

    // Update local state immediately for UI responsiveness
    setIsHovered(hovered)
    lastHoverState.current = hovered

    // Debounce sending to main process (50ms)
    hoverDebounceTimer.current = setTimeout(() => {
      if (window.electronAPI?.overlay.setInteractiveRegionHovered) {
        window.electronAPI.overlay.setInteractiveRegionHovered(hovered).catch(err => {
          console.error('[OverlayScreen] Failed to set hover state:', err)
        })
      }
    }, 50)
  }, [])

  useEffect(() => {
    // Load initial interactive state
    const loadState = async () => {
      if (window.electronAPI) {
        const interactive = await window.electronAPI.overlay.getInteractive()
        setIsInteractive(interactive)
        
        // Load initial hover state
        try {
          const hovered = await window.electronAPI.overlay.getInteractiveRegionHovered()
          setIsHovered(hovered)
          lastHoverState.current = hovered
        } catch (err) {
          console.error('[OverlayScreen] Failed to get hover state:', err)
        }
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
      
      // Load hotkey setting
      window.electronAPI.settings.getHotkey().then(async (loadedHotkey) => {
        setHotkey(loadedHotkey)
        // Load keyboard icons for the hotkey
        await loadKeyboardIcons(loadedHotkey)
      }).catch(() => {
        // Fallback to default if failed
        const defaultHotkey = 'CommandOrControl+Shift+O'
        setHotkey(defaultHotkey)
        loadKeyboardIcons(defaultHotkey)
      })
    }

    // Cleanup on unmount
    return () => {
      if (hoverDebounceTimer.current) {
        clearTimeout(hoverDebounceTimer.current)
      }
    }
  }, [])

  // Load keyboard icons for a hotkey accelerator
  const loadKeyboardIcons = useCallback(async (accelerator: string) => {
    if (!window.electronAPI?.getKeyboardIcon) {
      return
    }
    
    const iconNames = parseAcceleratorToIcons(accelerator)
    const iconMap = new Map<string, string>()
    
    // Load all icons in parallel
    const iconPromises = iconNames.map(async (iconName) => {
      const dataUrl = await getKeyboardIconDataUrl(iconName)
      if (dataUrl) {
        iconMap.set(iconName, dataUrl)
      }
    })
    
    await Promise.all(iconPromises)
    setKeyboardIcons(iconMap)
  }, [])
  
  // Reload icons when hotkey changes
  useEffect(() => {
    if (hotkey) {
      loadKeyboardIcons(hotkey)
    }
  }, [hotkey, loadKeyboardIcons])

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
      endTick: event.endTick, // Add end tick for events with duration
      meta: event.meta, // Add event metadata (e.g., AFK duration)
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

  // Handle hover for interactive regions
  const handleInteractiveRegionEnter = useCallback(() => {
    updateHoverState(true)
  }, [updateHoverState])

  const handleInteractiveRegionLeave = useCallback(() => {
    updateHoverState(false)
  }, [updateHoverState])

  return (
    <div className="w-full h-full bg-transparent pointer-events-none">
      {/* Events list or Incident panel - only visible when there's an incident, top-left */}
      {incident && (
        <div 
          className={`absolute top-4 left-4 pointer-events-auto z-50 ${isHovered ? 'outline outline-2 outline-blue-500 outline-offset-2 rounded-lg' : ''}`}
          onMouseEnter={handleInteractiveRegionEnter}
          onMouseLeave={handleInteractiveRegionLeave}
        >
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

      {/* Debug command panel - top-right when debug mode is enabled */}
      {debugMode && (
        <div
          className={`absolute top-4 right-4 pointer-events-auto z-40 ${isHovered ? 'outline outline-2 outline-blue-500 outline-offset-2 rounded-lg' : ''}`}
          onMouseEnter={handleInteractiveRegionEnter}
          onMouseLeave={handleInteractiveRegionLeave}
        >
          <DebugCommandPanel enabled={debugMode} />
        </div>
      )}

      {/* Small hotkey indicator - always visible, click-through */}
      <div className="absolute bottom-4 right-4 pointer-events-none z-30">
        <div className="bg-primary/80 backdrop-blur-sm rounded px-3 py-1.5 shadow-lg border border-border/30">
          <div className="flex items-center gap-2">
            <span className="text-white text-xs font-medium text-gray-300">Toggle overlay:</span>
            <div className="flex items-center gap-1">
              {parseAcceleratorToIcons(hotkey).map((iconName, index) => {
                const iconDataUrl = keyboardIcons.get(iconName)
                const iconNames = parseAcceleratorToIcons(hotkey)
                const isModifier = ['keyboard_ctrl', 'keyboard_shift', 'keyboard_alt', 'keyboard_command', 'keyboard_win'].includes(iconName)
                const iconSize = isModifier ? 'h-8 w-8' : 'h-6 w-6'
                return (
                  <span key={`${iconName}-${index}`} className="flex items-center">
                    {iconDataUrl ? (
                      <img
                        src={iconDataUrl}
                        alt={iconName}
                        className={`${iconSize} object-contain`}
                        style={{
                          filter: 'brightness(0) invert(1)',
                          imageRendering: 'crisp-edges'
                        }}
                      />
                    ) : (
                      <span className="text-sm text-white font-mono bg-surface/50 px-1.5 py-0.5 rounded min-w-[24px] text-center">
                        {iconName.replace('keyboard_', '').replace('_outline', '').toUpperCase()}
                      </span>
                    )}
                    {index < iconNames.length - 1 && (
                      <span className="text-gray-400 mx-0.5 text-xs font-medium">+</span>
                    )}
                  </span>
                )
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default OverlayScreen
