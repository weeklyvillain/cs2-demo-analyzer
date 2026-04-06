import { useState, useEffect, useRef, useCallback } from 'react'
import { Mic, Loader2, AlertCircle, ChevronDown } from 'lucide-react'

export interface TranscriptSegment {
  fromMs: number
  toMs: number
  text: string
}

interface TranscriptPanelProps {
  audioFilePath: string | null
  steamId: string
  audioFilename: string
  matchId: string | null
  currentTimeMs: number
  onSeek: (timeMs: number) => void
}

type PanelState = 'idle' | 'checking' | 'transcribing' | 'done' | 'error'

const MODEL_LABELS: Record<string, string> = {
  tiny:   'tiny (~75 MB)',
  base:   'base (~150 MB)',
  small:  'small (~500 MB)',
  medium: 'medium (~1.5 GB)',
  large:  'large (~3 GB)',
}

export default function TranscriptPanel({
  audioFilePath,
  steamId,
  audioFilename,
  matchId,
  currentTimeMs,
  onSeek,
}: TranscriptPanelProps) {
  const [state, setState] = useState<PanelState>('idle')
  const [segments, setSegments] = useState<TranscriptSegment[]>([])
  const [language, setLanguage] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [model, setModel] = useState<string>('small')
  const [binaryReady, setBinaryReady] = useState(false)
  const [modelReady, setModelReady] = useState(false)
  const [downloadPhase, setDownloadPhase] = useState<string>('')
  const [downloadPercent, setDownloadPercent] = useState(0)
  const [transcribePercent, setTranscribePercent] = useState(0)
  const [estimatedSecsRemaining, setEstimatedSecsRemaining] = useState<number | null>(null)
  const [isCached, setIsCached] = useState(false)
  const activeSegmentRef = useRef<HTMLDivElement | null>(null)
  const unsubProgressRef = useRef<(() => void) | null>(null)
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const isProgrammaticScroll = useRef(false)
  const [autoFollow, setAutoFollow] = useState(true)

  // Load model preference from settings
  useEffect(() => {
    if (!window.electronAPI) return
    window.electronAPI.getSetting('transcription_model', 'small').then(setModel).catch(() => {})
  }, [])

  // Reset when audio file changes
  useEffect(() => {
    setState('idle')
    setSegments([])
    setError(null)
    setIsCached(false)
    setLanguage('')
    setTranscribePercent(0)
    setEstimatedSecsRemaining(null)
    setAutoFollow(true)
  }, [audioFilePath, audioFilename])

  // Auto-scroll active segment into view (only when autoFollow is on)
  useEffect(() => {
    if (state === 'done' && autoFollow && activeSegmentRef.current) {
      isProgrammaticScroll.current = true
      activeSegmentRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      setTimeout(() => { isProgrammaticScroll.current = false }, 500)
    }
  }, [currentTimeMs, state, autoFollow])

  const checkStatus = useCallback(async () => {
    if (!window.electronAPI) return
    try {
      const status = await window.electronAPI.transcriptionStatus(model)
      setBinaryReady(status.binaryReady)
      setModelReady(status.modelReady)
    } catch {}
  }, [model])

  useEffect(() => {
    checkStatus()
  }, [checkStatus])

  const subscribeProgress = useCallback(() => {
    if (!window.electronAPI) return
    if (unsubProgressRef.current) unsubProgressRef.current()
    unsubProgressRef.current = window.electronAPI.onTranscriptionProgress((data) => {
      if (data.phase === 'transcribing') {
        setTranscribePercent(data.percent)
        setEstimatedSecsRemaining(data.estimatedSecondsRemaining ?? null)
      } else if (data.phase === 'extracting') {
        setDownloadPhase('Extracting binary...')
        setDownloadPercent(data.percent)
      } else {
        const label = data.phase === 'binary' ? 'binary' : `model (${model})`
        setDownloadPhase(`Downloading ${label}`)
        setDownloadPercent(data.percent)
      }
    })
  }, [model])

  const handleTranscribe = useCallback(async () => {
    if (!audioFilePath || !matchId || !window.electronAPI) return

    setState('checking')
    setError(null)
    subscribeProgress()

    try {
      const status = await window.electronAPI.transcriptionStatus(model)

      if (!status.binaryReady) {
        setDownloadPhase('Downloading whisper binary...')
        setDownloadPercent(0)
        const res = await window.electronAPI.transcriptionDownloadBinary()
        if (!res.success) throw new Error(res.error ?? 'Binary download failed')
      }

      if (!status.modelReady) {
        setDownloadPhase(`Downloading ${model} model...`)
        setDownloadPercent(0)
        const res = await window.electronAPI.transcriptionDownloadModel(model)
        if (!res.success) throw new Error(res.error ?? 'Model download failed')
      }

      setState('transcribing')
      setDownloadPhase('Transcribing audio...')

      const result = await window.electronAPI.transcriptionRun({
        audioFilePath,
        steamId,
        audioFilename,
        matchId,
        model,
      })

      if (!result.success) throw new Error(result.error ?? 'Transcription failed')

      setSegments(result.segments ?? [])
      setLanguage(result.language ?? '')
      setIsCached(result.cached ?? false)
      setState('done')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setState('error')
    } finally {
      if (unsubProgressRef.current) {
        unsubProgressRef.current()
        unsubProgressRef.current = null
      }
    }
  }, [audioFilePath, matchId, model, steamId, audioFilename, subscribeProgress])

  const handleContainerScroll = useCallback(() => {
    if (isProgrammaticScroll.current) return
    setAutoFollow(false)
  }, [])

  const activeIndex = segments.findIndex((seg, i) => {
    const next = segments[i + 1]
    return currentTimeMs >= seg.fromMs && (next ? currentTimeMs < next.fromMs : true)
  })

  const formatTime = (ms: number) => {
    const totalSec = Math.floor(ms / 1000)
    const mins = Math.floor(totalSec / 60)
    const secs = totalSec % 60
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  // ── Idle / empty state ──────────────────────────────────────────────────────
  if (state === 'idle') {
    return (
      <div className="bg-secondary rounded-md p-4 flex flex-col items-center justify-center gap-3 min-h-[100px]">
        <Mic size={20} className="text-gray-500" />
        <p className="text-sm text-gray-400 text-center">No transcript yet</p>
        <div className="flex items-center gap-2">
          <select
            value={model}
            onChange={(e) => {
              setModel(e.target.value)
              window.electronAPI?.setSetting('transcription_model', e.target.value).catch(() => {})
            }}
            className="px-2 py-1 bg-surface border border-border rounded text-xs text-gray-300 focus:outline-none focus:ring-1 focus:ring-accent"
          >
            {Object.entries(MODEL_LABELS).map(([key, label]) => (
              <option key={key} value={key}>{label}</option>
            ))}
          </select>
          <button
            onClick={handleTranscribe}
            disabled={!audioFilePath}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-accent hover:bg-accent/90 text-white rounded text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Mic size={12} /> Transcribe
          </button>
        </div>
        {!binaryReady && (
          <p className="text-xs text-yellow-500/80 text-center">
            ⚠ Whisper binary not downloaded yet — will download automatically
          </p>
        )}
        {binaryReady && !modelReady && (
          <p className="text-xs text-yellow-500/80 text-center">
            ⚠ Model ({model}) not downloaded yet — will download automatically
          </p>
        )}
      </div>
    )
  }

  // ── Downloading / transcribing ──────────────────────────────────────────────
  if (state === 'checking' || state === 'transcribing') {
    const isTranscribing = state === 'transcribing'
    const etaLabel = estimatedSecsRemaining !== null
      ? estimatedSecsRemaining > 0
        ? `~${estimatedSecsRemaining}s remaining`
        : 'almost done...'
      : null

    return (
      <div className="bg-secondary rounded-md p-4 flex flex-col items-center justify-center gap-3 min-h-[100px]">
        <Loader2 size={20} className="text-accent animate-spin" />
        <p className="text-sm text-gray-300">{downloadPhase || 'Working...'}</p>

        {/* Download progress (binary/model) */}
        {downloadPercent > 0 && !isTranscribing && (
          <div className="w-full max-w-xs">
            <div className="flex justify-between text-xs text-gray-500 mb-1">
              <span>Downloading</span>
              <span>{downloadPercent}%</span>
            </div>
            <div className="h-1.5 bg-surface rounded-full overflow-hidden">
              <div
                className="h-full bg-accent rounded-full transition-all duration-200"
                style={{ width: `${downloadPercent}%` }}
              />
            </div>
          </div>
        )}

        {/* Transcription progress + ETA */}
        {isTranscribing && (
          <div className="w-full max-w-xs">
            <div className="flex justify-between text-xs text-gray-500 mb-1">
              <span>{transcribePercent > 0 ? `${transcribePercent}%` : 'Starting...'}</span>
              {etaLabel && <span className="text-gray-400">{etaLabel}</span>}
            </div>
            <div className="h-1.5 bg-surface rounded-full overflow-hidden">
              <div
                className="h-full bg-accent rounded-full transition-all duration-500"
                style={{ width: `${transcribePercent}%` }}
              />
            </div>
          </div>
        )}
      </div>
    )
  }

  // ── Error state ─────────────────────────────────────────────────────────────
  if (state === 'error') {
    return (
      <div className="bg-secondary rounded-md p-4 flex flex-col gap-3 min-h-[100px]">
        <div className="flex items-start gap-2 text-red-400">
          <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">Transcription failed</p>
            <p className="text-xs text-red-300 mt-1 break-words">{error}</p>
          </div>
        </div>
        <button
          onClick={() => { setState('idle'); setError(null) }}
          className="self-start px-3 py-1.5 bg-surface hover:bg-secondary border border-border text-xs text-gray-300 rounded transition-colors"
        >
          Try again
        </button>
      </div>
    )
  }

  // ── Done — transcript list ──────────────────────────────────────────────────
  return (
    <div className="bg-secondary rounded-md flex flex-col" style={{ minHeight: '120px', maxHeight: '200px' }}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border flex-shrink-0">
        <div className="flex items-center gap-1.5">
          <Mic size={12} className="text-accent" />
          <span className="text-xs font-medium text-gray-300">Transcript</span>
          {language && language !== 'unknown' && (
            <span className="text-xs text-gray-600 uppercase">{language}</span>
          )}
          {isCached && (
            <span className="text-xs text-gray-600">(cached)</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!autoFollow && (
            <button
              onClick={() => {
                setAutoFollow(true)
                if (activeSegmentRef.current) {
                  isProgrammaticScroll.current = true
                  activeSegmentRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
                  setTimeout(() => { isProgrammaticScroll.current = false }, 500)
                }
              }}
              className="text-xs text-accent hover:text-accent/80 transition-colors flex items-center gap-0.5"
              title="Follow playback"
            >
              <ChevronDown size={13} />
            </button>
          )}
          <button
            onClick={() => { setState('idle'); setSegments([]) }}
            className="text-xs text-gray-600 hover:text-gray-400 transition-colors"
            title="Clear transcript"
          >
            ✕
          </button>
        </div>
      </div>

      {/* Segment list */}
      {segments.length === 0 ? (
        <div className="flex-1 flex items-center justify-center p-4">
          <p className="text-xs text-gray-500 italic">No speech detected in this audio.</p>
        </div>
      ) : (
        <div ref={scrollContainerRef} onScroll={handleContainerScroll} className="flex-1 overflow-y-auto px-2 py-1.5 space-y-0.5">
          {segments.map((seg, i) => {
            const isActive = i === activeIndex
            return (
              <div
                key={i}
                ref={isActive ? activeSegmentRef : undefined}
                onClick={() => onSeek(seg.fromMs)}
                className={`flex items-start gap-2.5 px-2 py-1 rounded cursor-pointer transition-colors group ${
                  isActive
                    ? 'bg-accent/20 text-white'
                    : 'hover:bg-surface/60 text-gray-300 hover:text-white'
                }`}
                title="Click to seek"
              >
                <span className={`text-xs font-mono font-semibold flex-shrink-0 mt-0.5 ${isActive ? 'text-accent' : 'text-gray-500 group-hover:text-accent/70'}`}>
                  {formatTime(seg.fromMs)}
                </span>
                <span className="text-xs leading-relaxed">{seg.text}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
