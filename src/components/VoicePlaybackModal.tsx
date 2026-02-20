import { useState, useEffect, useRef } from 'react'
import { X, Play, Pause, Volume2, Download, Gauge, Loader2 } from 'lucide-react'
import Modal from './Modal'

type VoiceExtractionMode = 'split-compact' | 'split-full' | 'single-full'
type ModalState = 'extracting' | 'playback'

interface VoicePlaybackModalProps {
  isOpen: boolean
  onClose: () => void
  demoPath: string | null
  playerSteamId: string
  playerName: string
  audioFiles?: Array<{ path: string; name: string; steamId?: string; playerName?: string }>
  outputPath?: string
  onCleanup?: () => void
}

export default function VoicePlaybackModal({
  isOpen,
  onClose,
  demoPath,
  playerSteamId,
  playerName,
  audioFiles: initialAudioFiles,
  outputPath: initialOutputPath,
  onCleanup,
}: VoicePlaybackModalProps) {
  const [modalState, setModalState] = useState<ModalState>('extracting')
  const [audioFiles, setAudioFiles] = useState<Array<{ path: string; name: string; steamId?: string; playerName?: string }>>(initialAudioFiles || [])
  const [outputPath, setOutputPath] = useState<string | null>(initialOutputPath || null)
  const [extractionLogs, setExtractionLogs] = useState<string[]>([])
  const [extractionError, setExtractionError] = useState<string | null>(null)
  
  const [selectedFileIndex, setSelectedFileIndex] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolume] = useState(1)
  const [playbackRate, setPlaybackRate] = useState(1)
  const [skipTime, setSkipTime] = useState(10) // Default 10 seconds (will be loaded from settings)
  const [waveformUrl, setWaveformUrl] = useState<string | null>(null)
  const [waveformLoading, setWaveformLoading] = useState(false)
  const [waveformMetadata, setWaveformMetadata] = useState<{ pixelsPerSecond: number; actualWidth: number } | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const gainNodeRef = useRef<GainNode | null>(null)
  const sourceRef = useRef<MediaElementAudioSourceNode | null>(null)
  const logsEndRef = useRef<HTMLDivElement | null>(null)
  const waveformContainerRef = useRef<HTMLDivElement | null>(null)

  const selectedFile = audioFiles[selectedFileIndex]

  // Create object URL for selected audio file
  const [audioUrl, setAudioUrl] = useState<string | null>(null)

  // Load skip time from settings when modal opens
  useEffect(() => {
    if (!isOpen || !window.electronAPI) return
    
    const loadSkipTime = async () => {
      try {
        const skipTimeSetting = await window.electronAPI.getSetting('voice_skip_time', '10')
        const skipTimeValue = parseFloat(skipTimeSetting)
        if (!isNaN(skipTimeValue) && skipTimeValue > 0) {
          setSkipTime(skipTimeValue)
        }
      } catch (error) {
        console.error('Failed to load voice skip time setting:', error)
      }
    }
    
    loadSkipTime()
  }, [isOpen])

  // Reset state and start extraction when modal opens
  const extractionStartedRef = useRef(false)
  useEffect(() => {
    if (!isOpen) {
      extractionStartedRef.current = false
      return
    }

    // If we already have audio files, go to playback
    if (initialAudioFiles && initialAudioFiles.length > 0) {
      setModalState('playback')
      setAudioFiles(initialAudioFiles)
      setOutputPath(initialOutputPath || null)
      extractionStartedRef.current = true
      return
    }

    // Prevent multiple extractions
    if (extractionStartedRef.current) return

    // Otherwise, start extraction immediately with split-compact mode
    if (!demoPath || !playerSteamId || !window.electronAPI) {
      setModalState('extracting')
      setExtractionError('Demo path or player information not available')
      extractionStartedRef.current = true
      return
    }

    // Start extraction with split-compact mode
    extractionStartedRef.current = true
    setModalState('extracting')
    setExtractionLogs([])
    setExtractionError(null)

    const startExtraction = async () => {
      try {
        const result = await window.electronAPI.extractVoice({
          demoPath,
          mode: 'split-compact',
          steamIds: [playerSteamId],
        })

        const rawFiles = result.filePaths || (result.files || []).map((f: string) => `${result.outputPath}/${f}`)
        const extractedFiles = rawFiles.map((filePath: string, index: number) => {
          const fullPath = filePath.replace(/\\/g, '/')
          const fileList = result.files || []
          const fileName = fileList[index] || fullPath.split('/').pop() || fullPath.split('\\').pop() || 'audio.wav'
          return {
            path: fullPath,
            name: fileName,
            steamId: playerSteamId,
            playerName: playerName,
          }
        })

        // Check if any files were extracted
        if (extractedFiles.length === 0) {
          // No files found - show info state (not an error)
          setModalState('playback')
          setAudioFiles([])
          setOutputPath(result.outputPath)
        } else {
          setAudioFiles(extractedFiles)
          setOutputPath(result.outputPath)
          setModalState('playback')
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Failed to extract voice'
        // Treat "no voice data" as info, not error (e.g. extractor exit code when nothing found)
        const isNoData =
          /no voice|no data|not found|0 file|no file|nothing to extract|exit code 1/i.test(errorMessage) ||
          /no voice data|no audio/i.test(errorMessage)
        if (isNoData) {
          setModalState('playback')
          setAudioFiles([])
          setOutputPath(null)
        } else {
          setExtractionError(errorMessage)
        }
      }
    }

    startExtraction()
  }, [isOpen])

  // Scroll logs to bottom
  useEffect(() => {
    if (logsEndRef.current && modalState === 'extracting') {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [extractionLogs, modalState])

  // Set up voice extraction log listener
  useEffect(() => {
    if (!window.electronAPI || modalState !== 'extracting') return

    const handleVoiceLog = (log: string) => {
      setExtractionLogs(prev => [...prev.slice(-50), log])
    }

    window.electronAPI.onVoiceExtractionLog(handleVoiceLog)

    return () => {
      window.electronAPI.removeAllListeners('voice:extractionLog')
    }
  }, [modalState])

  // Generate waveform when audio file is selected
  useEffect(() => {
    if (!selectedFile || !isOpen || modalState !== 'playback') {
      setWaveformUrl(null)
      setWaveformMetadata(null)
      return
    }

    let mounted = true
    setWaveformLoading(true)

    const generateWaveform = async () => {
      try {
        // Pass duration if available to help with alignment
        const result = await window.electronAPI.generateWaveform(selectedFile.path, duration > 0 ? duration : undefined)
        if (result.success && result.data && mounted) {
          setWaveformUrl(result.data)
          // Store metadata for proper alignment
          if (result.pixelsPerSecond && result.actualWidth) {
            setWaveformMetadata({
              pixelsPerSecond: result.pixelsPerSecond,
              actualWidth: result.actualWidth,
            })
          }
        } else if (mounted) {
          console.warn('Failed to generate waveform:', result.error)
          setWaveformUrl(null)
          setWaveformMetadata(null)
        }
      } catch (error) {
        console.error('Error generating waveform:', error)
        if (mounted) {
          setWaveformUrl(null)
          setWaveformMetadata(null)
        }
      } finally {
        if (mounted) {
          setWaveformLoading(false)
        }
      }
    }

    generateWaveform()

    return () => {
      mounted = false
    }
  }, [selectedFile, isOpen, modalState, selectedFileIndex, duration])

  useEffect(() => {
    let mounted = true
    
    const loadAudio = async () => {
      if (!selectedFile || !isOpen) return
      
      // Reset playback state
      setIsPlaying(false)
      setCurrentTime(0)
      setDuration(0)
      setAudioUrl(null)
      
      // Load audio file via IPC to avoid file:// protocol issues
      if (window.electronAPI?.getVoiceAudio) {
        try {
          const result = await window.electronAPI.getVoiceAudio(selectedFile.path)
          if (result.success && result.data && mounted) {
            setAudioUrl(result.data) // This is a data URL like data:audio/wav;base64,...
          } else if (!mounted) {
            console.warn('Component unmounted before audio loaded')
          }
        } catch (error) {
          console.error('Failed to load audio file:', error)
          if (mounted) {
            setAudioUrl(null)
          }
        }
      } else {
        // Fallback: try file:// URL (might not work due to security)
        const fileUrl = `file://${selectedFile.path.replace(/\\/g, '/')}`
        setAudioUrl(fileUrl)
      }
    }
    
    loadAudio()

    return () => {
      mounted = false
      // Cleanup: revoke object URL when component unmounts or file changes
      if (audioUrl && audioUrl.startsWith('blob:')) {
        URL.revokeObjectURL(audioUrl)
      }
    }
  }, [selectedFile, isOpen])

  // Set up Web Audio API for volume boost above 100%
  useEffect(() => {
    if (!audioRef.current || !audioUrl) return

    const audio = audioRef.current
    
    // Clean up existing source before creating a new one
    if (sourceRef.current) {
      try {
        sourceRef.current.disconnect()
      } catch (e) {}
      sourceRef.current = null
    }
    if (gainNodeRef.current) {
      try {
        gainNodeRef.current.disconnect()
      } catch (e) {}
      gainNodeRef.current = null
    }
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      audioContextRef.current.close().catch(console.error)
      audioContextRef.current = null
    }

    let audioContext: AudioContext | null = null
    let gainNode: GainNode | null = null
    let source: MediaElementAudioSourceNode | null = null

    try {
      // Create AudioContext if needed
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext
      if (AudioContextClass) {
        audioContext = new AudioContextClass()
        gainNode = audioContext.createGain()
        source = audioContext.createMediaElementSource(audio)
        
        // Connect: source -> gain -> destination
        source.connect(gainNode)
        gainNode.connect(audioContext.destination)
        
        // Store refs
        audioContextRef.current = audioContext
        gainNodeRef.current = gainNode
        sourceRef.current = source
        
        // Set initial volume
        if (gainNode) {
          gainNode.gain.value = volume
        }
      }
    } catch (error) {
      console.warn('Web Audio API not available, falling back to HTML5 audio:', error)
    }

    return () => {
      // Cleanup Web Audio API
      if (source) {
        try {
          source.disconnect()
        } catch (e) {}
      }
      if (gainNode) {
        try {
          gainNode.disconnect()
        } catch (e) {}
      }
      if (audioContext && audioContext.state !== 'closed') {
        audioContext.close().catch(console.error)
      }
      audioContextRef.current = null
      gainNodeRef.current = null
      sourceRef.current = null
    }
  }, [audioUrl])

  // Update volume on gain node when volume state changes
  useEffect(() => {
    if (gainNodeRef.current) {
      gainNodeRef.current.gain.value = volume
    } else if (audioRef.current) {
      // Fallback: clamp to 0-1 for HTML5 audio element
      audioRef.current.volume = Math.min(volume, 1.0)
    }
  }, [volume])

  // Update playback rate when playbackRate state changes
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.playbackRate = playbackRate
    }
  }, [playbackRate])

  // Update duration when audio metadata loads
  const handleLoadedMetadata = () => {
    if (audioRef.current) {
      setDuration(audioRef.current.duration)
      // Set initial playback rate
      audioRef.current.playbackRate = playbackRate
    }
  }

  // Update current time during playback
  const handleTimeUpdate = () => {
    if (audioRef.current) {
      setCurrentTime(audioRef.current.currentTime)
    }
  }

  // Handle play/pause
  const togglePlayback = () => {
    if (audioRef.current) {
      if (isPlaying) {
        audioRef.current.pause()
      } else {
        audioRef.current.play()
      }
      setIsPlaying(!isPlaying)
    }
  }

  // Spacebar play/pause
  useEffect(() => {
    if (!isOpen || modalState !== 'playback') return

    const handleKeyDown = (event: KeyboardEvent) => {
      const isSpace = event.code === 'Space' || event.key === ' '
      const isArrowLeft = event.code === 'ArrowLeft' || event.key === 'ArrowLeft'
      const isArrowRight = event.code === 'ArrowRight' || event.key === 'ArrowRight'
      const isArrowUp = event.code === 'ArrowUp' || event.key === 'ArrowUp'
      const isArrowDown = event.code === 'ArrowDown' || event.key === 'ArrowDown'
      if (!isSpace && !isArrowLeft && !isArrowRight && !isArrowUp && !isArrowDown) return

      const target = event.target as HTMLElement | null
      const isInputTarget =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)

      if (isInputTarget) return

      event.preventDefault()

      if (!audioRef.current) return

      if (isSpace) {
        if (audioRef.current.paused) {
          audioRef.current.play()
          setIsPlaying(true)
        } else {
          audioRef.current.pause()
          setIsPlaying(false)
        }
        return
      }

      const volumeStep = 0.05

      if (isArrowUp) {
        setVolume(prev => Math.min(2, Math.round((prev + volumeStep) * 100) / 100))
        return
      }

      if (isArrowDown) {
        setVolume(prev => Math.max(0, Math.round((prev - volumeStep) * 100) / 100))
        return
      }

      if (duration <= 0) return

      if (isArrowLeft) {
        const newTime = Math.max(0, audioRef.current.currentTime - skipTime)
        audioRef.current.currentTime = newTime
        setCurrentTime(newTime)
      }

      if (isArrowRight) {
        const newTime = Math.min(duration, audioRef.current.currentTime + skipTime)
        audioRef.current.currentTime = newTime
        setCurrentTime(newTime)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen, modalState])

  // Handle skip backward
  const handleSkipBackward = () => {
    if (audioRef.current) {
      const newTime = Math.max(0, currentTime - skipTime)
      audioRef.current.currentTime = newTime
      setCurrentTime(newTime)
    }
  }

  // Handle skip forward
  const handleSkipForward = () => {
    if (audioRef.current && duration > 0) {
      const newTime = Math.min(duration, currentTime + skipTime)
      audioRef.current.currentTime = newTime
      setCurrentTime(newTime)
    }
  }

  // Handle volume change (0 to 2.0 = 0% to 200%)
  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newVolume = parseFloat(e.target.value)
    setVolume(newVolume)
    // Volume update is handled by useEffect above
  }

  // Handle playback rate change (0.5x to 2.0x)
  const handlePlaybackRateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newRate = parseFloat(e.target.value)
    setPlaybackRate(newRate)
    // Playback rate is synced via useEffect above
  }

  // Handle progress bar click
  const handleProgressClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (audioRef.current && duration > 0) {
      const rect = e.currentTarget.getBoundingClientRect()
      const x = e.clientX - rect.left
      const percentage = x / rect.width
      const newTime = percentage * duration
      audioRef.current.currentTime = newTime
      setCurrentTime(newTime)
    }
  }

  // Format time in MM:SS
  const formatTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  // Handle download/save - show file in folder
  const handleDownload = async () => {
    if (selectedFile && window.electronAPI?.showFileInFolder) {
      try {
        await window.electronAPI.showFileInFolder(selectedFile.path)
      } catch (error) {
        console.error('Failed to show file in folder:', error)
      }
    }
  }

  // Cleanup when modal closes
  const handleClose = async () => {
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current = null
    }
    setIsPlaying(false)
    setCurrentTime(0)
    
    // Cleanup temp files if outputPath exists
    if (outputPath && window.electronAPI?.cleanupVoiceFiles) {
      try {
        await window.electronAPI.cleanupVoiceFiles(outputPath)
      } catch (error) {
        console.error('Failed to cleanup voice files:', error)
      }
    }
    
    if (onCleanup) {
      onCleanup()
    }
    onClose()
  }

  const progressPercentage = duration > 0 ? (currentTime / duration) * 100 : 0

  // Get modal title based on state
  const getModalTitle = () => {
    switch (modalState) {
      case 'extracting':
        return 'Extracting Voice...'
      case 'playback':
        return 'Voice Playback'
      default:
        return 'Voice Playback'
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title={getModalTitle()}
      size="lg"
      canClose={modalState === 'playback' || (modalState === 'extracting' && extractionError !== null)}
    >
      <div className="space-y-4">
        {/* Extracting Screen */}
        {modalState === 'extracting' && (
          <div className="space-y-4">
            <div className="flex flex-col items-center justify-center py-8">
              <Loader2 className="w-12 h-12 animate-spin text-accent mb-4" />
              <p className="text-lg font-semibold text-white mb-2">Extracting voice data...</p>
              <p className="text-sm text-gray-400">This may take a few moments.</p>
            </div>

            {extractionLogs.length > 0 && (
              <div className="bg-surface/50 border border-border rounded p-4 max-h-64 overflow-y-auto">
                <div className="text-xs font-mono text-gray-400 space-y-1">
                  {extractionLogs.map((log, index) => (
                    <div key={index}>{log}</div>
                  ))}
                  <div ref={logsEndRef} />
                </div>
              </div>
            )}

            {extractionError && (
              <div className="bg-red-900/20 border border-red-500/50 rounded p-4">
                <p className="text-red-400 font-semibold mb-1">Extraction Error</p>
                <p className="text-red-300 text-sm mb-4">{extractionError}</p>
                <button
                  onClick={handleClose}
                  className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded transition-colors text-sm font-medium"
                >
                  Close
                </button>
              </div>
            )}
          </div>
        )}

        {/* Playback Screen */}
        {modalState === 'playback' && (
          <div className="space-y-4">
            {audioFiles.length === 0 ? (
              <div className="bg-blue-900/20 border border-blue-500/50 rounded p-4">
                <p className="text-blue-400 font-semibold mb-1">No voice data found</p>
                <p className="text-blue-300 text-sm">
                  There was no audio found for: {playerName}
                </p>
              </div>
            ) : (
              <>
                {/* File selector */}
                {audioFiles.length > 1 && (
                  <div>
                    <label className="block text-sm font-medium text-gray-300 mb-2">
                      Select Player Voice:
                    </label>
                    <select
                      value={selectedFileIndex}
                      onChange={(e) => {
                        if (audioRef.current) {
                          audioRef.current.pause()
                          setIsPlaying(false)
                        }
                        setSelectedFileIndex(parseInt(e.target.value))
                      }}
                      className="w-full px-3 py-2 bg-secondary border border-border rounded text-white text-sm focus:outline-none focus:ring-1 focus:ring-accent"
                    >
                      {audioFiles.map((file, index) => (
                        <option key={index} value={index}>
                          {file.playerName || file.steamId || file.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                {/* Audio player */}
                {!audioUrl ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="w-6 h-6 animate-spin text-accent mr-2" />
                    <span className="text-gray-400">Loading audio...</span>
                  </div>
                ) : selectedFile ? (
                  <div className="space-y-3">
                    <div className="bg-surface/50 border border-border rounded p-4">
                      {/* Waveform visualization with progress overlay */}
                      <div className="mb-3 relative overflow-hidden rounded" style={{ width: '600px', height: '150px' }}>
                        {waveformLoading ? (
                          <div className="flex items-center justify-center" style={{ width: '600px', height: '150px' }}>
                            <Loader2 className="w-6 h-6 animate-spin text-accent mr-2" />
                            <span className="text-gray-400 text-sm">Generating waveform...</span>
                          </div>
                        ) : waveformUrl ? (
                          <div 
                            ref={waveformContainerRef}
                            className="relative cursor-pointer overflow-hidden"
                            style={{ width: '600px', height: '150px' }}
                            onClick={(e) => {
                              if (audioRef.current && duration > 0 && waveformContainerRef.current) {
                                const rect = waveformContainerRef.current.getBoundingClientRect()
                                const x = e.clientX - rect.left
                                
                                // Use actual waveform width for accurate time calculation
                                let timePosition = 0
                                if (waveformMetadata && waveformMetadata.actualWidth > 0) {
                                  // Calculate time based on actual waveform pixels
                                  const pixelsPerSecond = waveformMetadata.pixelsPerSecond
                                  const scale = rect.width / waveformMetadata.actualWidth
                                  const waveformX = x / scale
                                  timePosition = waveformX / pixelsPerSecond
                                } else {
                                  // Fallback to percentage-based calculation
                                  const percentage = x / rect.width
                                  timePosition = percentage * duration
                                }
                                
                                const newTime = Math.max(0, Math.min(duration, timePosition))
                                audioRef.current.currentTime = newTime
                                setCurrentTime(newTime)
                              }
                            }}
                          >
                            <img 
                              src={waveformUrl} 
                              alt="Waveform" 
                              className="block"
                              style={{ 
                                width: '600px',
                                height: '150px',
                                objectFit: 'contain',
                                display: 'block'
                              }}
                            />
                            {/* Progress overlay */}
                            {duration > 0 && waveformMetadata && waveformMetadata.actualWidth > 0 && (
                              <>
                                {/* Progress line - calculated based on actual waveform width */}
                                <div
                                  className="absolute top-0 bottom-0 w-0.5 bg-accent z-10 pointer-events-none"
                                  style={{
                                    left: `${(currentTime * waveformMetadata.pixelsPerSecond / waveformMetadata.actualWidth) * 100}%`,
                                  }}
                                />
                                {/* Progress fill overlay (darker area for played portion) */}
                                <div
                                  className="absolute top-0 bottom-0 bg-black/30 z-0 pointer-events-none"
                                  style={{
                                    left: '0%',
                                    width: `${(currentTime * waveformMetadata.pixelsPerSecond / waveformMetadata.actualWidth) * 100}%`,
                                  }}
                                />
                              </>
                            )}
                            {/* Fallback progress if metadata not available */}
                            {duration > 0 && (!waveformMetadata || waveformMetadata.actualWidth === 0) && (
                              <>
                                {/* Progress line */}
                                <div
                                  className="absolute top-0 bottom-0 w-0.5 bg-accent z-10 pointer-events-none"
                                  style={{
                                    left: `${(currentTime / duration) * 100}%`,
                                  }}
                                />
                                {/* Progress fill overlay (darker area for played portion) */}
                                <div
                                  className="absolute top-0 bottom-0 bg-black/30 z-0 pointer-events-none"
                                  style={{
                                    left: '0%',
                                    width: `${(currentTime / duration) * 100}%`,
                                  }}
                                />
                              </>
                            )}
                          </div>
                        ) : (
                          /* Fallback progress slider */
                          <input
                            type="range"
                            min="0"
                            max={duration || 100}
                            step="0.1"
                            value={currentTime}
                            onChange={(e) => {
                              const newTime = parseFloat(e.target.value)
                              if (audioRef.current) {
                                audioRef.current.currentTime = newTime
                                setCurrentTime(newTime)
                              }
                            }}
                            className="w-full h-1.5 bg-secondary rounded-lg appearance-none cursor-pointer accent-accent"
                          />
                        )}
                      </div>

                      {/* Time display and controls */}
                      <div className="flex items-center justify-between mb-4">
                        <span className="text-xs text-gray-400">
                          {formatTime(currentTime)} / {formatTime(duration)}
                        </span>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={handleSkipBackward}
                            className="px-3 py-1.5 bg-secondary hover:bg-surface text-white rounded text-sm font-medium transition-colors"
                            aria-label={`Skip backward ${skipTime}s`}
                            title={`Skip backward ${skipTime}s`}
                          >
                            -{skipTime}s
                          </button>
                          <button
                            onClick={togglePlayback}
                            className="p-2 bg-accent hover:bg-accent/90 text-white rounded transition-colors"
                            aria-label={isPlaying ? 'Pause' : 'Play'}
                          >
                            {isPlaying ? <Pause size={20} /> : <Play size={20} />}
                          </button>
                          <button
                            onClick={handleSkipForward}
                            className="px-3 py-1.5 bg-secondary hover:bg-surface text-white rounded text-sm font-medium transition-colors"
                            aria-label={`Skip forward ${skipTime}s`}
                            title={`Skip forward ${skipTime}s`}
                          >
                            +{skipTime}s
                          </button>
                          <button
                            onClick={handleDownload}
                            className="p-2 bg-secondary hover:bg-surface text-white rounded transition-colors"
                            aria-label="Download"
                          >
                            <Download size={18} />
                          </button>
                        </div>
                      </div>

                      {/* Volume and speed controls on same row */}
                      <div className="grid grid-cols-2 gap-4">
                        {/* Volume control (0% to 200%) */}
                        <div className="flex items-center gap-3">
                          <Volume2 className="text-gray-400" size={18} />
                          <input
                            type="range"
                            min="0"
                            max="2"
                            step="0.05"
                            value={volume}
                            onChange={handleVolumeChange}
                            className="flex-1 h-1.5 bg-secondary rounded-lg appearance-none cursor-pointer accent-accent"
                          />
                          <span className="text-xs text-gray-400 w-10 text-right">
                            {Math.round(volume * 100)}%
                          </span>
                        </div>

                        {/* Playback speed control (0.5x to 2.0x) */}
                        <div className="flex items-center gap-3">
                          <Gauge className="text-gray-400" size={18} />
                          <input
                            type="range"
                            min="0.5"
                            max="2"
                            step="0.1"
                            value={playbackRate}
                            onChange={handlePlaybackRateChange}
                            className="flex-1 h-1.5 bg-secondary rounded-lg appearance-none cursor-pointer accent-accent"
                          />
                          <span className="text-xs text-gray-400 w-10 text-right">
                            {playbackRate.toFixed(1)}x
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Hidden audio element (kept for Web Audio API volume boost) */}
                    <audio
                      ref={audioRef}
                      src={audioUrl}
                      onLoadedMetadata={handleLoadedMetadata}
                      onTimeUpdate={handleTimeUpdate}
                      onEnded={() => setIsPlaying(false)}
                      onPlay={() => setIsPlaying(true)}
                      onPause={() => setIsPlaying(false)}
                    />
                  </div>
                ) : null}

                {/* File info */}
                {selectedFile && (
                  <div className="text-xs text-gray-400 space-y-1">
                    <div>File: {selectedFile.name}</div>
                    {selectedFile.playerName && <div>Player: {selectedFile.playerName}</div>}
                    {selectedFile.steamId && (
                      <div>
                        Steam ID:{' '}
                        <button
                          onClick={async () => {
                            if (window.electronAPI?.openExternal) {
                              await window.electronAPI.openExternal(`https://steamcommunity.com/profiles/${selectedFile.steamId}`)
                            } else {
                              window.open(`https://steamcommunity.com/profiles/${selectedFile.steamId}`, '_blank')
                            }
                          }}
                          className="text-accent hover:text-accent/80 underline bg-transparent border-none cursor-pointer p-0"
                        >
                          {selectedFile.steamId}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}
