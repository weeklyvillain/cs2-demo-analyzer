import { useState, useEffect, useMemo } from 'react'
import { AlertCircle, Download, Loader2, X, FolderOpen, CheckCircle, User, ChevronDown, ChevronUp, Settings } from 'lucide-react'

export interface ClipRange {
  id: string
  startTick: number
  endTick: number
  label?: string
  playerName?: string
  playerSteamId?: string
  playerSlot?: number
  eventType?: string
}

interface ClipExportPanelProps {
  demoPath: string
  matchId: string
  incidents: ClipRange[]
  onClose: () => void
}

interface ExportProgress {
  stage: 'validate' | 'launch' | 'load_demo' | 'seek' | 'pov' | 'recording' | 'encode' | 'montage' | 'done'
  currentClipIndex: number
  totalClips: number
  percent: number
  message: string
}

interface PlayerGroup {
  playerName: string
  playerSteamId?: string
  incidents: ClipRange[]
}

export function ClipExportPanel({ demoPath, incidents, onClose }: ClipExportPanelProps) {
  const [selectedClips, setSelectedClips] = useState<Set<string>>(new Set(incidents.map((i) => i.id)))
  const [width, setWidth] = useState(1280)
  const [height, setHeight] = useState(720)
  const [fps, setFps] = useState(60)
  const [timescale, setTimescale] = useState(4)
  const [tickrate, setTickrate] = useState(64)
  const [montageEnabled, setMontageEnabled] = useState(true)
  const [fadeDuration, setFadeDuration] = useState(0.5)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [isExporting, setIsExporting] = useState(false)
  const [progress, setProgress] = useState<ExportProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ clips: string[]; montage?: string } | null>(null)
  const [collapsedPlayers, setCollapsedPlayers] = useState<Set<string>>(new Set())

  // Count only selected clips that exist in current incidents
  const validSelectedCount = useMemo(() => {
    const incidentIds = new Set(incidents.map(i => i.id))
    return Array.from(selectedClips).filter(id => incidentIds.has(id)).length
  }, [selectedClips, incidents])

  // Group incidents by player
  const playerGroups = useMemo<PlayerGroup[]>(() => {
    const groupMap = new Map<string, PlayerGroup>()
    
    incidents.forEach((incident) => {
      const key = incident.playerSteamId || incident.playerName || 'Unknown'
      if (!groupMap.has(key)) {
        groupMap.set(key, {
          playerName: incident.playerName || 'Unknown Player',
          playerSteamId: incident.playerSteamId,
          incidents: [],
        })
      }
      groupMap.get(key)!.incidents.push(incident)
    })
    
    // Sort by player name and then sort incidents within each group by round/tick
    return Array.from(groupMap.values())
      .sort((a, b) => a.playerName.localeCompare(b.playerName))
      .map(group => ({
        ...group,
        incidents: group.incidents.sort((a, b) => a.startTick - b.startTick)
      }))
  }, [incidents])

  const togglePlayerCollapse = (playerKey: string) => {
    setCollapsedPlayers(prev => {
      const next = new Set(prev)
      if (next.has(playerKey)) {
        next.delete(playerKey)
      } else {
        next.add(playerKey)
      }
      return next
    })
  }

  const selectPlayerIncidents = (playerKey: string, select: boolean) => {
    const group = playerGroups.find(g => (g.playerSteamId || g.playerName) === playerKey)
    if (!group) return

    setSelectedClips(prev => {
      const next = new Set(prev)
      group.incidents.forEach(incident => {
        if (select) {
          next.add(incident.id)
        } else {
          next.delete(incident.id)
        }
      })
      return next
    })
  }

  useEffect(() => {
    if (!isExporting) return

    const handleProgress = (data: ExportProgress) => {
      setProgress(data)
    }

    window.electronAPI?.onClipsExportProgress?.(handleProgress)

    return () => {
      // Cleanup listener if needed
    }
  }, [isExporting])

  const handleSelectAll = () => {
    setSelectedClips(new Set(incidents.map((i) => i.id)))
  }

  const handleDeselectAll = () => {
    setSelectedClips(new Set())
  }

  const handleToggleClip = (id: string) => {
    const newSelected = new Set(selectedClips)
    if (newSelected.has(id)) {
      newSelected.delete(id)
    } else {
      newSelected.add(id)
    }
    setSelectedClips(newSelected)
  }

  const handleExport = async () => {
    try {
      setError(null)
      setIsExporting(true)
      setResult(null)

      const clipsToExport = incidents.filter((i) => selectedClips.has(i.id))

      if (clipsToExport.length === 0) {
        throw new Error('Please select at least one clip to export')
      }

      const result = await window.electronAPI?.exportClips?.({
        demoPath,
        clipRanges: clipsToExport,
        width,
        height,
        fps,
        timescale,
        tickrate,
        montageEnabled,
        fadeDuration,
      })

      if (!result?.success) {
        throw new Error(result?.error || 'Export failed for unknown reason')
      }

      setResult({
        clips: result.clips || [],
        montage: result.montage,
      })
      setIsExporting(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
      setIsExporting(false)
    }
  }

  const handleOpenFolder = async (folderPath: string) => {
    try {
      await window.electronAPI?.showItemInFolder?.(folderPath)
    } catch (err) {
      console.error('Failed to open folder:', err)
    }
  }

  if (result && result.clips.length > 0) {
    // Show success screen with result details
    const resultDir = result.clips.length > 0 ? result.clips[0].substring(0, result.clips[0].lastIndexOf('\\')) : ''

    return (
      <div className="p-6 bg-secondary rounded-lg border border-border">
        <div className="flex items-center gap-2 mb-4">
          <CheckCircle size={24} className="text-green-500" />
          <h2 className="text-xl font-bold text-white">Export Complete!</h2>
        </div>

        <div className="space-y-3 mb-6 text-sm">
          <p className="text-gray-400">
            Successfully exported <span className="font-semibold text-white">{result.clips.length}</span> clip(s)
          </p>

          {result.montage && (
            <p className="text-gray-400">
              Created montage: <span className="font-semibold text-white">{result.montage.split('\\').pop()}</span>
            </p>
          )}

          {resultDir && (
            <button
              onClick={() => handleOpenFolder(resultDir)}
              className="flex items-center gap-2 px-3 py-2 bg-accent hover:bg-accent/80 rounded text-sm text-white font-semibold transition-colors"
            >
              <FolderOpen size={16} />
              Open Output Folder
            </button>
          )}
        </div>

        <div className="flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2 bg-surface hover:bg-surface/80 text-white rounded font-semibold transition-colors"
          >
            Close
          </button>
          <button
            onClick={() => {
              setResult(null)
              setSelectedClips(new Set(incidents.map((i) => i.id)))
            }}
            className="flex-1 px-4 py-2 bg-accent hover:bg-accent/80 text-white rounded font-semibold transition-colors"
          >
            Export More
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="p-6 bg-secondary rounded-lg border border-border max-h-[80vh] overflow-y-auto">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold text-white">Export Clips</h2>
        <button onClick={onClose} className="p-1 hover:bg-surface rounded transition-colors text-gray-400 hover:text-white">
          <X size={20} />
        </button>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-900/20 border border-red-700 rounded flex items-center gap-2 text-red-300 text-sm">
          <AlertCircle size={18} />
          {error}
        </div>
      )}
validSelectedCount
      {!isExporting ? (
        <>
          {/* Clip selection */}
          <div className="mb-6">
            <div className="flex items-center justify-between mb-2">
              <h3 className="font-semibold text-white">Select clips to export ({selectedClips.size}/{incidents.length}):</h3>
              <div className="flex gap-2">
                <button
                  onClick={handleSelectAll}
                  className="px-2 py-1 text-xs bg-surface hover:bg-surface/80 text-white rounded font-semibold transition-colors"
                >
                  Select All
                </button>
                <button
                  onClick={handleDeselectAll}
                  className="px-2 py-1 text-xs bg-surface hover:bg-surface/80 text-white rounded font-semibold transition-colors"
                >
                  Clear
                </button>
              </div>
            </div>
            <div className="space-y-2 max-h-96 overflow-y-auto border border-border rounded p-3 bg-primary">
              {incidents.length === 0 ? (
                <p className="text-sm text-gray-400">No incidents available</p>
              ) : (
                playerGroups.map((group) => {
                  const playerKey = group.playerSteamId || group.playerName
                  const isCollapsed = collapsedPlayers.has(playerKey)
                  const selectedCount = group.incidents.filter(i => selectedClips.has(i.id)).length
                  const allSelected = selectedCount === group.incidents.length
                  const someSelected = selectedCount > 0 && selectedCount < group.incidents.length

                  return (
                    <div key={playerKey} className="border border-border rounded bg-secondary">
                      {/* Player Header */}
                      <div className="flex items-center gap-2 p-2 bg-surface/50">
                        <button
                          onClick={() => togglePlayerCollapse(playerKey)}
                          className="p-1 hover:bg-surface rounded transition-colors text-gray-400 hover:text-white"
                        >
                          {isCollapsed ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
                        </button>
                        <User size={16} className="text-gray-400" />
                        <span className="flex-1 font-semibold text-white text-sm">
                          {group.playerName} <span className="text-gray-400 font-normal">({group.incidents.length} incident{group.incidents.length !== 1 ? 's' : ''})</span>
                        </span>
                        <button
                          onClick={() => selectPlayerIncidents(playerKey, !allSelected)}
                          className="px-2 py-0.5 text-xs bg-surface hover:bg-surface/80 text-white rounded transition-colors"
                        >
                          {allSelected ? 'Deselect All' : someSelected ? 'Select All' : 'Select All'}
                        </button>
                      </div>

                      {/* Incidents */}
                      {!isCollapsed && (
                        <div className="space-y-1 p-2">
                          {group.incidents.map((incident) => (
                            <label key={incident.id} className="flex items-center gap-2 cursor-pointer hover:bg-surface/50 p-2 rounded transition-colors">
                              <input
                                type="checkbox"
                                checked={selectedClips.has(incident.id)}
                                onChange={() => handleToggleClip(incident.id)}
                                className="w-4 h-4 rounded"
                              />
                              <span className="flex-1 text-sm">
                                <span className="font-semibold text-white">{incident.label || incident.eventType || 'Unknown Event'}</span>
                                <br />
                                <span className="text-xs text-gray-400">
                                  Tick {incident.startTick}-{incident.endTick}
                                </span>
                              </span>
                            </label>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })
              )}
            </div>
          </div>

          {/* Settings */}
          <div className="space-y-4 mb-6 border-t border-border pt-4">
            <div>
              <label className="block text-sm font-semibold text-white mb-2">Resolution:</label>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Width</label>
                  <input
                    type="number"
                    value={width}
                    onChange={(e) => setWidth(parseInt(e.target.value) || 1280)}
                    min={640}
                    max={3840}
                    step={16}
                    className="w-full px-3 py-2 bg-surface border border-border rounded text-white text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Height</label>
                  <input
                    type="number"
                    value={height}
                    onChange={(e) => setHeight(parseInt(e.target.value) || 720)}
                    min={480}
                    max={2160}
                    step={16}
                    className="w-full px-3 py-2 bg-surface border border-border rounded text-white text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                  />
                </div>
              </div>
              <p className="text-xs text-gray-400 mt-1">
                Common: 1280x720 (720p), 1920x1080 (1080p), 2560x1440 (1440p)
              </p>
            </div>

            <div>
              <label className="block text-sm font-semibold text-white mb-2">
                Recording Speed: {timescale}x
              </label>
              <input
                type="range"
                min="1"
                max="16"
                step="1"
                value={timescale}
                onChange={(e) => setTimescale(Number(e.target.value))}
                className="w-full"
              />
              <p className="text-xs text-gray-400 mt-1">
                Higher = faster recording (final output will be normal speed)
              </p>
            </div>

            {/* Advanced Settings Toggle */}
            <button
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="flex items-center gap-2 text-sm text-gray-400 hover:text-white transition-colors"
            >
              <Settings size={16} />
              {showAdvanced ? 'Hide' : 'Show'} Advanced Settings
              {showAdvanced ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </button>

            {showAdvanced && (
              <div className="space-y-4 pl-4 border-l-2 border-accent/30">
                <div>
                  <label className="block text-sm font-semibold text-white mb-2">FPS:</label>
                  <input
                    type="number"
                    value={fps}
                    onChange={(e) => setFps(parseInt(e.target.value) || 60)}
                    min={30}
                    max={240}
                    className="w-full px-3 py-2 bg-surface border border-border rounded text-white text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                  />
                  <p className="text-xs text-gray-400 mt-1">Frames per second (typically 60)</p>
                </div>

                <div>
                  <label className="block text-sm font-semibold text-white mb-2">Tickrate:</label>
                  <input
                    type="number"
                    value={tickrate}
                    onChange={(e) => setTickrate(parseInt(e.target.value) || 64)}
                    min={16}
                    max={128}
                    className="w-full px-3 py-2 bg-surface border border-border rounded text-white text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                  />
                  <p className="text-xs text-gray-400 mt-1">Server tickrate (typically 64 or 128)</p>
                </div>
              </div>
            )}

            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="montageEnabled"
                checked={montageEnabled}
                onChange={(e) => setMontageEnabled(e.target.checked)}
                className="w-4 h-4 rounded"
              />
              <label htmlFor="montageEnabled" className="text-sm text-white">
                Create montage (combine all clips)
              </label>
            </div>

            {montageEnabled && (
              <div>
                <label className="block text-sm font-semibold text-white mb-2">
                  Fade Duration: {fadeDuration.toFixed(1)}s
                </label>
                <input
                  type="range"
                  min="0"
                  max="2"
                  step="0.1"
                  value={fadeDuration}
                  onChange={(e) => setFadeDuration(Number(e.target.value))}
                  className="w-full"
                />
              </div>
            )}
          </div>

          {/* Export button */}
          <div className="flex gap-2">
            <button
              onClick={handleExport}
              disabled={validSelectedCount === 0}
              className="flex-1 px-4 py-2 bg-accent hover:bg-accent/80 disabled:bg-surface disabled:cursor-not-allowed disabled:text-gray-500 text-white rounded font-semibold flex items-center justify-center gap-2 transition-colors"
            >
              <Download size={18} />
              Export {validSelectedCount} Clip(s)
            </button>
            <button onClick={onClose} className="px-4 py-2 bg-surface hover:bg-surface/80 text-white rounded font-semibold transition-colors">
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          {/* Progress display */}
          <div className="space-y-4">
            <div className="flex items-center gap-2 mb-4">
              <Loader2 size={20} className="animate-spin text-accent" />
              <span className="font-semibold text-white">
                {progress?.stage.replace(/_/g, ' ').toUpperCase()}
              </span>
            </div>

            <div className="text-sm text-gray-300 mb-2">{progress?.message}</div>

            <div className="w-full bg-surface rounded-full h-3 overflow-hidden">
              <div
                className="bg-accent h-full transition-all duration-300"
                style={{ width: `${Math.min(progress?.percent || 0, 100)}%` }}
              />
            </div>

            <div className="flex items-center justify-between text-xs text-gray-400">
              <span>
                Clip {progress?.currentClipIndex || 0}/{progress?.totalClips || 0}
              </span>
              <span className="font-semibold text-accent">{progress?.percent.toFixed(0)}%</span>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
