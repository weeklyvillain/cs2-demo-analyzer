import { useState, useEffect, useRef, useCallback } from 'react'
import { getMapConfig } from '../utils/mapConfig'
import { getScaledCoordinateX, getScaledCoordinateY, degreesToRadians } from '../utils/coordinateTransform'
import { Info, X } from 'lucide-react'

interface Position {
  tick: number
  steamid: string
  x: number
  y: number
  z: number
  yaw: number | null
  team: string | null
  name: string | null
  health: number | null
  armor: number | null
  weapon: string | null
}

interface Event {
  matchId: string
  roundIndex: number
  type: string
  startTick: number
  endTick: number | null
  actorSteamId: string | null
  victimSteamId: string | null
  severity: number
  confidence: number
  meta: any
}

interface Round {
  roundIndex: number
  startTick: number
  endTick: number
  freezeEndTick: number | null
  tWins?: number
  ctWins?: number
  winner?: string | null
}

interface Viewer2DProps {
  matchId: string
  roundIndex: number // -1 means full game (all rounds)
  initialTick: number
  roundStartTick: number
  roundEndTick: number
  mapName: string
  onClose: () => void
  isFullGame?: boolean // If true, show all rounds
  allRounds?: Round[] // All rounds for full game mode
}

// Position data organized by tick and player
type PositionMap = Map<number, Map<string, Position>> // tick -> steamid -> position

function Viewer2D({ matchId, roundIndex, initialTick, roundStartTick, roundEndTick, mapName, onClose, isFullGame = false, allRounds = [] }: Viewer2DProps) {
  const [allPositions, setAllPositions] = useState<PositionMap>(new Map())
  const [events, setEvents] = useState<Event[]>([])
  const [currentTick, setCurrentTick] = useState(initialTick)
  const [loading, setLoading] = useState(true)
  const [isPlaying, setIsPlaying] = useState(false)
  const [playbackSpeed, setPlaybackSpeed] = useState(1) // 1x, 2x, 4x speed
  const [mapImage, setMapImage] = useState<HTMLImageElement | null>(null)
  const [playerTImage, setPlayerTImage] = useState<HTMLImageElement | null>(null)
  const [playerCTImage, setPlayerCTImage] = useState<HTMLImageElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const playbackIntervalRef = useRef<number | null>(null)
  const animationFrameRef = useRef<number | null>(null)
  const lastRenderTimeRef = useRef<number>(0)
  const [loadedRounds, setLoadedRounds] = useState<Set<number>>(new Set())
  const [loadingRounds, setLoadingRounds] = useState<Set<number>>(new Set())
  // Use refs to track loaded/loading rounds to avoid dependency issues
  const loadedRoundsRef = useRef<Set<number>>(new Set())
  const loadingRoundsRef = useRef<Set<number>>(new Set())
  
  // Zoom and pan state
  const [zoom, setZoom] = useState(1) // 1 = 100%
  const [panX, setPanX] = useState(0) // Pan offset in pixels
  const [panY, setPanY] = useState(0) // Pan offset in pixels
  const [isDragging, setIsDragging] = useState(false)
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 })
  const [dragStartPan, setDragStartPan] = useState({ x: 0, y: 0 })
  
  // Follow player state
  const [followPlayer, setFollowPlayer] = useState<string | null>(null) // steamid of player to follow

  // Load radar image (for 2D viewer) via IPC to avoid CORS issues
  useEffect(() => {
    const loadMapImage = async () => {
      if (!mapName || !window.electronAPI) return
      
      // Normalize map name: de_cache_b -> de_cache
      let normalizedMapName = mapName.toLowerCase()
      if (normalizedMapName === 'de_cache_b') {
        normalizedMapName = 'de_cache'
      }
      
      try {
        const result = await window.electronAPI.getRadarImage(normalizedMapName)
        if (result.success && result.data) {
          const img = new Image()
          img.onload = () => {
            console.log(`Successfully loaded radar image for ${normalizedMapName}`)
            setMapImage(img)
          }
          img.onerror = (e) => {
            console.error(`Failed to load radar image data URL for ${normalizedMapName}`, e)
            setMapImage(null)
          }
          img.src = result.data
        } else {
          console.error(`Failed to get radar image for ${normalizedMapName}:`, result.error)
          setMapImage(null)
        }
      } catch (error) {
        console.error(`Error loading radar image for ${normalizedMapName}:`, error)
        setMapImage(null)
      }
    }

    loadMapImage()
  }, [mapName])

  // Load player images (for 2D viewer) via IPC to avoid CORS issues
  useEffect(() => {
    const loadPlayerImages = async () => {
      if (!window.electronAPI) return
      
      try {
        // Load T player image
        const tResult = await window.electronAPI.getPlayerImage('T')
        if (tResult.success && tResult.data) {
          const tImg = new Image()
          tImg.onload = () => {
            console.log('Successfully loaded T player image')
            setPlayerTImage(tImg)
          }
          tImg.onerror = (e) => {
            console.error('Failed to load T player image data URL', e)
            setPlayerTImage(null)
          }
          tImg.src = tResult.data
        } else {
          console.error('Failed to get T player image:', tResult.error)
          setPlayerTImage(null)
        }

        // Load CT player image
        const ctResult = await window.electronAPI.getPlayerImage('CT')
        if (ctResult.success && ctResult.data) {
          const ctImg = new Image()
          ctImg.onload = () => {
            console.log('Successfully loaded CT player image')
            setPlayerCTImage(ctImg)
          }
          ctImg.onerror = (e) => {
            console.error('Failed to load CT player image data URL', e)
            setPlayerCTImage(null)
          }
          ctImg.src = ctResult.data
        } else {
          console.error('Failed to get CT player image:', ctResult.error)
          setPlayerCTImage(null)
        }
      } catch (error) {
        console.error('Error loading player images:', error)
        setPlayerTImage(null)
        setPlayerCTImage(null)
      }
    }

    loadPlayerImages()
  }, [])

  // Grenade data
  const [shots, setShots] = useState<Array<{
    tick: number
    steamId: string
    weaponName: string
    x: number
    y: number
    z: number
    yaw: number
    pitch: number | null
    team: string | null
  }>>([])

  const [grenadePositions, setGrenadePositions] = useState<Array<{
    tick: number
    projectileId: number
    grenadeName: string
    x: number
    y: number
    z: number
    throwerSteamId: string | null
    throwerName: string | null
    throwerTeam: string | null
  }>>([])
  const [grenadeEvents, setGrenadeEvents] = useState<Array<{
    tick: number
    eventType: string
    projectileId: number
    grenadeName: string
    x: number
    y: number
    z: number
    throwerSteamId: string | null
    throwerName: string | null
    throwerTeam: string | null
  }>>([])

  // Lazy load positions for a specific round
  const loadRoundData = useCallback(async (roundIdx: number) => {
    if (!window.electronAPI || loadedRoundsRef.current.has(roundIdx) || loadingRoundsRef.current.has(roundIdx)) {
      return
    }

    loadingRoundsRef.current.add(roundIdx)
    setLoadingRounds(prev => new Set(prev).add(roundIdx))
    
    try {
      const [positionsData, eventsData, grenadePosData, grenadeEventsData, shotsData] = await Promise.all([
        window.electronAPI.getMatchPositionsForRound(matchId, roundIdx),
        window.electronAPI.getMatchEvents(matchId, { round: roundIdx }),
        window.electronAPI.getGrenadePositionsForRound(matchId, roundIdx),
        window.electronAPI.getGrenadeEventsForRound(matchId, roundIdx),
        window.electronAPI.getShotsForRound(matchId, roundIdx),
      ])
      
      // Merge into existing position map
      setAllPositions(prev => {
        const newMap = new Map(prev)
        for (const pos of positionsData.positions) {
          if (!newMap.has(pos.tick)) {
            newMap.set(pos.tick, new Map())
          }
          const tickMap = newMap.get(pos.tick)!
          tickMap.set(pos.steamid, pos)
        }
        return newMap
      })
      
      // Merge events
      setEvents(prev => [...prev, ...(eventsData.events || [])])
      setGrenadePositions(prev => [...prev, ...(grenadePosData.positions || [])])
      setGrenadeEvents(prev => [...prev, ...(grenadeEventsData.events || [])])
      setShots(prev => [...prev, ...(shotsData.shots || [])])
      
      loadedRoundsRef.current.add(roundIdx)
      setLoadedRounds(prev => new Set(prev).add(roundIdx))
    } catch (err) {
      console.error(`Failed to load round ${roundIdx}:`, err)
    } finally {
      loadingRoundsRef.current.delete(roundIdx)
      setLoadingRounds(prev => {
        const newSet = new Set(prev)
        newSet.delete(roundIdx)
        return newSet
      })
    }
  }, [matchId])

  // Load initial rounds (current, previous, next) and handle lazy loading
  useEffect(() => {
    const loadInitialData = async () => {
      if (!window.electronAPI) return

      setLoading(true)
      try {
        if (isFullGame && allRounds.length > 0) {
          // Find current round based on initialTick
          const currentRound = allRounds.find(r => initialTick >= r.startTick && initialTick <= r.endTick) || allRounds[0]
          const currentRoundIdx = allRounds.indexOf(currentRound)
          
          // Load current round and adjacent rounds
          const roundsToLoad: number[] = []
          if (currentRoundIdx >= 0) {
            roundsToLoad.push(currentRound.roundIndex)
            if (currentRoundIdx > 0) {
              roundsToLoad.push(allRounds[currentRoundIdx - 1].roundIndex)
            }
            if (currentRoundIdx < allRounds.length - 1) {
              roundsToLoad.push(allRounds[currentRoundIdx + 1].roundIndex)
            }
          }
          
          // Load rounds in parallel
          await Promise.all(roundsToLoad.map(roundIdx => loadRoundData(roundIdx)))
        } else {
          // Single round mode - load just this round
          await loadRoundData(roundIndex)
        }
      } catch (err) {
        console.error('Failed to load initial data:', err)
      } finally {
        setLoading(false)
      }
    }

    loadInitialData()
  }, [matchId, roundIndex, isFullGame, allRounds, initialTick, loadRoundData])

  // Track previous round to detect round changes
  const previousRoundRef = useRef<number | null>(null)
  
  // Lazy load adjacent rounds when current tick changes or round changes
  useEffect(() => {
    if (!isFullGame || allRounds.length === 0) return

    const currentRound = allRounds.find(r => currentTick >= r.startTick && currentTick <= r.endTick)
    if (!currentRound) return

    const currentRoundIdx = allRounds.indexOf(currentRound)
    const currentRoundIndex = currentRound.roundIndex
    
    // Check if we've changed rounds
    const roundChanged = previousRoundRef.current !== currentRoundIndex
    previousRoundRef.current = currentRoundIndex
    
    // Always ensure current round is loaded
    if (!loadedRoundsRef.current.has(currentRoundIndex) && !loadingRoundsRef.current.has(currentRoundIndex)) {
      loadRoundData(currentRoundIndex)
    }
    
    const roundsToLoad: number[] = []
    
    // Load previous round if exists and not loaded
    if (currentRoundIdx > 0) {
      const prevRound = allRounds[currentRoundIdx - 1]
      if (!loadedRoundsRef.current.has(prevRound.roundIndex) && !loadingRoundsRef.current.has(prevRound.roundIndex)) {
        roundsToLoad.push(prevRound.roundIndex)
      }
    }
    
    // Load next round if exists and not loaded
    if (currentRoundIdx < allRounds.length - 1) {
      const nextRound = allRounds[currentRoundIdx + 1]
      if (!loadedRoundsRef.current.has(nextRound.roundIndex) && !loadingRoundsRef.current.has(nextRound.roundIndex)) {
        roundsToLoad.push(nextRound.roundIndex)
      }
    }
    
    // Unload rounds that are more than 1 away (keep memory usage low)
    const roundsToUnload: number[] = []
    for (const round of allRounds) {
      const roundIdx = allRounds.indexOf(round)
      const distance = Math.abs(roundIdx - currentRoundIdx)
      if (distance > 1 && loadedRoundsRef.current.has(round.roundIndex)) {
        roundsToUnload.push(round.roundIndex)
      }
    }
    
    // Load new rounds
    if (roundsToLoad.length > 0) {
      Promise.all(roundsToLoad.map(roundIdx => loadRoundData(roundIdx)))
    }
    
    // Unload distant rounds (remove positions from those rounds)
    if (roundsToUnload.length > 0) {
      setAllPositions(prev => {
        const newMap = new Map()
        // Only keep positions from loaded rounds (excluding unloaded ones)
        const keepRounds = new Set(Array.from(loadedRoundsRef.current).filter(r => !roundsToUnload.includes(r)))
        for (const [tick, players] of prev.entries()) {
          // Check if this tick belongs to a round we want to keep
          const belongsToRound = allRounds.some(r => 
            keepRounds.has(r.roundIndex) && tick >= r.startTick && tick <= r.endTick
          )
          if (belongsToRound) {
            newMap.set(tick, players)
          }
        }
        return newMap
      })
      // Update refs first
      roundsToUnload.forEach(r => {
        loadedRoundsRef.current.delete(r)
      })
      // Then update state for UI (but this won't trigger the effect since it's not in deps)
      setLoadedRounds(prev => {
        const newSet = new Set(prev)
        roundsToUnload.forEach(r => newSet.delete(r))
        return newSet
      })
    }
  }, [currentTick, isFullGame, allRounds, loadRoundData])

  // Interpolate position for a player at a specific tick
  const getInterpolatedPosition = useCallback((steamid: string, tick: number): Position | null => {
    // Handle round transitions: if tick is at or past a round's end, instantly jump to next round's spawn
    // Also handle freeze period: during freeze, use exact spawn positions (no interpolation)
    let actualTick = tick
    let isRoundTransition = false
    let isInFreezePeriod = false
    
    if (isFullGame && allRounds.length > 0) {
      // Find the round that contains this tick
      let currentRound = allRounds.find(r => tick >= r.startTick && tick <= r.endTick)
      
      // If tick is at or past the current round's end, find the next round
      if (!currentRound) {
        // Find the round that just ended (tick is past its end)
        const endedRound = allRounds.find(r => tick > r.endTick)
        if (endedRound) {
          const endedRoundIdx = allRounds.indexOf(endedRound)
          // Get the next round
          if (endedRoundIdx < allRounds.length - 1) {
            const nextRound = allRounds[endedRoundIdx + 1]
            // During freeze period, use the spawn position (freezeEndTick or startTick)
            // After freeze, use the actual tick
            const freezeEnd = nextRound.freezeEndTick || nextRound.startTick
            if (tick < freezeEnd) {
              // Still in freeze - use spawn position
              actualTick = nextRound.startTick
              isRoundTransition = true
              isInFreezePeriod = true
            } else {
              // Freeze ended, use actual tick
              actualTick = tick
            }
          } else {
            // Last round ended, use its end tick
            actualTick = endedRound.endTick
          }
        } else {
          // Before first round, use first round's start
          const firstRound = allRounds[0]
          const freezeEnd = firstRound.freezeEndTick || firstRound.startTick
          if (tick < freezeEnd) {
            // Still in freeze - use spawn position
            actualTick = firstRound.startTick
            isRoundTransition = true
            isInFreezePeriod = true
          } else {
            actualTick = tick
          }
        }
      } else {
        // We're within a round
        // Check if we're in the freeze period
        const freezeEnd = currentRound.freezeEndTick || currentRound.startTick
        if (tick < freezeEnd) {
          // In freeze period - use exact spawn position (no interpolation)
          actualTick = currentRound.startTick
          isRoundTransition = true
          isInFreezePeriod = true
        } else if (tick >= currentRound.endTick) {
          // At round end - use the end tick position (no interpolation)
          actualTick = currentRound.endTick
          isRoundTransition = true
        }
      }
    } else if (!isFullGame) {
      // Single round mode - check if we're at round end or in freeze
      // Note: we don't have freezeEndTick in single round mode, so we'll use roundStartTick
      if (tick >= roundEndTick) {
        actualTick = roundEndTick
        isRoundTransition = true
      } else if (tick <= roundStartTick) {
        // At or before round start - use start position
        actualTick = roundStartTick
        isRoundTransition = true
        isInFreezePeriod = true
      }
    }
    
    // Find the two closest position samples
    // Optimize: single pass through ticks
    let lowerTick = -1
    let upperTick = -1
    
    for (const storedTick of allPositions.keys()) {
      if (storedTick <= actualTick && storedTick > lowerTick) {
        lowerTick = storedTick
      }
      if (storedTick >= actualTick && (upperTick === -1 || storedTick < upperTick)) {
        upperTick = storedTick
      }
    }
    
    if (lowerTick === -1 && upperTick === -1) {
      return null
    }
    
    // If we have exact match, return it
    if (lowerTick === actualTick && allPositions.has(actualTick)) {
      const tickMap = allPositions.get(actualTick)!
      return tickMap.get(steamid) || null
    }
    
    // Get positions at lower and upper ticks
    const lowerPos = lowerTick !== -1 && allPositions.has(lowerTick)
      ? allPositions.get(lowerTick)!.get(steamid)
      : null
    const upperPos = upperTick !== -1 && allPositions.has(upperTick)
      ? allPositions.get(upperTick)!.get(steamid)
      : null
    
    // If we only have one position, return it
    if (lowerPos && !upperPos) return lowerPos
    if (upperPos && !lowerPos) return upperPos
    if (!lowerPos && !upperPos) return null
    
    // For round transitions and freeze periods, don't interpolate - use the exact position
    // If at round end, use the end position. If transitioning to next round or in freeze, use exact spawn position
    if (isRoundTransition || isInFreezePeriod) {
      // During freeze or round transition, use exact position at actualTick
      // First try to get exact match at actualTick
      if (allPositions.has(actualTick)) {
        const tickMap = allPositions.get(actualTick)!
        const exactPos = tickMap.get(steamid)
        if (exactPos) {
          return exactPos
        }
      }
      // If no exact match, prefer upperPos (next round's start) if available, otherwise use lowerPos
      if (upperPos) {
        return upperPos
      }
      if (lowerPos) {
        return lowerPos
      }
      return null
    }
    
    // Interpolate between lower and upper positions
    const tickDiff = upperTick - lowerTick
    if (tickDiff === 0) return lowerPos
    
    const t = (actualTick - lowerTick) / tickDiff
    const x = lowerPos!.x + (upperPos!.x - lowerPos!.x) * t
    const y = lowerPos!.y + (upperPos!.y - lowerPos!.y) * t
    const z = lowerPos!.z + (upperPos!.z - lowerPos!.z) * t
    
    // For health, armor, weapon, yaw - use the closest value (don't interpolate)
    // Prefer the value from the tick closest to the target
    const useLower = Math.abs(lowerTick - actualTick) < Math.abs(upperTick - actualTick)
    const health = useLower ? lowerPos!.health : upperPos!.health
    const armor = useLower ? lowerPos!.armor : upperPos!.armor
    const weapon = useLower ? lowerPos!.weapon : upperPos!.weapon
    const yaw = useLower ? lowerPos!.yaw : upperPos!.yaw
    
    return {
      tick: actualTick,
      steamid,
      x,
      y,
      z,
      yaw,
      team: lowerPos!.team || upperPos!.team,
      name: lowerPos!.name || upperPos!.name,
      health,
      armor,
      weapon,
    }
  }, [allPositions, isFullGame, allRounds, roundEndTick])

  // Get all player positions at current tick (interpolated)
  const getCurrentPositions = useCallback((): Position[] => {
    const positions: Position[] = []
    const seenPlayers = new Set<string>()
    
    // Collect all unique players from all ticks
    for (const tickMap of allPositions.values()) {
      for (const steamid of tickMap.keys()) {
        if (!seenPlayers.has(steamid)) {
          seenPlayers.add(steamid)
          const pos = getInterpolatedPosition(steamid, currentTick)
          if (pos) {
            positions.push(pos)
          }
        }
      }
    }
    
    return positions
  }, [allPositions, currentTick, getInterpolatedPosition, isFullGame, allRounds])

  // Draw positions on canvas with smooth animation
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

      const render = () => {
      // Clear canvas
      ctx.clearRect(0, 0, canvas.width, canvas.height)

      // Helper function to get zoomed size (like CS Demo Analyzer's zoomedSize)
      // Must be defined early as it's used throughout the render function
      const zoomedSize = (size: number) => {
        const mapTransform = (ctx as any).mapTransform
        if (mapTransform && mapImage && mapImage.complete) {
          // Scale based on the map's draw size and zoom level
          const baseScale = mapTransform.drawWidth / mapTransform.radarSize
          return size * baseScale
        }
        return size
      }

      const positions = getCurrentPositions()

      if (positions.length === 0) {
        ctx.fillStyle = '#666'
        ctx.font = '16px Arial'
        ctx.textAlign = 'center'
        ctx.fillText('No position data available', canvas.width / 2, canvas.height / 2)
        // Always continue rendering to pick up zoom/pan changes
        animationFrameRef.current = requestAnimationFrame(render)
        return
      }

      // Get map configuration for coordinate transformation
      const mapConfig = getMapConfig(mapName)
      
      // Declare draw area variables outside the if block so they're accessible everywhere
      let drawWidth = canvas.width
      let drawHeight = canvas.height
      let drawX = 0
      let drawY = 0
      
      // Draw map image as background if available
      // Following CS Demo Analyzer's approach: draw radar at a specific size and position
      // Always maintain 1:1 aspect ratio for the map
      if (mapImage && mapImage.complete && mapConfig) {
        // Radar images are square, use radarWidth as the size
        const radarSize = mapConfig.radarWidth || 1024
        
        // Calculate the square size that fits within the canvas (1:1 aspect ratio)
        const maxSize = Math.min(canvas.width, canvas.height)
        
        // Base size without zoom
        const baseSize = maxSize
        
        // Apply zoom
        const zoomedSize = baseSize * zoom
        
        // Center the map in the canvas
        const centerX = canvas.width / 2
        const centerY = canvas.height / 2
        
        // Calculate draw position with pan offset
        drawWidth = zoomedSize
        drawHeight = zoomedSize
        drawX = centerX - zoomedSize / 2 + panX
        drawY = centerY - zoomedSize / 2 + panY
        
        // Draw the radar image
        ctx.drawImage(mapImage, drawX, drawY, drawWidth, drawHeight)
        
        // Store transformation parameters for later use
        ;(ctx as any).mapTransform = {
          mapConfig,
          drawX,
          drawY,
          drawWidth,
          drawHeight,
          radarSize,
          zoom,
          panX,
          panY
        }
      } else {
        // Fallback: calculate bounds from positions if no map config
        let minX = Infinity
        let maxX = -Infinity
        let minY = Infinity
        let maxY = -Infinity

        for (const pos of positions) {
          minX = Math.min(minX, pos.x)
          maxX = Math.max(maxX, pos.x)
          minY = Math.min(minY, pos.y)
          maxY = Math.max(maxY, pos.y)
        }

        // Add padding
        const padding = 500
        minX -= padding
        maxX += padding
        minY -= padding
        maxY += padding

        const gameWidth = maxX - minX
        const gameHeight = maxY - minY
        
        // Calculate scale to fit canvas (original behavior)
        const scaleX = canvas.width / gameWidth
        const scaleY = canvas.height / gameHeight
        const scale = Math.min(scaleX, scaleY)
        
        const offsetX = (canvas.width - gameWidth * scale) / 2
        const offsetY = (canvas.height - gameHeight * scale) / 2
        
        ;(ctx as any).gameToScreen = { scale, offsetX, offsetY, flipY: false }
        
        // Draw grid (optional, for reference)
        ctx.strokeStyle = '#333'
        ctx.lineWidth = 1
        const gridSize = 1000
        for (let x = Math.floor(minX / gridSize) * gridSize; x <= maxX; x += gridSize) {
          const screenX = offsetX + (x - minX) * scale
          ctx.beginPath()
          ctx.moveTo(screenX, 0)
          ctx.lineTo(screenX, canvas.height)
          ctx.stroke()
        }
        for (let y = Math.floor(minY / gridSize) * gridSize; y <= maxY; y += gridSize) {
          const screenY = offsetY + (y - minY) * scale
          ctx.beginPath()
          ctx.moveTo(0, screenY)
          ctx.lineTo(canvas.width, screenY)
          ctx.stroke()
        }
      }
      
      // Get transformation parameters
      const { scale, offsetX, offsetY, flipY } = (ctx as any).gameToScreen || { scale: 1, offsetX: 0, offsetY: 0, flipY: false }

      // Draw events that are visible at current tick (within a small window)
      const eventWindow = 64 // Show events within ±1 second
      for (const event of events) {
        if (event.startTick >= currentTick - eventWindow && event.startTick <= currentTick + eventWindow) {
          // Find event position (use actor or victim position)
          let eventX = 0
          let eventY = 0
          let found = false
          
          if (event.actorSteamId) {
            const actorPos = getInterpolatedPosition(event.actorSteamId, event.startTick)
            if (actorPos) {
              eventX = actorPos.x
              eventY = actorPos.y
              found = true
            }
          }
          
          if (!found && event.victimSteamId) {
            const victimPos = getInterpolatedPosition(event.victimSteamId, event.startTick)
            if (victimPos) {
              eventX = victimPos.x
              eventY = victimPos.y
              found = true
            }
          }
          
          if (found) {
            // Transform event coordinates using the same method as players
            let screenX: number
            let screenY: number
            
        const mapTransform = (ctx as any).mapTransform
        if (mapTransform && mapImage && mapImage.complete) {
          // Use CS Demo Analyzer coordinate transformation
          // Step 1: Convert game coordinates to radar pixel coordinates
          const radarX = getScaledCoordinateX(mapTransform.mapConfig, mapTransform.radarSize, eventX)
          const radarY = getScaledCoordinateY(mapTransform.mapConfig, mapTransform.radarSize, eventY)
          
          // Step 2: Scale radar pixels to canvas pixels
          const scaleX = mapTransform.drawWidth / mapTransform.radarSize
          const scaleY = mapTransform.drawHeight / mapTransform.radarSize
          
          screenX = mapTransform.drawX + radarX * scaleX
          screenY = mapTransform.drawY + radarY * scaleY
        } else {
          // Fallback transformation
          screenX = offsetX + eventX * scale
          screenY = flipY ? offsetY - eventY * scale : offsetY + eventY * scale
        }
            
            // Draw event icon based on type
            ctx.beginPath()
            if (event.type === 'team_kill') {
              ctx.fillStyle = '#ff0000'
              ctx.arc(screenX, screenY, 6, 0, Math.PI * 2)
              ctx.fill()
            } else if (event.type === 'team_damage') {
              ctx.fillStyle = '#ff8800'
              ctx.arc(screenX, screenY, 5, 0, Math.PI * 2)
              ctx.fill()
            } else if (event.type === 'team_flash') {
              ctx.fillStyle = '#ffff00'
              ctx.arc(screenX, screenY, 5, 0, Math.PI * 2)
              ctx.fill()
            } else {
              ctx.fillStyle = '#00ff00'
              ctx.arc(screenX, screenY, 4, 0, Math.PI * 2)
              ctx.fill()
            }
          }
        }
      }

      // Draw players
      for (const pos of positions) {
        // Transform game coordinates to screen coordinates using CS Demo Analyzer formula
        // This is a two-step process:
        // Step 1: Game coordinates -> Radar pixel coordinates
        // Step 2: Radar pixel coordinates -> Canvas pixel coordinates
        
        let screenX: number
        let screenY: number
        
        const mapTransform = (ctx as any).mapTransform
        if (mapTransform && mapImage && mapImage.complete) {
          // Use CS Demo Analyzer coordinate transformation
          // Step 1: Convert game coordinates to radar pixel coordinates
          const radarX = getScaledCoordinateX(mapTransform.mapConfig, mapTransform.radarSize, pos.x)
          const radarY = getScaledCoordinateY(mapTransform.mapConfig, mapTransform.radarSize, pos.y)
          
          // Step 2: Scale radar pixels to canvas pixels
          const scaleX = mapTransform.drawWidth / mapTransform.radarSize
          const scaleY = mapTransform.drawHeight / mapTransform.radarSize
          
          screenX = mapTransform.drawX + radarX * scaleX
          screenY = mapTransform.drawY + radarY * scaleY
        } else {
          // Fallback transformation
          screenX = offsetX + pos.x * scale
          screenY = flipY ? offsetY - pos.y * scale : offsetY + pos.y * scale
        }
        
        // Debug: verify transformation is correct
        if (positions.indexOf(pos) === 0 && !(ctx as any).playerTransformVerified) {
          console.log('Player transform verification:', {
            gamePos: { x: pos.x, y: pos.y },
            calculatedScreenPos: { x: screenX, y: screenY },
            transformParams: { offsetX, offsetY, scale, flipY },
            expectedScreenX: offsetX + pos.x * scale,
            expectedScreenY: flipY ? offsetY - pos.y * scale : offsetY + pos.y * scale,
            canvasBounds: { width: canvas.width, height: canvas.height },
            isWithinBounds: screenX >= 0 && screenX <= canvas.width && screenY >= 0 && screenY <= canvas.height
          })
          ;(ctx as any).playerTransformVerified = true
        }
        
        // Debug: log first player's transformation (only once per render)
        if (positions.indexOf(pos) === 0 && !(ctx as any).playerDebugLogged) {
          console.log('Player transformation:', {
            gamePos: { x: pos.x, y: pos.y },
            screenPos: { x: screenX, y: screenY },
            scale,
            offsetX,
            offsetY,
            flipY,
            canvasSize: { width: canvas.width, height: canvas.height },
            mapConfig: mapConfig ? { name: mapConfig.name, posX: mapConfig.posX, posY: mapConfig.posY, scale: mapConfig.scale } : null,
            isVisible: screenX >= 0 && screenX <= canvas.width && screenY >= 0 && screenY <= canvas.height
          })
          ;(ctx as any).playerDebugLogged = true
        }
        
        // Always draw players for debugging - we'll see where they end up
        // If they're way off screen, we'll see them in the debug logs

        // Check if player is dead
        // Don't mark as dead if we're at the start of a round (within freeze time or just after)
        let isDead = pos.health === null || pos.health <= 0
        if (isDead && isFullGame && allRounds.length > 0) {
          const currentRound = allRounds.find(r => currentTick >= r.startTick && currentTick <= r.endTick)
          if (currentRound) {
            // If we're at the start of the round (before or just after freeze ends), don't mark as dead
            // Players might be spawning
            const freezeEnd = currentRound.freezeEndTick || currentRound.startTick
            const ticksAfterFreeze = currentTick - freezeEnd
            // Within 5 seconds (320 ticks) of freeze end, don't mark as dead
            if (ticksAfterFreeze < 320) {
              isDead = false
            }
          } else {
            // Between rounds - check if we're at the start of the next round
            const nextRound = allRounds.find(r => currentTick < r.startTick)
            if (nextRound) {
              const freezeEnd = nextRound.freezeEndTick || nextRound.startTick
              const ticksBeforeFreeze = freezeEnd - currentTick
              // Within 5 seconds (320 ticks) of next round start, don't mark as dead
              if (ticksBeforeFreeze < 320) {
                isDead = false
              }
            }
          }
        }
        
        if (isDead) {
          // Draw skull emoji for dead players
          ctx.font = '24px Arial'
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText('💀', screenX, screenY)
        } else {
          // Draw player image or fallback to circle
          const playerImage = pos.team === 'T' ? playerTImage : pos.team === 'CT' ? playerCTImage : null
          const playerRadius = 8 // Used for positioning and fallback
          
          if (playerImage && playerImage.complete) {
            // Draw player image rotated based on yaw
            ctx.save()
            ctx.translate(screenX, screenY)
            
            // Rotate based on yaw (if available)
            if (pos.yaw !== null && pos.yaw !== undefined) {
              const playerAngle = -degreesToRadians(pos.yaw)
              ctx.rotate(playerAngle)
            }
            
            // Draw the image centered
            const imageSize = zoomedSize(16) // Size of the player image
            ctx.drawImage(playerImage, -imageSize / 2, -imageSize / 2, imageSize, imageSize)
            
            ctx.restore()
            
            // Draw health indicator if health is low (matching CS Demo Analyzer)
            if (pos.health !== null && pos.health < 100) {
              ctx.beginPath()
              ctx.fillStyle = '#d7373f99'
              const percentage = pos.health / 100
              const startAngle = -Math.PI / 2
              const endAngle = startAngle + Math.PI * 2 * -percentage // Negative percentage like CS Demo Analyzer
              ctx.arc(screenX, screenY, zoomedSize(7), startAngle, endAngle)
              ctx.lineTo(screenX, screenY)
              ctx.fill()
            }
            
            // Draw view direction indicator for weapons/grenades - matching CS Demo Analyzer exactly
            // CS Demo Analyzer uses: -degreesToRadians(position.yaw)
            if (pos.yaw !== null && pos.yaw !== undefined) {
              const playerAngle = -degreesToRadians(pos.yaw)
              const isHoldingKnife = pos.weapon?.toLowerCase().includes('knife') || false
              const weaponLower = pos.weapon?.toLowerCase() || ''
              const isHoldingGrenade = 
                weaponLower.includes('hegrenade') || weaponLower.includes('he_grenade') ||
                weaponLower.includes('smokegrenade') || weaponLower.includes('smoke_grenade') ||
                weaponLower.includes('flashbang') ||
                weaponLower.includes('incendiary') || weaponLower.includes('molotov') ||
                weaponLower.includes('decoy')
              
              if (isHoldingKnife || isHoldingGrenade) {
                // Draw triangle for knife/grenade holders (matching CS Demo Analyzer)
                const triangleLength1 = 4
                const triangleLength2 = 4
                const x0 = screenX + (playerRadius + triangleLength1) * Math.cos(playerAngle)
                const y0 = screenY + (playerRadius + triangleLength1) * Math.sin(playerAngle)
                const outerX = screenX + playerRadius * Math.cos(playerAngle)
                const outerY = screenY + playerRadius * Math.sin(playerAngle)
                const x1 = outerX + triangleLength2 * Math.cos(playerAngle - Math.PI / 2)
                const y1 = outerY + triangleLength2 * Math.sin(playerAngle - Math.PI / 2)
                const x2 = outerX + triangleLength2 * Math.cos(playerAngle + Math.PI / 2)
                const y2 = outerY + triangleLength2 * Math.sin(playerAngle + Math.PI / 2)
                ctx.beginPath()
                ctx.moveTo(x0, y0)
                ctx.lineTo(x1, y1)
                ctx.lineTo(x2, y2)
                ctx.fill()
                
                // Draw grenade indicator if holding grenade
                if (isHoldingGrenade) {
                  let grenadeColor: string | null = null
                  if (weaponLower.includes('hegrenade') || weaponLower.includes('he_grenade')) {
                    grenadeColor = '#268e6c'
                  } else if (weaponLower.includes('smokegrenade') || weaponLower.includes('smoke_grenade')) {
                    grenadeColor = '#737373'
                  } else if (weaponLower.includes('flashbang')) {
                    grenadeColor = '#f9a43f'
                  } else if (weaponLower.includes('incendiary') || weaponLower.includes('molotov')) {
                    grenadeColor = '#da7b11'
                  } else if (weaponLower.includes('decoy')) {
                    grenadeColor = '#f76d74'
                  }
                  
                  if (grenadeColor) {
                    const grenadeRadius = 3
                    ctx.beginPath()
                    ctx.fillStyle = grenadeColor
                    ctx.arc(screenX, screenY - playerRadius, grenadeRadius, 0, 2 * Math.PI)
                    ctx.fill()
                  }
                }
              } else {
                // Draw line for normal weapons (matching CS Demo Analyzer)
                ctx.beginPath()
                ctx.lineWidth = 2
                const lineLength = 8 + 2
                ctx.moveTo(screenX, screenY)
                ctx.lineTo(screenX + lineLength * Math.cos(playerAngle), screenY + lineLength * Math.sin(playerAngle))
                ctx.strokeStyle = 'white'
                ctx.stroke()
              }
            }
          } else {
            // Fallback to circle if image not loaded
            ctx.beginPath()
            ctx.arc(screenX, screenY, playerRadius, 0, 2 * Math.PI)
            
            // Team colors
            if (pos.team === 'T') {
              ctx.fillStyle = '#ff6b35' // Orange for T
            } else if (pos.team === 'CT') {
              ctx.fillStyle = '#4a90e2' // Blue for CT
            } else {
              ctx.fillStyle = '#888' // Gray for unknown
            }
            ctx.fill()
            
            // Border - white like CS Demo Analyzer
            ctx.strokeStyle = '#ffffff'
            ctx.lineWidth = 2
            ctx.stroke()
            
            // Draw health indicator if health is low (matching CS Demo Analyzer)
            if (pos.health !== null && pos.health < 100) {
              ctx.beginPath()
              ctx.fillStyle = '#d7373f99'
              const percentage = pos.health / 100
              const startAngle = -Math.PI / 2
              const endAngle = startAngle + Math.PI * 2 * -percentage // Negative percentage like CS Demo Analyzer
              ctx.arc(screenX, screenY, 7, startAngle, endAngle)
              ctx.lineTo(screenX, screenY)
              ctx.fill()
            }
            
            // Draw view direction - matching CS Demo Analyzer exactly
            // CS Demo Analyzer uses: -degreesToRadians(position.yaw)
            if (pos.yaw !== null && pos.yaw !== undefined) {
              const playerAngle = -degreesToRadians(pos.yaw)
              const isHoldingKnife = pos.weapon?.toLowerCase().includes('knife') || false
              const weaponLower = pos.weapon?.toLowerCase() || ''
              const isHoldingGrenade = 
                weaponLower.includes('hegrenade') || weaponLower.includes('he_grenade') ||
                weaponLower.includes('smokegrenade') || weaponLower.includes('smoke_grenade') ||
                weaponLower.includes('flashbang') ||
                weaponLower.includes('incendiary') || weaponLower.includes('molotov') ||
                weaponLower.includes('decoy')
              
              if (isHoldingKnife || isHoldingGrenade) {
                // Draw triangle for knife/grenade holders (matching CS Demo Analyzer)
                const triangleLength1 = 4
                const triangleLength2 = 4
                const x0 = screenX + (playerRadius + triangleLength1) * Math.cos(playerAngle)
                const y0 = screenY + (playerRadius + triangleLength1) * Math.sin(playerAngle)
                const outerX = screenX + playerRadius * Math.cos(playerAngle)
                const outerY = screenY + playerRadius * Math.sin(playerAngle)
                const x1 = outerX + triangleLength2 * Math.cos(playerAngle - Math.PI / 2)
                const y1 = outerY + triangleLength2 * Math.sin(playerAngle - Math.PI / 2)
                const x2 = outerX + triangleLength2 * Math.cos(playerAngle + Math.PI / 2)
                const y2 = outerY + triangleLength2 * Math.sin(playerAngle + Math.PI / 2)
                ctx.beginPath()
                ctx.moveTo(x0, y0)
                ctx.lineTo(x1, y1)
                ctx.lineTo(x2, y2)
                ctx.fill()
                
                // Draw grenade indicator if holding grenade
                if (isHoldingGrenade) {
                  let grenadeColor: string | null = null
                  if (weaponLower.includes('hegrenade') || weaponLower.includes('he_grenade')) {
                    grenadeColor = '#268e6c'
                  } else if (weaponLower.includes('smokegrenade') || weaponLower.includes('smoke_grenade')) {
                    grenadeColor = '#737373'
                  } else if (weaponLower.includes('flashbang')) {
                    grenadeColor = '#f9a43f'
                  } else if (weaponLower.includes('incendiary') || weaponLower.includes('molotov')) {
                    grenadeColor = '#da7b11'
                  } else if (weaponLower.includes('decoy')) {
                    grenadeColor = '#f76d74'
                  }
                  
                  if (grenadeColor) {
                    const grenadeRadius = 3
                    ctx.beginPath()
                    ctx.fillStyle = grenadeColor
                    ctx.arc(screenX, screenY - playerRadius, grenadeRadius, 0, 2 * Math.PI)
                    ctx.fill()
                  }
                }
              } else {
                // Draw line for normal weapons (matching CS Demo Analyzer)
                ctx.beginPath()
                ctx.lineWidth = 2
                const lineLength = 8 + 2
                ctx.moveTo(screenX, screenY)
                ctx.lineTo(screenX + lineLength * Math.cos(playerAngle), screenY + lineLength * Math.sin(playerAngle))
                ctx.strokeStyle = 'white'
                ctx.stroke()
              }
            }
          }
        }

        // Draw player name
        if (pos.name) {
          ctx.fillStyle = '#fff'
          ctx.font = '12px Arial'
          ctx.textAlign = 'center'
          ctx.fillText(pos.name, screenX, screenY - 12)
        }
      }

      // Helper function to get grenade color
      const getGrenadeColor = (grenadeName: string): string => {
        const name = grenadeName.toLowerCase()
        if (name.includes('he') || name.includes('hegrenade')) {
          return '#268e6c' // HE Grenade
        } else if (name.includes('smoke') || name.includes('smokegrenade')) {
          return '#737373' // Smoke
        } else if (name.includes('flash') || name.includes('flashbang')) {
          return '#f9a43f' // Flashbang
        } else if (name.includes('incendiary') || name.includes('molotov')) {
          return '#da7b11' // Molotov/Incendiary
        } else if (name.includes('decoy')) {
          return '#f76d74' // Decoy
        }
        return '#ffffff'
      }

      // Helper function to transform coordinates
      const transformCoords = (x: number, y: number, z: number) => {
        const mapTransform = (ctx as any).mapTransform
        if (mapTransform && mapImage && mapImage.complete) {
          const radarX = getScaledCoordinateX(mapTransform.mapConfig, mapTransform.radarSize, x)
          const radarY = getScaledCoordinateY(mapTransform.mapConfig, mapTransform.radarSize, y)
          const scaleX = mapTransform.drawWidth / mapTransform.radarSize
          const scaleY = mapTransform.drawHeight / mapTransform.radarSize
          return {
            x: mapTransform.drawX + radarX * scaleX,
            y: mapTransform.drawY + radarY * scaleY
          }
        } else {
          const { scale, offsetX, offsetY, flipY } = (ctx as any).gameToScreen || { scale: 1, offsetX: 0, offsetY: 0, flipY: false }
          return {
            x: offsetX + x * scale,
            y: flipY ? offsetY - y * scale : offsetY + y * scale
          }
        }
      }

      // Get tickrate (default to 64 if not available)
      const tickrate = 64 // TODO: get from match data

      // Get current round to filter grenades
      const getCurrentRoundForGrenades = () => {
        if (isFullGame && allRounds.length > 0) {
          return allRounds.find(r => currentTick >= r.startTick && currentTick <= r.endTick)
        }
        return null
      }
      const currentRoundForGrenades = getCurrentRoundForGrenades()
      
      // Draw grenades following cs-demo-manager pattern
      // Only process grenades that have a position at the current tick (or interpolated)
      // Filter by current round - clear all grenades between rounds
      const grenadeCircleSize = zoomedSize(4)
      
      // Filter grenade positions by round and current tick
      const filteredGrenadePositions = grenadePositions.filter(gp => {
        // Filter by round if in full game mode - only show grenades from current round
        if (isFullGame && currentRoundForGrenades) {
          const posRound = allRounds.find(r => gp.tick >= r.startTick && gp.tick <= r.endTick)
          if (posRound) {
            const currentRoundIdx = allRounds.indexOf(currentRoundForGrenades)
            const posRoundIdx = allRounds.indexOf(posRound)
            // Only show positions from current round
            if (posRoundIdx !== currentRoundIdx) return false
          } else {
            // If position doesn't belong to any round, skip it
            return false
          }
        }
        return true
      })
      
      // Get grenades at current tick (or interpolate to current tick)
      // cs-demo-manager pattern: only process grenades that have a position at currentTick
      // We'll find the most recent position <= currentTick for each projectileId
      const grenadesAtCurrentTick = new Map<number, typeof grenadePositions[0] & { interpolated?: boolean }>()
      for (const grenadePos of filteredGrenadePositions) {
        if (grenadePos.tick > currentTick) continue
        
        const existing = grenadesAtCurrentTick.get(grenadePos.projectileId)
        if (!existing || grenadePos.tick > existing.tick) {
          grenadesAtCurrentTick.set(grenadePos.projectileId, grenadePos)
        }
      }
      
      // Helper functions for drawing effects (matching cs-demo-manager)
      const drawSmokeEffect = (smokeStart: typeof grenadeEvents[0], smokeExpirePosition: typeof grenadePositions[0] | undefined) => {
        const coords = transformCoords(smokeStart.x, smokeStart.y, smokeStart.z)
        const x = coords.x
        const y = coords.y
        const grenadeColor = getGrenadeColor('smokegrenade')
        
        ctx.beginPath()
        ctx.fillStyle = `${grenadeColor}7f`
        ctx.lineWidth = zoomedSize(2)
        const teamColor = smokeStart.throwerTeam === 'T' ? '#ff6b35' : smokeStart.throwerTeam === 'CT' ? '#4a90e2' : grenadeColor
        ctx.strokeStyle = `${teamColor}7f`
        ctx.arc(x, y, zoomedSize(26), 0, 2 * Math.PI)
        ctx.stroke()
        ctx.fill()
        
        ctx.beginPath()
        ctx.strokeStyle = '#ffffffbb'
        ctx.lineWidth = 2
        const elapsedTickCount = currentTick - smokeStart.tick
        const secondsElapsed = elapsedTickCount / tickrate
        let smokeDuration = 18
        if (smokeExpirePosition !== undefined) {
          smokeDuration = (smokeExpirePosition.tick - smokeStart.tick) / tickrate
        }
        const percentage = -(secondsElapsed / smokeDuration)
        const startAngle = -Math.PI / 2
        const endAngle = startAngle + Math.PI * 2 * percentage
        ctx.arc(x, y, zoomedSize(8), startAngle, endAngle)
        ctx.stroke()
      }
      
      const drawHeGrenadeExplode = (heGrenadeExplode: typeof grenadeEvents[0]) => {
        const effectDurationSeconds = 1
        const elapsedSinceExplosionTickCount = currentTick - heGrenadeExplode.tick
        const secondsElapsed = elapsedSinceExplosionTickCount / tickrate
        if (secondsElapsed > effectDurationSeconds) {
          return
        }
        
        const coords = transformCoords(heGrenadeExplode.x, heGrenadeExplode.y, heGrenadeExplode.z)
        const x = coords.x
        const y = coords.y
        const grenadeColor = getGrenadeColor('hegrenade')
        ctx.beginPath()
        ctx.fillStyle = grenadeColor
        const scale = 1 - secondsElapsed / effectDurationSeconds
        const size = zoomedSize(20 * scale)
        ctx.arc(x, y, size, 0, 2 * Math.PI)
        ctx.closePath()
        ctx.fill()
      }
      
      const drawDecoyEffect = (position: typeof grenadePositions[0]) => {
        const coords = transformCoords(position.x, position.y, position.z)
        const x = coords.x
        const y = coords.y
        const grenadeColor = getGrenadeColor(position.grenadeName)
        ctx.beginPath()
        ctx.fillStyle = grenadeColor
        ctx.lineWidth = zoomedSize(1)
        ctx.arc(x, y, grenadeCircleSize, 0, 2 * Math.PI)
        ctx.closePath()
        ctx.fill()
      }
      
      // Process each grenade at current tick (cs-demo-manager pattern)
      for (const [projectileId, position] of grenadesAtCurrentTick) {
        const { grenadeName } = position
        
        // Check if grenade has exploded/started effect
        switch (grenadeName) {
          case 'smokegrenade': {
            // IMPORTANT: event.tick is when smoke ENDS, so smokeStart.tick is when it ends
            // We need to find the smoke_start event and calculate backwards
            const smokeEvent = grenadeEvents.find(ge => 
              ge.projectileId === projectileId && 
              (ge.eventType === 'smoke_start' || ge.eventType === 'smoke_end') &&
              ge.tick <= currentTick
            )
            if (smokeEvent !== undefined) {
              // Calculate smoke start tick (event.tick is when smoke ends)
              const smokeDuration = 18
              const smokeDurationTicks = Math.floor(smokeDuration * tickrate)
              const smokeStartTick = smokeEvent.tick - smokeDurationTicks
              
              // Only show smoke if currentTick is within smoke duration
              if (currentTick >= smokeStartTick && currentTick <= smokeEvent.tick) {
                // Find smoke expire position (last position for this projectileId)
                const smokeExpirePosition = filteredGrenadePositions
                  .filter(p => p.projectileId === projectileId && p.tick >= currentTick)
                  .sort((a, b) => a.tick - b.tick)
                  .at(-1)
                
                // Create a smokeStart event with the calculated start tick
                const smokeStartEvent = {
                  ...smokeEvent,
                  tick: smokeStartTick
                }
                drawSmokeEffect(smokeStartEvent, smokeExpirePosition)
              }
              // Always skip trajectory if smoke event exists (even if smoke has expired)
              continue
            }
            break
          }
          case 'hegrenade': {
            const heGrenadeExplode = grenadeEvents.find(ge =>
              ge.projectileId === projectileId &&
              ge.eventType === 'he_explode' &&
              ge.tick <= currentTick
            )
            if (heGrenadeExplode !== undefined) {
              drawHeGrenadeExplode(heGrenadeExplode)
              continue // Skip trajectory
            }
            break
          }
          case 'decoy': {
            const decoyStart = grenadeEvents.find(ge =>
              ge.projectileId === projectileId &&
              ge.eventType === 'decoy_start' &&
              ge.tick <= currentTick
            )
            if (decoyStart !== undefined) {
              drawDecoyEffect(position)
              continue // Skip trajectory
            }
            break
          }
        }
        
        // Draw trajectory for in-flight grenades ONLY if grenade hasn't exploded
        // Double-check that grenade hasn't exploded (safety check - should have been caught in switch above)
        // Use the same logic as in the switch statement above
        let hasExploded = false
        
        if (grenadeName === 'smokegrenade') {
          const smokeEvent = grenadeEvents.find(ge => 
            ge.projectileId === projectileId && 
            (ge.eventType === 'smoke_start' || ge.eventType === 'smoke_end') &&
            ge.tick <= currentTick
          )
          hasExploded = smokeEvent !== undefined
        } else if (grenadeName === 'hegrenade') {
          const heGrenadeExplode = grenadeEvents.find(ge =>
            ge.projectileId === projectileId &&
            ge.eventType === 'he_explode' &&
            ge.tick <= currentTick
          )
          hasExploded = heGrenadeExplode !== undefined
        } else if (grenadeName === 'decoy') {
          const decoyStart = grenadeEvents.find(ge =>
            ge.projectileId === projectileId &&
            ge.eventType === 'decoy_start' &&
            ge.tick <= currentTick
          )
          hasExploded = decoyStart !== undefined
        } else if (grenadeName === 'flashbang') {
          const flashbangExplode = grenadeEvents.find(ge =>
            ge.projectileId === projectileId &&
            ge.eventType === 'flash_explode' &&
            ge.tick <= currentTick
          )
          hasExploded = flashbangExplode !== undefined
        }
        
        if (hasExploded) {
          // Grenade has exploded but we didn't catch it in switch - skip trajectory
          continue
        }
        
        // Draw trajectory for in-flight grenades ONLY
        // Make absolutely sure grenade hasn't exploded by checking again
        const hasExplodedCheck = grenadeEvents.some(ge => {
          if (ge.projectileId !== projectileId || ge.tick > currentTick) return false
          const eventTypeLower = (ge.eventType || '').toLowerCase()
          const grenadeNameLower = (grenadeName || '').toLowerCase()
          
          if (grenadeNameLower === 'smokegrenade' && (eventTypeLower === 'smoke_start' || eventTypeLower === 'smoke_end')) return true
          if (grenadeNameLower === 'hegrenade' && eventTypeLower === 'he_explode') return true
          if (grenadeNameLower === 'decoy' && eventTypeLower === 'decoy_start') return true
          if (grenadeNameLower === 'flashbang' && eventTypeLower === 'flash_explode') return true
          return false
        })
        
        if (hasExplodedCheck) {
          // Safety check failed - grenade has exploded, skip trajectory
          continue
        }
        
        // Draw trajectory for in-flight grenades (tick < currentTick)
        const previousPositions = filteredGrenadePositions.filter(p => 
          p.projectileId === projectileId && p.tick < currentTick
        ).sort((a, b) => a.tick - b.tick)
        
        if (previousPositions.length === 0) continue
        
        ctx.strokeStyle = getGrenadeColor(grenadeName)
        ctx.fillStyle = getGrenadeColor(grenadeName)
        ctx.lineWidth = zoomedSize(1)
        
        // Draw grenade path (trajectory)
        for (let i = 0; i < previousPositions.length - 1; i++) {
          ctx.beginPath()
          const currentPosition = previousPositions[i]
          const currentCoords = transformCoords(currentPosition.x, currentPosition.y, currentPosition.z)
          ctx.moveTo(currentCoords.x, currentCoords.y)
          
          const nextPosition = previousPositions[i + 1]
          const nextCoords = transformCoords(nextPosition.x, nextPosition.y, nextPosition.z)
          ctx.lineTo(nextCoords.x, nextCoords.y)
          ctx.closePath()
          ctx.stroke()
        }
        
        // Draw grenade circle at current position
        const currentCoords = transformCoords(position.x, position.y, position.z)
        ctx.beginPath()
        ctx.arc(currentCoords.x, currentCoords.y, grenadeCircleSize, 0, 2 * Math.PI)
        ctx.closePath()
        ctx.fill()
      }
      
      // Handle flashbang explosions separately (cs-demo-manager pattern)
      const flashbangExplodes = grenadeEvents.filter(ge =>
        ge.eventType === 'flash_explode' && ge.tick <= currentTick
      )
      for (const flashbangExplode of flashbangExplodes) {
        const secondsElapsedSinceExplosion = (currentTick - flashbangExplode.tick) / tickrate
        if (secondsElapsedSinceExplosion > 1) {
          continue
        }
        
        const coords = transformCoords(flashbangExplode.x, flashbangExplode.y, flashbangExplode.z)
        const x = coords.x
        const y = coords.y
        const grenadeColor = getGrenadeColor('flashbang')
        ctx.beginPath()
        ctx.fillStyle = grenadeColor
        const scale = 1 - secondsElapsedSinceExplosion
        const size = zoomedSize(20 * scale)
        ctx.arc(x, y, size, 0, 2 * Math.PI)
        ctx.closePath()
        ctx.fill()
      }

      // Draw shots (animated lines extending from player position)
      // Use a ref to track animated shots that fade out over time
      if (!(ctx as any).animatedShots) {
        (ctx as any).animatedShots = []
      }
      const animatedShots = (ctx as any).animatedShots as Array<{
        tick: number
        steamId: string
        weaponName: string
        x: number
        y: number
        z: number
        yaw: number
        team: string | null
        time: number
      }>

      // Add new shots at current tick
      const tickShots = shots.filter(shot => shot.tick === currentTick)
      for (const shot of tickShots) {
        animatedShots.push({
          ...shot,
          time: 0.1, // Start animation
        })
      }

      // Draw and update animated shots
      for (const shot of animatedShots) {
        const coords = transformCoords(shot.x, shot.y, shot.z)
        const screenX = coords.x
        const screenY = coords.y

        // Calculate player angle from yaw (convert degrees to radians, and invert like CS Demo Analyzer)
        const playerAngle = -degreesToRadians(shot.yaw)
        const playerRadius = zoomedSize(8)
        
        // Start position: player position + radius offset in view direction
        const startX = screenX + playerRadius * Math.cos(playerAngle)
        const startY = screenY + playerRadius * Math.sin(playerAngle)
        
        // End position: extend line in view direction (line length increases with time)
        const lineLength = zoomedSize(80)
        const endX = startX + lineLength * shot.time * Math.cos(playerAngle)
        const endY = startY + lineLength * shot.time * Math.sin(playerAngle)

        // Get team color for shot line
        const teamColor = shot.team === 'T' ? '#ff6b35' : shot.team === 'CT' ? '#4a90e2' : '#ffffff'

        // Draw shot line
        ctx.beginPath()
        ctx.strokeStyle = teamColor
        ctx.lineWidth = zoomedSize(1)
        ctx.moveTo(startX, startY)
        ctx.lineTo(endX, endY)
        ctx.stroke()

        // Update animation time
        shot.time += 0.1
      }

      // Filter out shots that have finished animating (time >= 1.0)
      (ctx as any).animatedShots = animatedShots.filter(shot => shot.time < 1.0)

      // Follow player: update pan to keep selected player centered
      if (followPlayer) {
        const followedPos = getInterpolatedPosition(followPlayer, currentTick)
        if (followedPos) {
          const mapTransform = (ctx as any).mapTransform
          if (mapTransform && mapImage && mapImage.complete) {
            // Calculate player's position in radar coordinates
            const radarX = getScaledCoordinateX(mapTransform.mapConfig, mapTransform.radarSize, followedPos.x)
            const radarY = getScaledCoordinateY(mapTransform.mapConfig, mapTransform.radarSize, followedPos.y)
            const scaleX = mapTransform.drawWidth / mapTransform.radarSize
            const scaleY = mapTransform.drawHeight / mapTransform.radarSize
            
            // Calculate center of canvas
            const centerX = canvas.width / 2
            const centerY = canvas.height / 2
            
            // Calculate pan needed to center the player
            // drawX = centerX - drawWidth/2 + panX
            // We want: centerX = drawX + radarX * scaleX
            // So: centerX = centerX - drawWidth/2 + panX + radarX * scaleX
            // panX = drawWidth/2 - radarX * scaleX
            const newPanX = mapTransform.drawWidth / 2 - radarX * scaleX
            const newPanY = mapTransform.drawHeight / 2 - radarY * scaleY
            
            // Only update if values changed to avoid infinite loops
            if (Math.abs(panX - newPanX) > 0.1 || Math.abs(panY - newPanY) > 0.1) {
              setPanX(newPanX)
              setPanY(newPanY)
            }
          }
        }
      }

      // Continue animation if playing
      if (isPlaying) {
        animationFrameRef.current = requestAnimationFrame(render)
      }
    }

    // Start rendering
    render()

    return () => {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current)
      }
    }
  }, [allPositions, currentTick, isPlaying, getCurrentPositions, events, getInterpolatedPosition, mapImage, playerTImage, playerCTImage, shots, grenadePositions, grenadeEvents, zoom, panX, panY, followPlayer])


  const handleTickChange = (newTick: number) => {
    if (isFullGame && allRounds.length > 0) {
      // In full game mode, allow ticks across all rounds
      const firstRound = allRounds[0]
      const lastRound = allRounds[allRounds.length - 1]
      const clampedTick = Math.max(firstRound.startTick, Math.min(lastRound.endTick, newTick))
      setCurrentTick(clampedTick)
    } else {
      const clampedTick = Math.max(roundStartTick, Math.min(roundEndTick, newTick))
      setCurrentTick(clampedTick)
    }
  }

  // Playback control with smooth tick updates
  useEffect(() => {
    if (isPlaying) {
      // Use requestAnimationFrame for smooth updates
      // Calculate tick increment based on playback speed and frame rate
      const targetFPS = 60
      const tickRate = 64 // CS2 tick rate
      const ticksPerFrame = (tickRate * playbackSpeed) / targetFPS

      let accumulatedTicks = 0
      let lastTime = performance.now()

      const updateTick = (currentTime: number) => {
        // Cap deltaTime to prevent large jumps (e.g., tab switching) that cause choppiness
        const deltaTime = Math.min(currentTime - lastTime, 100) // Max 100ms
        lastTime = currentTime

        // Calculate how many ticks to advance
        accumulatedTicks += (tickRate * playbackSpeed * deltaTime) / 1000

        if (accumulatedTicks >= 1) {
          const ticksToAdvance = Math.floor(accumulatedTicks)
          accumulatedTicks -= ticksToAdvance

          setCurrentTick((prevTick) => {
            const nextTick = prevTick + ticksToAdvance
            let maxTick = roundEndTick
            if (isFullGame && allRounds.length > 0) {
              maxTick = allRounds[allRounds.length - 1].endTick
            }
            if (nextTick >= maxTick) {
              setIsPlaying(false)
              return maxTick
            }
            return nextTick
          })
        }

        if (isPlaying) {
          playbackIntervalRef.current = requestAnimationFrame(updateTick) as any
        }
      }

      playbackIntervalRef.current = requestAnimationFrame(updateTick) as any
    } else {
      if (playbackIntervalRef.current !== null) {
        cancelAnimationFrame(playbackIntervalRef.current as number)
        playbackIntervalRef.current = null
      }
    }

    return () => {
      if (playbackIntervalRef.current !== null) {
        cancelAnimationFrame(playbackIntervalRef.current as number)
      }
    }
  }, [isPlaying, playbackSpeed, roundEndTick])

  const handlePlayPause = () => {
    let maxTick = roundEndTick
    let minTick = roundStartTick
    if (isFullGame && allRounds.length > 0) {
      maxTick = allRounds[allRounds.length - 1].endTick
      minTick = allRounds[0].startTick
    }
    if (currentTick >= maxTick) {
      // Reset to start if at end
      setCurrentTick(minTick)
    }
    setIsPlaying(!isPlaying)
  }

  // Zoom and pan handlers - use native event listener with passive: false to allow preventDefault
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault()
      
      // Disable follow player when user manually zooms
      if (followPlayer) {
        setFollowPlayer(null)
      }
      
      const rect = canvas.getBoundingClientRect()
      const mouseX = e.clientX - rect.left
      const mouseY = e.clientY - rect.top
      
      // Calculate zoom factor (zoom in/out)
      const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1
      const newZoom = Math.max(0.5, Math.min(5, zoom * zoomFactor))
      
      // Calculate the point under the mouse before zoom
      const centerX = canvas.width / 2
      const centerY = canvas.height / 2
      const maxSize = Math.min(canvas.width, canvas.height)
      const baseSize = maxSize
      const oldSize = baseSize * zoom
      const oldX = centerX - oldSize / 2 + panX
      const oldY = centerY - oldSize / 2 + panY
      
      // Convert mouse position to map coordinates
      const mapX = (mouseX - oldX) / oldSize
      const mapY = (mouseY - oldY) / oldSize
      
      // Calculate new size and position
      const newSize = baseSize * newZoom
      const newX = centerX - newSize / 2
      const newY = centerY - newSize / 2
      
      // Adjust pan to keep the point under the mouse in the same place
      const newPanX = mouseX - newX - mapX * newSize
      const newPanY = mouseY - newY - mapY * newSize
      
      setZoom(newZoom)
      setPanX(newPanX)
      setPanY(newPanY)
    }

    // Use addEventListener with passive: false to allow preventDefault
    canvas.addEventListener('wheel', handleWheel, { passive: false })

    return () => {
      canvas.removeEventListener('wheel', handleWheel)
    }
  }, [zoom, panX, panY, followPlayer])
  
  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return // Only handle left mouse button
    setIsDragging(true)
    setDragStart({ x: e.clientX, y: e.clientY })
    setDragStartPan({ x: panX, y: panY })
  }
  
  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDragging) return
    
    const deltaX = e.clientX - dragStart.x
    const deltaY = e.clientY - dragStart.y
    
    // Disable follow player when user manually pans
    if (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3) {
      if (followPlayer) {
        setFollowPlayer(null)
      }
    }
    
    setPanX(dragStartPan.x + deltaX)
    setPanY(dragStartPan.y + deltaY)
  }
  
  const handleMouseUp = () => {
    setIsDragging(false)
  }
  
  const handleResetView = () => {
    setZoom(1)
    setPanX(0)
    setPanY(0)
    setFollowPlayer(null)
  }

  const handleStop = () => {
    setIsPlaying(false)
    let minTick = roundStartTick
    if (isFullGame && allRounds.length > 0) {
      minTick = allRounds[0].startTick
    }
    setCurrentTick(minTick)
  }

  const tickToTime = (tick: number) => {
    let startTick = roundStartTick
    if (isFullGame && allRounds.length > 0) {
      startTick = allRounds[0].startTick
    }
    const seconds = (tick - startTick) / 64
    const minutes = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${minutes}:${secs.toString().padStart(2, '0')}`
  }

  // Custom slider component with round markers
  const CustomSlider = () => {
    const sliderRef = useRef<HTMLDivElement>(null)
    const [isDragging, setIsDragging] = useState(false)
    
    let minTick = roundStartTick
    let maxTick = roundEndTick
    if (isFullGame && allRounds.length > 0) {
      minTick = allRounds[0].startTick
      maxTick = allRounds[allRounds.length - 1].endTick
    }
    
    const tickRange = maxTick - minTick
    const currentPercent = ((currentTick - minTick) / tickRange) * 100
    
    const handleMouseDown = (e: React.MouseEvent) => {
      setIsDragging(true)
      handleSliderClick(e)
    }
    
    const handleMouseMove = (e: React.MouseEvent) => {
      if (isDragging) {
        handleSliderClick(e)
      }
    }
    
    const handleMouseUp = () => {
      setIsDragging(false)
    }
    
    const handleSliderClick = (e: React.MouseEvent) => {
      if (!sliderRef.current) return
      const rect = sliderRef.current.getBoundingClientRect()
      const x = e.clientX - rect.left
      const percent = Math.max(0, Math.min(100, (x / rect.width) * 100))
      const newTick = Math.round(minTick + (percent / 100) * tickRange)
      handleTickChange(newTick)
    }
    
    useEffect(() => {
      if (isDragging) {
        const handleGlobalMouseMove = (e: MouseEvent) => {
          if (sliderRef.current) {
            const rect = sliderRef.current.getBoundingClientRect()
            const x = e.clientX - rect.left
            const percent = Math.max(0, Math.min(100, (x / rect.width) * 100))
            const newTick = Math.round(minTick + (percent / 100) * tickRange)
            handleTickChange(newTick)
          }
        }
        const handleGlobalMouseUp = () => {
          setIsDragging(false)
        }
        window.addEventListener('mousemove', handleGlobalMouseMove)
        window.addEventListener('mouseup', handleGlobalMouseUp)
        return () => {
          window.removeEventListener('mousemove', handleGlobalMouseMove)
          window.removeEventListener('mouseup', handleGlobalMouseUp)
        }
      }
    }, [isDragging, minTick, tickRange, handleTickChange])
    
    return (
      <div className="flex-1 relative">
        <div
          ref={sliderRef}
          className="relative h-16 bg-[#1a1a1a] rounded-lg cursor-pointer border border-[#2a2a2a]"
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
        >
          {/* Progress bar background */}
          <div className="absolute inset-0 bg-[#0f0f0f] rounded-lg" />
          
          {/* Round markers */}
          {isFullGame && allRounds.length > 0 && allRounds.map((round, idx) => {
            const startPercent = ((round.startTick - minTick) / tickRange) * 100
            const endPercent = ((round.endTick - minTick) / tickRange) * 100
            const isCurrentRound = currentTick >= round.startTick && currentTick <= round.endTick
            
            return (
              <div key={round.roundIndex} className="absolute inset-y-0" style={{ left: `${startPercent}%`, width: `${endPercent - startPercent}%` }}>
                {/* Round background */}
                <div className={`h-full ${isCurrentRound ? 'bg-accent/30' : 'bg-[#1a1a1a]/80'} border-l border-r ${isCurrentRound ? 'border-accent/60' : 'border-[#2a2a2a]/50'}`} />
                
                {/* Round start marker */}
                <div className={`absolute left-0 top-0 bottom-0 w-0.5 ${isCurrentRound ? 'bg-accent' : 'bg-[#3a3a3a]'}`} />
                
                {/* Round number label - show all rounds */}
                <div className={`absolute -top-6 left-1 text-[10px] ${isCurrentRound ? 'text-accent font-semibold' : 'text-gray-500'} whitespace-nowrap`}>
                  R{round.roundIndex + 1}
                </div>
              </div>
            )
          })}
          
          {/* Time markers (every 5 minutes) */}
          {(() => {
            const markers: JSX.Element[] = []
            const tickRate = 64
            const intervalMinutes = 5
            const intervalSeconds = intervalMinutes * 60
            const intervalTicks = intervalSeconds * tickRate
            let tick = minTick
            
            while (tick <= maxTick) {
              const percent = ((tick - minTick) / tickRange) * 100
              markers.push(
                <div
                  key={tick}
                  className="absolute top-0 bottom-0 w-px bg-[#3a3a3a]/50"
                  style={{ left: `${percent}%` }}
                >
                  <div className="absolute -top-5 left-1/2 transform -translate-x-1/2 text-[10px] text-gray-500 whitespace-nowrap">
                    {tickToTime(tick)}
                  </div>
                </div>
              )
              tick += intervalTicks
            }
            return markers
          })()}
          
          {/* Progress bar (filled portion) */}
          <div 
            className="absolute inset-y-0 left-0 bg-accent/40 rounded-l-lg"
            style={{ width: `${currentPercent}%` }}
          />
          
          {/* Slider track line */}
          <div className="absolute top-1/2 left-0 right-0 h-0.5 bg-[#2a2a2a] transform -translate-y-1/2" />
          
          {/* Current position indicator */}
          <div
            className="absolute top-1/2 transform -translate-y-1/2 -translate-x-1/2 w-5 h-5 bg-accent rounded-full border-2 border-white shadow-lg cursor-grab active:cursor-grabbing z-10 hover:scale-110 transition-transform"
            style={{ left: `${currentPercent}%` }}
          >
            <div className="absolute -top-7 left-1/2 transform -translate-x-1/2 text-xs font-bold text-white whitespace-nowrap bg-accent px-2 py-0.5 rounded">
              {tickToTime(currentTick)}
            </div>
          </div>
        </div>
      </div>
    )
  }
  
  // Get current round info for display
  const getCurrentRoundInfo = () => {
    if (isFullGame && allRounds.length > 0) {
      const currentRound = allRounds.find(r => currentTick >= r.startTick && currentTick <= r.endTick)
      if (currentRound) {
        return { roundIndex: currentRound.roundIndex, roundNumber: currentRound.roundIndex + 1 }
      }
      // Find the round we're closest to
      for (let i = 0; i < allRounds.length; i++) {
        if (currentTick < allRounds[i].startTick) {
          return { roundIndex: i > 0 ? allRounds[i - 1].roundIndex : allRounds[0].roundIndex, roundNumber: i > 0 ? allRounds[i - 1].roundIndex + 1 : 1 }
        }
      }
      return { roundIndex: allRounds[allRounds.length - 1].roundIndex, roundNumber: allRounds.length }
    }
    return { roundIndex, roundNumber: roundIndex + 1 }
  }
  
  const currentRoundInfo = getCurrentRoundInfo()
  
  // Determine if we should show as modal or inline
  const isModal = !isFullGame

  // Legend state
  const [showLegend, setShowLegend] = useState(false)

  return (
    <div className={isModal ? "fixed inset-0 bg-black/80 flex items-center justify-center z-50" : "h-full flex flex-col"}>
      <div className={`bg-secondary rounded-lg border border-border ${isModal ? 'w-[90vw] h-[90vh]' : 'h-full'} flex flex-col overflow-hidden`}>
        {/* Header */}
        <div className="px-6 py-4 border-b border-border flex items-center justify-between flex-shrink-0">
          <div>
            <h2 className="text-xl font-semibold text-white flex items-center gap-2">
              2D Viewer
              <span className="px-1.5 py-0.5 text-xs bg-yellow-900/30 text-yellow-400 rounded border border-yellow-500/30">
                WIP
              </span>
            </h2>
            <p className="text-sm text-gray-400">
              {isFullGame ? `Full Game (Round ${currentRoundInfo.roundNumber} of ${allRounds.length})` : `Round ${currentRoundInfo.roundNumber}`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowLegend(!showLegend)}
              className="px-3 py-2 bg-surface hover:bg-surface/80 text-white rounded transition-colors flex items-center gap-2"
              title="Show legend"
            >
              <Info size={16} />
              <span className="text-sm">Legend</span>
            </button>
            {!isFullGame && (
              <button
                onClick={onClose}
                className="px-4 py-2 bg-surface hover:bg-surface/80 text-white rounded transition-colors"
              >
                Close
              </button>
            )}
          </div>
        </div>

        {/* Legend Panel */}
        {showLegend && (
          <div className="absolute top-16 right-4 z-50 bg-surface border border-border rounded-lg shadow-xl p-4 max-w-sm">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-white">Color Legend</h3>
              <button
                onClick={() => setShowLegend(false)}
                className="text-gray-400 hover:text-white transition-colors"
              >
                <X size={18} />
              </button>
            </div>
            
            <div className="space-y-4">
              {/* Teams */}
              <div>
                <h4 className="text-sm font-semibold text-gray-300 mb-2">Teams</h4>
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <div className="w-4 h-4 rounded-full bg-[#ff6b35]" />
                    <span className="text-sm text-gray-400">Terrorists (T)</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-4 h-4 rounded-full bg-[#4a90e2]" />
                    <span className="text-sm text-gray-400">Counter-Terrorists (CT)</span>
                  </div>
                </div>
              </div>

              {/* Grenades */}
              <div>
                <h4 className="text-sm font-semibold text-gray-300 mb-2">Grenades</h4>
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <div className="w-4 h-4 rounded-full" style={{ backgroundColor: '#268e6c' }} />
                    <span className="text-sm text-gray-400">HE Grenade</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-4 h-4 rounded-full" style={{ backgroundColor: '#737373' }} />
                    <span className="text-sm text-gray-400">Smoke Grenade</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-4 h-4 rounded-full" style={{ backgroundColor: '#f9a43f' }} />
                    <span className="text-sm text-gray-400">Flashbang</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-4 h-4 rounded-full" style={{ backgroundColor: '#da7b11' }} />
                    <span className="text-sm text-gray-400">Molotov/Incendiary</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-4 h-4 rounded-full" style={{ backgroundColor: '#f76d74' }} />
                    <span className="text-sm text-gray-400">Decoy</span>
                  </div>
                </div>
              </div>

              {/* Player States */}
              <div>
                <h4 className="text-sm font-semibold text-gray-300 mb-2">Player States</h4>
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <div className="w-4 h-4 rounded-full bg-white border-2 border-white" />
                    <span className="text-sm text-gray-400">Alive Player</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-lg">💀</span>
                    <span className="text-sm text-gray-400">Dead Player</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-4 h-4 rounded-full border-2 border-red-500 bg-red-500/30" />
                    <span className="text-sm text-gray-400">Low Health (&lt;100 HP)</span>
                  </div>
                </div>
              </div>

              {/* Events */}
              <div>
                <h4 className="text-sm font-semibold text-gray-300 mb-2">Events</h4>
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full bg-red-500" />
                    <span className="text-sm text-gray-400">Team Kill</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full bg-orange-500" />
                    <span className="text-sm text-gray-400">Team Damage</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full bg-yellow-500" />
                    <span className="text-sm text-gray-400">Team Flash</span>
                  </div>
                </div>
              </div>

              {/* Smoke Effects */}
              <div>
                <h4 className="text-sm font-semibold text-gray-300 mb-2">Smoke Effects</h4>
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <div className="w-6 h-6 rounded-full border-2" style={{ borderColor: '#7373737f', backgroundColor: '#7373737f' }} />
                    <span className="text-sm text-gray-400">Active Smoke (with timer)</span>
                  </div>
                  <div className="text-xs text-gray-500 mt-1">
                    White arc shows remaining time
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Canvas with Team Panels */}
        <div className="flex-1 relative bg-primary overflow-hidden flex min-h-0" style={{ maxHeight: isModal ? 'calc(90vh - 300px)' : 'calc(100% - 220px)' }}>
          {/* Left Team Panel (T/Team A) */}
          <div className="w-56 bg-surface border-r border-border overflow-y-auto flex flex-col max-h-full">
            <div className="p-3 border-b border-[#ff6b35]/50 bg-[#ff6b35]/10">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-[#ff6b35]">Terrorists</h3>
                <span className="text-xs text-gray-400">
                  {getCurrentPositions().filter(p => p.team === 'T').length}
                </span>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto">
              {getCurrentPositions()
                .filter(pos => pos.team === 'T')
                .sort((a, b) => (a.name || a.steamid).localeCompare(b.name || b.steamid))
                .map((pos) => {
                  const isDead = pos.health === null || pos.health <= 0
                  return (
                    <div 
                      key={pos.steamid} 
                      className={`p-2 border-b border-border/50 ${isDead ? 'opacity-50' : ''} ${followPlayer === pos.steamid ? 'bg-accent/20 border-accent/50' : 'hover:bg-surface/50'} cursor-pointer transition-colors`}
                      onClick={() => setFollowPlayer(followPlayer === pos.steamid ? null : pos.steamid)}
                      title={followPlayer === pos.steamid ? 'Click to unfollow' : 'Click to follow player'}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <div className="w-2 h-2 rounded-full bg-[#ff6b35]" />
                        <span className="font-medium text-white text-sm truncate flex-1">{pos.name || pos.steamid}</span>
                        {followPlayer === pos.steamid && <span className="text-xs text-accent">●</span>}
                      </div>
                      <div className="grid grid-cols-3 gap-1 text-[10px] text-gray-400">
                        <div>
                          <span className="text-gray-500">HP:</span>
                          <span className={`ml-1 ${isDead ? 'text-red-400' : 'text-green-400'}`}>
                            {pos.health ?? 0}
                          </span>
                        </div>
                        <div>
                          <span className="text-gray-500">Armor:</span>
                          <span className="ml-1 text-blue-400">{pos.armor ?? 0}</span>
                        </div>
                        <div className="truncate" title={pos.weapon || 'N/A'}>
                          {pos.weapon ? pos.weapon.split('_').pop()?.toUpperCase() || pos.weapon : '-'}
                        </div>
                      </div>
                    </div>
                  )
                })}
            </div>
          </div>

          {/* Canvas */}
          <div className="flex-1 relative">
            {loading && allPositions.size === 0 && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/50 z-10">
                <div className="text-white">Loading positions...</div>
              </div>
            )}
            <canvas
              ref={canvasRef}
              width={1200}
              height={800}
              className="w-full h-full cursor-move"
              style={{ imageRendering: 'pixelated' }}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseUp}
            />
            {/* Scoreboard Overlay - positioned at top center */}
            <ScoreboardOverlay 
              currentTick={currentTick}
              isFullGame={isFullGame}
              allRounds={allRounds}
              roundStartTick={roundStartTick}
              roundEndTick={roundEndTick}
            />
            {/* Killfeed Overlay - positioned above canvas */}
            <KillfeedOverlay events={events} currentTick={currentTick} allPositions={allPositions} />
          </div>

          {/* Right Team Panel (CT/Team B) */}
          <div className="w-56 bg-surface border-l border-border overflow-y-auto flex flex-col max-h-full">
            <div className="p-3 border-b border-[#4a90e2]/50 bg-[#4a90e2]/10">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-[#4a90e2]">Counter-Terrorists</h3>
                <span className="text-xs text-gray-400">
                  {getCurrentPositions().filter(p => p.team === 'CT').length}
                </span>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto">
              {getCurrentPositions()
                .filter(pos => pos.team === 'CT')
                .sort((a, b) => (a.name || a.steamid).localeCompare(b.name || b.steamid))
                .map((pos) => {
                  const isDead = pos.health === null || pos.health <= 0
                  return (
                    <div 
                      key={pos.steamid} 
                      className={`p-2 border-b border-border/50 ${isDead ? 'opacity-50' : ''} ${followPlayer === pos.steamid ? 'bg-accent/20 border-accent/50' : 'hover:bg-surface/50'} cursor-pointer transition-colors`}
                      onClick={() => setFollowPlayer(followPlayer === pos.steamid ? null : pos.steamid)}
                      title={followPlayer === pos.steamid ? 'Click to unfollow' : 'Click to follow player'}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <div className="w-2 h-2 rounded-full bg-[#4a90e2]" />
                        <span className="font-medium text-white text-sm truncate flex-1">{pos.name || pos.steamid}</span>
                        {followPlayer === pos.steamid && <span className="text-xs text-accent">●</span>}
                      </div>
                      <div className="grid grid-cols-3 gap-1 text-[10px] text-gray-400">
                        <div>
                          <span className="text-gray-500">HP:</span>
                          <span className={`ml-1 ${isDead ? 'text-red-400' : 'text-green-400'}`}>
                            {pos.health ?? 0}
                          </span>
                        </div>
                        <div>
                          <span className="text-gray-500">Armor:</span>
                          <span className="ml-1 text-blue-400">{pos.armor ?? 0}</span>
                        </div>
                        <div className="truncate" title={pos.weapon || 'N/A'}>
                          {pos.weapon ? pos.weapon.split('_').pop()?.toUpperCase() || pos.weapon : '-'}
                        </div>
                      </div>
                    </div>
                  )
                })}
            </div>
          </div>
        </div>

        {/* Timeline at Bottom */}
        <div className="px-6 py-4 border-t border-[#2a2a2a] bg-[#1a1a1a] flex-shrink-0">
          <div className="flex items-center gap-4 mb-3">
            {/* Playback controls */}
            <div className="flex items-center gap-2">
              <button
                onClick={handlePlayPause}
                className="px-4 py-2 bg-accent hover:bg-accent/90 text-white rounded-md transition-colors flex items-center gap-2 text-sm font-medium shadow-lg"
                disabled={(() => {
                  let maxTick = roundEndTick
                  if (isFullGame && allRounds.length > 0) {
                    maxTick = allRounds[allRounds.length - 1].endTick
                  }
                  return currentTick >= maxTick && !isPlaying
                })()}
              >
                {isPlaying ? '⏸ Pause' : '▶ Play'}
              </button>
              <button
                onClick={() => handleTickChange(currentTick - 64 * 15)}
                className="px-3 py-2 bg-[#2a2a2a] hover:bg-[#3a3a3a] text-white rounded-md text-sm border border-[#3a3a3a] transition-colors"
                title="Skip -15s"
              >
                -15s
              </button>
              <button
                onClick={() => handleTickChange(currentTick + 64 * 15)}
                className="px-3 py-2 bg-[#2a2a2a] hover:bg-[#3a3a3a] text-white rounded-md text-sm border border-[#3a3a3a] transition-colors"
                title="Skip +15s"
              >
                +15s
              </button>
              <button
                onClick={handleStop}
                className="px-3 py-2 bg-[#2a2a2a] hover:bg-[#3a3a3a] text-white rounded-md text-sm border border-[#3a3a3a] transition-colors"
                title="Stop and reset"
              >
                ⏹
              </button>
            </div>

            {/* Round info */}
            <div className="text-sm text-gray-400 font-medium">
              Round: <span className="text-white">{currentRoundInfo.roundNumber}</span>
              {isFullGame && allRounds.length > 0 && <span className="text-gray-500"> / {allRounds.length}</span>}
            </div>

            {/* Follow player */}
            <select
              value={followPlayer || ''}
              onChange={(e) => {
                const value = e.target.value
                setFollowPlayer(value || null)
                if (!value) {
                  // Reset pan when disabling follow
                  setPanX(0)
                  setPanY(0)
                }
              }}
              className="px-3 py-2 bg-[#2a2a2a] border border-[#3a3a3a] rounded-md text-white text-sm hover:bg-[#3a3a3a] transition-colors"
            >
              <option value="">No follow</option>
              {getCurrentPositions()
                .sort((a, b) => (a.name || a.steamid).localeCompare(b.name || b.steamid))
                .map((pos) => (
                  <option key={pos.steamid} value={pos.steamid}>
                    {pos.name || pos.steamid} ({pos.team || '?'})
                  </option>
                ))}
            </select>

            {/* Playback speed */}
            <select
              value={playbackSpeed}
              onChange={(e) => {
                setPlaybackSpeed(parseFloat(e.target.value))
              }}
              className="px-3 py-2 bg-[#2a2a2a] border border-[#3a3a3a] rounded-md text-white text-sm hover:bg-[#3a3a3a] transition-colors"
            >
              <option value={0.25}>¼x</option>
              <option value={0.5}>½x</option>
              <option value={1}>1x</option>
              <option value={2}>2x</option>
              <option value={4}>4x</option>
              <option value={8}>8x</option>
            </select>

            {/* Zoom controls */}
            <div className="flex items-center gap-2">
              <button
                onClick={() => setZoom(Math.max(0.5, zoom - 0.25))}
                className="px-2 py-1 bg-[#2a2a2a] hover:bg-[#3a3a3a] text-white rounded text-sm border border-[#3a3a3a] transition-colors"
                title="Zoom out"
              >
                −
              </button>
              <span className="text-sm text-gray-300 min-w-[3rem] text-center">
                {Math.round(zoom * 100)}%
              </span>
              <button
                onClick={() => setZoom(Math.min(5, zoom + 0.25))}
                className="px-2 py-1 bg-[#2a2a2a] hover:bg-[#3a3a3a] text-white rounded text-sm border border-[#3a3a3a] transition-colors"
                title="Zoom in"
              >
                +
              </button>
              <button
                onClick={handleResetView}
                className="px-2 py-1 bg-[#2a2a2a] hover:bg-[#3a3a3a] text-white rounded text-xs border border-[#3a3a3a] transition-colors"
                title="Reset zoom and pan"
              >
                Reset
              </button>
            </div>

            {/* Time display */}
            <div className="text-sm text-gray-300 ml-auto font-mono">
              <span className="text-white font-semibold">{tickToTime(currentTick)}</span>
              {(() => {
                let maxTick = roundEndTick
                if (isFullGame && allRounds.length > 0) {
                  maxTick = allRounds[allRounds.length - 1].endTick
                }
                let minTick = roundStartTick
                if (isFullGame && allRounds.length > 0) {
                  minTick = allRounds[0].startTick
                }
                const totalTime = tickToTime(maxTick)
                return <span className="text-gray-500"> / {totalTime}</span>
              })()}
            </div>
          </div>

          {/* Custom Timeline Slider */}
          <div className="flex items-center gap-2">
            <CustomSlider />
          </div>
        </div>
      </div>
    </div>
  )
}

// Scoreboard Overlay Component
function ScoreboardOverlay({ 
  currentTick, 
  isFullGame, 
  allRounds, 
  roundStartTick, 
  roundEndTick 
}: { 
  currentTick: number
  isFullGame: boolean
  allRounds: Round[]
  roundStartTick: number
  roundEndTick: number
}) {
  const tickrate = 64 // CS2 tick rate
  
  // Get current round
  const getCurrentRound = () => {
    if (isFullGame && allRounds.length > 0) {
      return allRounds.find(r => currentTick >= r.startTick && currentTick <= r.endTick)
    }
    // For single round mode, we need to get freezeEndTick from the round data
    // Try to find it in allRounds if available, otherwise use null
    const singleRound = allRounds.find(r => r.roundIndex === 0 || r.startTick === roundStartTick)
    if (singleRound) {
      return singleRound
    }
    // Fallback: create a mock round from props (no freeze time data)
    return {
      roundIndex: 0,
      startTick: roundStartTick,
      endTick: roundEndTick,
      freezeEndTick: null,
      tWins: 0,
      ctWins: 0
    }
  }
  
  const currentRound = getCurrentRound()
  
  // Calculate scores - show scores from previous round during active round, or current round if round is finished
  const getScores = () => {
    if (isFullGame && allRounds.length > 0 && currentRound) {
      // Find the current round index
      const currentRoundIdx = allRounds.findIndex(r => r.roundIndex === currentRound.roundIndex)
      if (currentRoundIdx >= 0) {
        // Check if the round is finished (currentTick is at or past endTick)
        const isRoundFinished = currentTick >= currentRound.endTick
        
        if (isRoundFinished) {
          // Round is finished, show scores from this round (which includes this round's win)
          return {
            tWins: currentRound.tWins ?? 0,
            ctWins: currentRound.ctWins ?? 0
          }
        } else {
          // Round is still in progress, show scores from previous round
          if (currentRoundIdx > 0) {
            const previousRound = allRounds[currentRoundIdx - 1]
            return {
              tWins: previousRound.tWins ?? 0,
              ctWins: previousRound.ctWins ?? 0
            }
          } else {
            // First round, show 0-0
            return { tWins: 0, ctWins: 0 }
          }
        }
      }
    }
    // For single round mode or if we can't find the round, show 0-0
    return { tWins: 0, ctWins: 0 }
  }
  
  const scores = getScores()
  
  // Calculate round time
  const getRoundTime = () => {
    if (!currentRound) {
      return { time: '0:00', isFreezeTime: false }
    }
    
    const roundStart = currentRound.startTick
    const freezeEnd = currentRound.freezeEndTick
    
    // Check if we're in freeze time
    // Only show freeze time if freezeEndTick is set and currentTick is before it
    const isFreezeTime = freezeEnd !== null && freezeEnd > roundStart && currentTick < freezeEnd
    
    // Calculate elapsed time
    let elapsedTicks = 0
    if (isFreezeTime) {
      // During freeze time, show time from round start
      elapsedTicks = Math.max(0, currentTick - roundStart)
    } else if (freezeEnd !== null && freezeEnd > roundStart) {
      // After freeze time, show time from freeze end
      elapsedTicks = Math.max(0, currentTick - freezeEnd)
    } else {
      // No freeze time data, show time from round start
      elapsedTicks = Math.max(0, currentTick - roundStart)
    }
    
    const elapsedSeconds = elapsedTicks / tickrate
    const minutes = Math.floor(elapsedSeconds / 60)
    const seconds = Math.floor(elapsedSeconds % 60)
    
    return {
      time: `${minutes}:${seconds.toString().padStart(2, '0')}`,
      isFreezeTime
    }
  }
  
  const roundTime = getRoundTime()
  
  return (
    <div className="absolute top-4 left-1/2 transform -translate-x-1/2 z-[90] pointer-events-none">
      <div className="bg-black/90 backdrop-blur-sm rounded-lg border border-gray-700 px-4 py-2 flex items-center gap-4">
        {/* Team A Score (T) */}
        <div className="flex items-center gap-2">
          <span className="text-[#ff6b35] font-bold text-lg">T</span>
          <span className="text-white font-semibold text-xl">{scores.tWins}</span>
        </div>
        
        {/* Round Time */}
        <div className="flex flex-col items-center gap-1 px-3 border-l border-r border-gray-700 min-w-[80px]">
          <div className={`font-mono font-semibold text-lg ${roundTime.isFreezeTime ? 'text-yellow-400' : 'text-white'}`}>
            {roundTime.time}
          </div>
          {roundTime.isFreezeTime && (
            <div className="text-yellow-400 text-xs font-semibold uppercase tracking-wide animate-pulse">
              FREEZE TIME
            </div>
          )}
        </div>
        
        {/* Team B Score (CT) */}
        <div className="flex items-center gap-2">
          <span className="text-white font-semibold text-xl">{scores.ctWins}</span>
          <span className="text-[#4a9eff] font-bold text-lg">CT</span>
        </div>
      </div>
    </div>
  )
}

// Killfeed Overlay Component
function KillfeedOverlay({ events, currentTick, allPositions }: { events: Event[], currentTick: number, allPositions: PositionMap }) {
  const tickrate = 64 // CS2 tick rate
  const visibleDuration = 5 // Show kills for 5 seconds
  
  // Debug: log events to see what we're getting (only once when events change)
  useEffect(() => {
    if (events.length > 0) {
      const eventTypes = [...new Set(events.map(e => e.type))]
      console.log('KillfeedOverlay - Total events:', events.length, 'Unique types:', eventTypes)
      
      // Check for events with both actor and victim (likely kills)
      const potentialKills = events.filter(e => e.actorSteamId && e.victimSteamId)
      console.log('KillfeedOverlay - Events with actor+victim:', potentialKills.length)
      if (potentialKills.length > 0) {
        console.log('KillfeedOverlay - Sample potential kills:', potentialKills.slice(0, 3).map(e => ({
          type: e.type,
          tick: e.startTick,
          actor: e.actorSteamId,
          victim: e.victimSteamId
        })))
      }
    } else {
      console.log('KillfeedOverlay - No events received')
    }
  }, [events.length]) // Only log when event count changes
  
  // Get visible kills (within time window)
  const visibleKills = events
    .filter(event => {
      // Check for kill event types (case-insensitive)
      // TEAM_KILL is stored in uppercase, but we should also check for regular kills
      const typeUpper = event.type?.toUpperCase() || ''
      const isKillEvent = typeUpper === 'TEAM_KILL' || 
                         typeUpper === 'KILL' ||
                         typeUpper === 'KILLS'
      
      if (!isKillEvent) {
        return false
      }
      
      // Must have both actor and victim for a valid kill
      if (!event.actorSteamId || !event.victimSteamId) {
        return false
      }
      
      // Only show if kill happened before or at current tick
      if (event.startTick > currentTick) {
        return false
      }
      
      // Check if kill is within visible duration
      const secondsElapsed = (currentTick - event.startTick) / tickrate
      return secondsElapsed < visibleDuration && secondsElapsed >= 0
    })
    .sort((a, b) => b.startTick - a.startTick) // Most recent first
    .slice(0, 5) // Limit to 5 most recent kills
  
  // Helper to get player name from steam ID
  const getPlayerName = (steamId: string | null): string => {
    if (!steamId) return 'Unknown'
    
    // Try to find player name from recent positions
    for (const tickMap of Array.from(allPositions.values()).reverse()) {
      const pos = tickMap.get(steamId)
      if (pos && pos.name) {
        return pos.name
      }
    }
    
    return 'Unknown'
  }
  
  // Helper to get player team from steam ID
  const getPlayerTeam = (steamId: string | null): string | null => {
    if (!steamId) return null
    
    // Try to find player team from recent positions
    for (const tickMap of Array.from(allPositions.values()).reverse()) {
      const pos = tickMap.get(steamId)
      if (pos && pos.team) {
        return pos.team
      }
    }
    
    return null
  }
  
  // Helper to get weapon from event meta
  const getWeapon = (event: Event): string => {
    if (event.meta && event.meta.weapon) {
      return event.meta.weapon
    }
    return 'weapon'
  }
  
  // Don't render if no kills
  if (visibleKills.length === 0) {
    return null
  }
  
  return (
    <div className="absolute top-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none">
      {visibleKills.map((kill, index) => {
        const secondsElapsed = (currentTick - kill.startTick) / tickrate
        const opacity = Math.max(0.3, 1 - (secondsElapsed / visibleDuration))
        
        const killerName = getPlayerName(kill.actorSteamId)
        const victimName = getPlayerName(kill.victimSteamId)
        const killerTeam = getPlayerTeam(kill.actorSteamId)
        const victimTeam = getPlayerTeam(kill.victimSteamId)
        const weapon = getWeapon(kill)
        const isTeamKill = kill.type === 'team_kill'
        
        return (
          <div
            key={`${kill.startTick}-${kill.actorSteamId}-${kill.victimSteamId}`}
            className="bg-black/70 backdrop-blur-sm rounded px-3 py-2 text-sm text-white flex items-center gap-2 min-w-[200px]"
            style={{ opacity }}
          >
            {/* Killer name */}
            <span
              className="font-semibold"
              style={{
                color: killerTeam === 'T' ? '#ff6b35' : killerTeam === 'CT' ? '#4a90e2' : '#ffffff'
              }}
            >
              {killerName}
            </span>
            
            {/* Weapon icon/text */}
            <span className="text-gray-300 text-xs">{weapon}</span>
            
            {/* Victim name */}
            <span
              className="font-semibold"
              style={{
                color: victimTeam === 'T' ? '#ff6b35' : victimTeam === 'CT' ? '#4a90e2' : '#ffffff'
              }}
            >
              {victimName}
            </span>
            
            {/* Team kill indicator */}
            {isTeamKill && (
              <span className="text-red-400 text-xs ml-auto">TK</span>
            )}
          </div>
        )
      })}
    </div>
  )
}

export default Viewer2D
