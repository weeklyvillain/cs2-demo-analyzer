import { useState, useEffect, useRef, useCallback } from 'react'
import { X, Play, Pause, Volume2, Download, Gauge, Loader2 } from 'lucide-react'
import Modal from './Modal'
import {
  dataUrlToArrayBuffer,
  computeRmsAmplitudes,
  computeNumBars,
  computeScrollState,
  canvasXToTime,
  drawWaveform,
  BAR_STRIDE,
} from '../utils/waveformUtils'

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
  const [playbackError, setPlaybackError] = useState<string | null>(null)
  
  const [selectedFileIndex, setSelectedFileIndex] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolume] = useState(1)
  const [playbackRate, setPlaybackRate] = useState(1)
  const [skipTime, setSkipTime] = useState(10) // Default 10 seconds (will be loaded from settings)
  const [amplitudes, setAmplitudes] = useState<Float32Array | null>(null)
  const [audioDuration, setAudioDuration] = useState(0)
  const [displayWidth, setDisplayWidth] = useState(0)
  const [numBars, setNumBars] = useState(0)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const gainNodeRef = useRef<GainNode | null>(null)
  const sourceRef = useRef<MediaElementAudioSourceNode | null>(null)
  const logsEndRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const canvasContainerRef = useRef<HTMLDivElement | null>(null)

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
      setPlaybackError(null)
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
        console.error('[VoicePlaybackModal] Extraction error:', errorMessage)
        // Only treat as "no voice data" when the extractor explicitly reports it
        const isNoData =
          /no voice|no data|no voice data|no audio|nothing to extract|0 file|no file/i.test(errorMessage)
        if (isNoData) {
          setModalState('playback')
          setAudioFiles([])
          setOutputPath(null)
        } else {
          // Real extraction error — go to playback so the modal can be closed,
          // but show an error banner instead of the "no voice" message
          setModalState('playback')
          setAudioFiles([])
          setOutputPath(null)
          setPlaybackError('Voice extraction failed. Check the application logs for details.')
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

  // Decode audio data and compute RMS amplitudes when the data URL is ready.
  // Sets audioDuration from audioBuffer.duration — the single source of truth for all time math.
  useEffect(() => {
    if (!audioUrl || !isOpen) {
      setAmplitudes(null)
      setAudioDuration(0)
      setNumBars(0)
      return
    }

    let cancelled = false

    const decode = async () => {
      try {
        const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext
        if (!AudioContextClass) return

        const arrayBuffer = dataUrlToArrayBuffer(audioUrl)
        const ctx = new AudioContextClass()
        const audioBuffer = await ctx.decodeAudioData(arrayBuffer)
        await ctx.close()

        if (cancelled) return

        const channelData = audioBuffer.getChannelData(0)
        const dur = audioBuffer.duration
        // displayWidth may be 0 on first run; computeNumBars handles that gracefully
        const bars = computeNumBars(dur, displayWidth || 400)
        const rms = computeRmsAmplitudes(channelData, bars)

        setAudioDuration(dur)
        setNumBars(bars)
        setAmplitudes(rms)
        // Override duration state so time display uses audioBuffer duration
        setDuration(dur)
      } catch (err) {
        console.error('[VoicePlaybackModal] decodeAudioData failed:', err)
      }
    }

    decode()
    return () => { cancelled = true }
  }, [audioUrl, isOpen])

  // Measure the canvas container so waveform bars fill the available width.
  // Recomputes numBars when the container resizes.
  useEffect(() => {
    const container = canvasContainerRef.current
    if (!container) return

    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0
      if (width > 0) {
        setDisplayWidth(width)
        if (audioDuration > 0) {
          const bars = computeNumBars(audioDuration, width)
          setNumBars(bars)
        }
      }
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [audioDuration])

  // Redraw the waveform canvas whenever playback position or waveform data changes.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !amplitudes || numBars === 0 || displayWidth === 0 || audioDuration <= 0) return

    // Keep canvas pixel size in sync with display size
    if (canvas.width !== displayWidth) canvas.width = displayWidth

    const { scrollX, playheadPx, playedBarIndex } = computeScrollState(
      currentTime,
      audioDuration,
      numBars,
      displayWidth,
    )
    drawWaveform(canvas, amplitudes, scrollX, playedBarIndex, playheadPx, displayWidth)
  }, [currentTime, amplitudes, numBars, displayWidth, audioDuration])

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
  }, [isOpen, modalState, duration, skipTime])

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
      size="xl"
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
          <div className="space-y-0">
            {playbackError ? (
              <div className="bg-orange-900/20 border border-orange-500/50 rounded p-4">
                <p className="text-orange-400 font-semibold mb-1">Extraction failed</p>
                <p className="text-orange-300 text-sm">{playbackError}</p>
              </div>
            ) : audioFiles.length === 0 ? (
              <div className="bg-blue-900/20 border border-blue-500/50 rounded p-4">
                <p className="text-blue-400 font-semibold mb-1">No voice data found</p>
                <p className="text-blue-300 text-sm">
                  There was no audio found for: {playerName}
                </p>
              </div>
            ) : (
              <>
                {/* File selector — only shown when multiple files */}
                {audioFiles.length > 1 && (
                  <div className="mb-3">
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

                {!audioUrl ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="w-6 h-6 animate-spin text-accent mr-2" />
                    <span className="text-gray-400">Loading audio...</span>
                  </div>
                ) : selectedFile ? (
                  <>
                    {/* Two-panel layout */}
                    <div className="grid gap-4" style={{ gridTemplateColumns: '180px 1fr' }}>

                      {/* ── LEFT PANEL ── */}
                      <div className="flex flex-col gap-3 border-r border-border pr-4">

                        {/* Player info */}
                        <div>
                          <p className="text-xs text-gray-500 uppercase tracking-wide mb-0.5">Player</p>
                          <p className="text-sm font-bold text-white">{selectedFile.playerName || selectedFile.steamId || selectedFile.name}</p>
                          {selectedFile.steamId && (
                            <button
                              onClick={async () => {
                                if (window.electronAPI?.openExternal) {
                                  await window.electronAPI.openExternal(`https://steamcommunity.com/profiles/${selectedFile.steamId}`)
                                } else {
                                  window.open(`https://steamcommunity.com/profiles/${selectedFile.steamId}`, '_blank')
                                }
                              }}
                              className="text-xs text-accent hover:text-accent/80 underline bg-transparent border-none cursor-pointer p-0 truncate max-w-full text-left"
                              title={selectedFile.steamId}
                            >
                              {selectedFile.steamId} →
                            </button>
                          )}
                        </div>

                        {/* Time display */}
                        <div className="font-mono font-bold text-white" style={{ fontSize: '1.25rem' }}>
                          {formatTime(currentTime)}{' '}
                          <span className="text-xs text-gray-500 font-normal">/ {formatTime(audioDuration || duration)}</span>
                        </div>

                        {/* Transport controls */}
                        <div className="flex items-center gap-2">
                          <button
                            onClick={handleSkipBackward}
                            className="px-2.5 py-1.5 bg-secondary hover:bg-surface text-white rounded text-xs font-medium transition-colors border border-border"
                            aria-label={`Skip backward ${skipTime}s`}
                            title={`Skip backward ${skipTime}s`}
                          >
                            -{skipTime}s
                          </button>
                          <button
                            onClick={togglePlayback}
                            className="w-9 h-9 rounded-full bg-accent hover:bg-accent/90 text-white flex items-center justify-center transition-colors flex-shrink-0"
                            aria-label={isPlaying ? 'Pause' : 'Play'}
                          >
                            {isPlaying ? <Pause size={16} /> : <Play size={16} />}
                          </button>
                          <button
                            onClick={handleSkipForward}
                            className="px-2.5 py-1.5 bg-secondary hover:bg-surface text-white rounded text-xs font-medium transition-colors border border-border"
                            aria-label={`Skip forward ${skipTime}s`}
                            title={`Skip forward ${skipTime}s`}
                          >
                            +{skipTime}s
                          </button>
                        </div>

                        {/* Volume */}
                        <div>
                          <div className="flex justify-between text-xs text-gray-500 mb-1.5">
                            <span className="flex items-center gap-1"><Volume2 size={12} /> Volume</span>
                            <span className="text-gray-300">{Math.round(volume * 100)}%</span>
                          </div>
                          <input
                            type="range"
                            min="0"
                            max="2"
                            step="0.05"
                            value={volume}
                            onChange={handleVolumeChange}
                            className="w-full h-1.5 bg-secondary rounded-lg appearance-none cursor-pointer accent-accent"
                          />
                        </div>

                        {/* Speed */}
                        <div>
                          <div className="flex justify-between text-xs text-gray-500 mb-1.5">
                            <span className="flex items-center gap-1"><Gauge size={12} /> Speed</span>
                            <span className="text-gray-300">{playbackRate.toFixed(1)}x</span>
                          </div>
                          <input
                            type="range"
                            min="0.5"
                            max="2"
                            step="0.1"
                            value={playbackRate}
                            onChange={handlePlaybackRateChange}
                            className="w-full h-1.5 bg-secondary rounded-lg appearance-none cursor-pointer accent-accent"
                          />
                        </div>

                        {/* File info + download */}
                        <div className="mt-auto flex flex-col gap-2">
                          <p className="text-xs text-gray-600 truncate" title={selectedFile.name}>{selectedFile.name}</p>
                          <button
                            onClick={handleDownload}
                            className="flex items-center gap-1.5 px-2.5 py-1.5 bg-secondary hover:bg-surface text-gray-400 hover:text-white rounded text-xs transition-colors border border-border"
                          >
                            <Download size={13} /> Show in folder
                          </button>
                        </div>
                      </div>

                      {/* ── RIGHT PANEL ── */}
                      <div className="flex flex-col gap-2">

                        {/* Canvas waveform */}
                        <div
                          ref={canvasContainerRef}
                          className="flex-1 bg-secondary rounded-md overflow-hidden cursor-pointer"
                          style={{ minHeight: '180px', position: 'relative' }}
                          onClick={(e) => {
                            if (!amplitudes || numBars === 0 || audioDuration <= 0 || !canvasContainerRef.current) return
                            const rect = canvasContainerRef.current.getBoundingClientRect()
                            const canvasX = e.clientX - rect.left
                            const liveTime = audioRef.current?.currentTime ?? currentTime
                            const { scrollX } = computeScrollState(liveTime, audioDuration, numBars, displayWidth)
                            const newTime = canvasXToTime(canvasX, scrollX, numBars, audioDuration)
                            if (audioRef.current) audioRef.current.currentTime = newTime
                            setCurrentTime(newTime)
                          }}
                        >
                          {!amplitudes ? (
                            <div className="flex items-center justify-center w-full h-full" style={{ minHeight: '180px' }}>
                              <Loader2 className="w-5 h-5 animate-spin text-accent mr-2" />
                              <span className="text-gray-400 text-sm">Analysing audio...</span>
                            </div>
                          ) : (
                            <canvas
                              ref={canvasRef}
                              width={1}
                              height={180}
                              style={{ display: 'block', width: '100%', height: '180px' }}
                            />
                          )}
                        </div>

                        {/* Minimap seek slider */}
                        <div>
                          <div className="flex justify-between text-xs text-gray-600 mb-1 font-mono">
                            <span>0:00</span>
                            <span>{formatTime(audioDuration || duration)}</span>
                          </div>
                          <input
                            type="range"
                            min={0}
                            max={audioDuration || duration || 0}
                            step={0.01}
                            value={currentTime}
                            onChange={(e) => {
                              const newTime = parseFloat(e.target.value)
                              if (audioRef.current) audioRef.current.currentTime = newTime
                              setCurrentTime(newTime)
                            }}
                            className="w-full h-1.5 bg-secondary rounded-lg appearance-none cursor-pointer accent-accent border border-border"
                          />
                        </div>
                      </div>
                    </div>

                    {/* ── KEYBOARD SHORTCUTS BAR ── */}
                    <div className="flex items-center gap-4 mt-3 pt-3 border-t border-border">
                      <span className="text-xs text-gray-600 uppercase tracking-wide">Shortcuts</span>
                      <span className="text-xs text-gray-500 flex items-center gap-1">
                        <kbd className="px-1.5 py-0.5 bg-secondary border border-border rounded text-xs text-gray-400 font-mono">Space</kbd>
                        Play/Pause
                      </span>
                      <span className="text-xs text-gray-500 flex items-center gap-1">
                        <kbd className="px-1.5 py-0.5 bg-secondary border border-border rounded text-xs text-gray-400 font-mono">← →</kbd>
                        Skip
                      </span>
                      <span className="text-xs text-gray-500 flex items-center gap-1">
                        <kbd className="px-1.5 py-0.5 bg-secondary border border-border rounded text-xs text-gray-400 font-mono">↑ ↓</kbd>
                        Volume
                      </span>
                    </div>

                    {/* Hidden audio element */}
                    <audio
                      ref={audioRef}
                      src={audioUrl}
                      onLoadedMetadata={handleLoadedMetadata}
                      onTimeUpdate={handleTimeUpdate}
                      onEnded={() => setIsPlaying(false)}
                      onPlay={() => setIsPlaying(true)}
                      onPause={() => setIsPlaying(false)}
                    />
                  </>
                ) : null}
              </>
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}
