import { useState, useEffect, useRef } from 'react'
import Modal from './Modal'
import { parseNDJSONLine } from '../utils/ndjson'
import { X } from 'lucide-react'
import { t } from '../utils/translations'
import { useParsingStatus } from '../contexts/ParsingStatusContext'

interface ParsingModalProps {
  demosToParse: string[] // Array of demo file paths to parse
  onClose: () => void
  /** When true, modal stays mounted but renders nothing (so queue can continue in background). */
  isMinimized?: boolean
  /** Call this instead of onClose when user clicks "Run in background". */
  onRunInBackground?: () => void
}

interface LogEntry {
  id: number
  timestamp: Date
  level: 'info' | 'warn' | 'error' | 'progress'
  message: string
}

interface ProgressState {
  stage: string
  tick: number
  round: number
  pct: number
}

export default function ParsingModal({
  demosToParse,
  onClose,
  isMinimized = false,
  onRunInBackground,
}: ParsingModalProps) {
  const [isParsing, setIsParsing] = useState(false)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [progress, setProgress] = useState<ProgressState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [hasError, setHasError] = useState(false) // Track if there was an error
  const [showAbortConfirm, setShowAbortConfirm] = useState(false)
  const [matchId, setMatchId] = useState<string | null>(null)
  const [currentDemoIndex, setCurrentDemoIndex] = useState(0)
  const [settingsLoaded, setSettingsLoaded] = useState(false)
  const [parallelEnabled, setParallelEnabled] = useState(false)
  const [maxParallel, setMaxParallel] = useState(2)
  const stoppedByUserRef = useRef(false)
  const parsingStartedRef = useRef(false)
  const logIdRef = useRef(0)
  const logsEndRef = useRef<HTMLDivElement>(null)
  const currentDemoIndexRef = useRef(0)
  const demosToParseRef = useRef<string[]>([])
  const onCloseRef = useRef(onClose)
  const inFlightCountRef = useRef(0)
  const nextIndexToStartRef = useRef(0)
  const hasParallelStartedRef = useRef(false)
  const parallelEnabledRef = useRef(false)
  const maxParallelRef = useRef(2)
  const startNextBatchRef = useRef<(() => void) | null>(null)
  onCloseRef.current = onClose
  const { setQueueTotal, setParsingEnded } = useParsingStatus()

  currentDemoIndexRef.current = currentDemoIndex
  demosToParseRef.current = demosToParse ?? []
  parallelEnabledRef.current = parallelEnabled
  maxParallelRef.current = maxParallel

  const totalDemos = demosToParse?.length || 0

  const maxLogs = 100

  // Load parallel parsing settings once when we have demos
  useEffect(() => {
    if (!window.electronAPI || totalDemos === 0) return
    let cancelled = false
    ;(async () => {
      try {
        const [enabled, count] = await Promise.all([
          window.electronAPI.getSetting('parallel_parsing_enabled', 'false'),
          window.electronAPI.getSetting('parallel_parsing_count', '2'),
        ])
        if (cancelled) return
        setParallelEnabled(enabled === 'true')
        setMaxParallel(Math.max(1, Math.min(8, parseInt(count, 10) || 2)))
      } finally {
        if (!cancelled) setSettingsLoaded(true)
      }
    })()
    return () => { cancelled = true }
  }, [totalDemos])

  useEffect(() => {
    if (!window.electronAPI) return

    // Set up IPC listeners
    const handleMessage = (payload: string | { processId: string; message: string }) => {
      const message = typeof payload === 'string' ? payload : payload.message
      const parsed = parseNDJSONLine(message)
      if (!parsed) return

      if (parsed.type === 'progress') {
        setProgress({
          stage: (parsed.stage as string) || 'parsing',
          tick: (parsed.tick as number) || 0,
          round: (parsed.round as number) || 0,
          pct: (parsed.pct as number) || 0,
        })
        addLog('progress', `Progress: ${parsed.stage} - Round ${parsed.round}, Tick ${parsed.tick}`)
      } else if (parsed.type === 'log') {
        const level = (parsed.level as string) || 'info'
        const msg = (parsed.msg as string) || ''
        addLog(level as 'info' | 'warn' | 'error', msg)
      } else if (parsed.type === 'error') {
        const msg = (parsed.msg as string) || 'Unknown error'
        addLog('error', msg)
        setError(msg)
        setHasError(true)
        setIsParsing(false) // Stop parsing on error
      }
    }

    const handleLog = (log: string) => {
      addLog('info', log)
    }

    const startNextBatch = () => {
      if (stoppedByUserRef.current) {
        if (inFlightCountRef.current === 0) {
          addLog('info', 'Parser stopped by user')
          setIsParsing(false)
          setParsingEnded()
        }
        return
      }
      const total = demosToParseRef.current.length
      const maxP = maxParallelRef.current
      while (nextIndexToStartRef.current < total && inFlightCountRef.current < maxP) {
        const idx = nextIndexToStartRef.current
        nextIndexToStartRef.current++
        inFlightCountRef.current++
        const path = demosToParseRef.current[idx]
        window.electronAPI!.parseDemo({ demoPath: path }).then(() => {
          // Process started; parser:exit will decrement and call startNextBatch again
        }).catch((err: unknown) => {
          nextIndexToStartRef.current--
          inFlightCountRef.current--
          addLog('error', `Failed to start parse: ${err}`)
          startNextBatchRef.current?.()
        })
      }
      if (nextIndexToStartRef.current >= total && inFlightCountRef.current === 0) {
        setParsingEnded()
        setIsParsing(false)
        addLog('info', 'All demos parsed successfully')
        setTimeout(() => onCloseRef.current(), 1000)
      }
    }
    startNextBatchRef.current = startNextBatch

    const handleExit = (data: { code: number | null; signal: string | null; processId?: string }) => {
      const isParallel = parallelEnabledRef.current && maxParallelRef.current > 1
      if (isParallel) {
        inFlightCountRef.current--
        if (data.code === 0) {
          addLog('info', 'Parsing completed successfully')
        } else {
          if (!stoppedByUserRef.current && data.signal !== 'SIGKILL') {
            const errorMsg = `Parser exited with code ${data.code}${data.signal ? ` (signal: ${data.signal})` : ''}`
            addLog('error', errorMsg)
            setError((prev) => prev || errorMsg)
            setHasError(true)
          }
        }
        startNextBatch()
        return
      }

      setIsParsing(false)
      if (data.code === 0) {
        addLog('info', 'Parsing completed successfully')
        setError(null)
        setHasError(false)

        const total = demosToParseRef.current.length
        const idx = currentDemoIndexRef.current
        if (idx < total - 1) {
          setTimeout(() => {
            setCurrentDemoIndex((prev) => prev + 1)
            setIsParsing(false)
            setProgress(null)
            setLogs([])
            parsingStartedRef.current = false
          }, 500)
        } else {
          setParsingEnded()
          setTimeout(() => {
            onCloseRef.current()
          }, 1000)
        }
      } else {
        if (stoppedByUserRef.current) {
          addLog('info', 'Parser stopped by user')
          stoppedByUserRef.current = false
          setHasError(false)
        } else {
          if (data.signal === 'SIGKILL' && !parsingStartedRef.current) {
            addLog('info', 'Previous parser process cleaned up')
            setHasError(false)
            parsingStartedRef.current = false
          } else {
            const errorMsg = `Parser exited with code ${data.code}${data.signal ? ` (signal: ${data.signal})` : ''}`
            addLog('error', errorMsg)
            setError(errorMsg)
            setHasError(true)
          }
        }
      }
    }

    const handleError = (error: string) => {
      setIsParsing(false)
      const errorMsg = `Parser error: ${error}`
      addLog('error', errorMsg)
      setError(errorMsg)
      setHasError(true)
      // Keep modal open on error - don't auto-close
    }

    const unsubMessage = window.electronAPI.onParserMessage(handleMessage)
    const unsubLog = window.electronAPI.onParserLog(handleLog)
    const unsubExit = window.electronAPI.onParserExit(handleExit)
    const unsubError = window.electronAPI.onParserError(handleError)

    return () => {
      unsubMessage()
      unsubLog()
      unsubExit()
      unsubError()
    }
    // Empty deps: run once; cleanup removes only this modal's listeners so ParsingStatusContext keeps receiving
  }, [])

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs])

  const addLog = (level: LogEntry['level'], message: string) => {
    setLogs((prev) => {
      const newLogs = [
        ...prev,
        {
          id: logIdRef.current++,
          timestamp: new Date(),
          level,
          message,
        },
      ]
      // Keep only last maxLogs entries
      return newLogs.slice(-maxLogs)
    })
  }

  // Get the current demo path from the demosToParse array
  const currentDemoPath = demosToParse?.[currentDemoIndex]

  const handleStartParse = async () => {
    const pathToParse = currentDemoPath
    if (!window.electronAPI || !pathToParse || isParsing) return

    setIsParsing(true)
    setProgress(null)
    setError(null)
    setHasError(false)
    setLogs([])
    // Only set total when starting the first demo; context decrements on each finish
    if (currentDemoIndex === 0) {
      setQueueTotal(totalDemos)
    }

    if (totalDemos > 1) {
      addLog('info', `Starting parse ${currentDemoIndex + 1} of ${totalDemos}: ${pathToParse.split(/[/\\]/).pop()}`)
    } else {
      addLog('info', `Starting parse: ${pathToParse}`)
    }

    try {
      // Note: parseDemo will handle stopping any existing parser process
      const result = await window.electronAPI.parseDemo({ demoPath: pathToParse })
      setMatchId(result.matchId)
      parsingStartedRef.current = true // Mark that parsing has actually started
      addLog('info', `Match ID: ${result.matchId}, DB: ${result.dbPath}`)
    } catch (error) {
      setIsParsing(false)
      const errorMsg = `Failed to start parser: ${error}`
      addLog('error', errorMsg)
      setError(errorMsg)
      setHasError(true)
      // Keep modal open on error - don't auto-close
    }
  }

  const handleStop = () => {
    // Show confirmation dialog when stopping
    setShowAbortConfirm(true)
  }

  const getProgressPercent = () => {
    if (!progress) return 0
    return Math.min(100, Math.max(0, progress.pct * 100))
  }

  const handleClose = () => {
    if (isParsing) {
      // Show confirmation if parsing is in progress
      setShowAbortConfirm(true)
    } else if (hasError) {
      // If there's an error, allow closing (user can copy logs first)
      onClose()
    } else {
      // Close immediately if not parsing and no error (shouldn't happen normally)
      onClose()
    }
  }

  const handleAbortConfirm = async () => {
    if (!window.electronAPI) return

    try {
      // Mark that we're stopping by user (so exit handler knows)
      stoppedByUserRef.current = true
      
      // Stop the parser
      try {
        await window.electronAPI.stopParser()
        // Exit handler will log "Parser stopped by user" when process exits
      } catch (stopError) {
        // Parser might already be stopped
        console.log('Parser stop error (may already be stopped):', stopError)
        // If stop failed, we might still want to close
        setIsParsing(false)
      }

      // Delete the created database file if matchId exists
      if (matchId) {
        try {
          await window.electronAPI.deleteMatches([matchId])
          addLog('info', 'Deleted incomplete match database')
        } catch (deleteError) {
          addLog('error', `Failed to delete database: ${deleteError}`)
        }
      } else {
        // If no matchId yet, try to delete based on demo filename
        // Generate matchId from demo path (same logic as parser)
        const pathParts = demoPath.split(/[/\\]/)
        const fileName = pathParts[pathParts.length - 1]
        const matchIdFromFile = fileName.replace(/\.dem$/i, '')
        if (matchIdFromFile) {
          try {
            await window.electronAPI.deleteMatches([matchIdFromFile])
            addLog('info', 'Deleted incomplete match database')
          } catch (deleteError) {
            // Database might not exist yet, which is fine
            console.log('No database to delete (parsing may not have started):', deleteError)
          }
        }
      }

      setIsParsing(false)
      setShowAbortConfirm(false)
      onClose()
    } catch (error) {
      addLog('error', `Failed to abort parsing: ${error}`)
      setShowAbortConfirm(false)
    }
  }

  // Parallel: start batch once when settings are loaded
  useEffect(() => {
    if (!settingsLoaded || !parallelEnabled || maxParallel <= 1 || totalDemos === 0 || hasParallelStartedRef.current) return
    hasParallelStartedRef.current = true
    setQueueTotal(totalDemos)
    setIsParsing(true)
    setProgress(null)
    setError(null)
    setHasError(false)
    setLogs([])
    if (totalDemos > 1) {
      addLog('info', `Starting parallel parse of ${totalDemos} demos (max ${maxParallel} at a time)`)
    }
    startNextBatchRef.current?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsLoaded, parallelEnabled, maxParallel, totalDemos])

  // Sequential: auto-start when modal opens or when moving to next demo
  useEffect(() => {
    if (!settingsLoaded || parallelEnabled || !currentDemoPath || isParsing) return
    handleStartParse()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsLoaded, parallelEnabled, currentDemoPath, currentDemoIndex, isParsing])

  // When minimized (run in background), stay mounted but don't render UI so queue continues
  if (isMinimized) {
    return null
  }

  return (
    <>
      <Modal
        isOpen={true}
        onClose={handleClose}
        title={parallelEnabled && totalDemos > 1 ? `Parsing ${totalDemos} demos (parallel)` : totalDemos > 1 ? `Parsing Demo (${currentDemoIndex + 1} of ${totalDemos})` : 'Parsing Demo'}
        size="lg"
        canClose={!isParsing} // Disable closing while parsing is in progress
      >
      <div className="space-y-4">
        {/* Demo Path */}
        <div className="px-4 py-2 bg-surface rounded border border-border">
          <p className="text-xs text-gray-500 mb-1">Demo File:</p>
          <p className="text-sm text-gray-300 truncate" title={currentDemoPath || ''}>
            {currentDemoPath ? currentDemoPath.split(/[/\\]/).pop() : 'N/A'}
          </p>
        </div>

        {/* Progress Bar */}
        {progress && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-gray-400">
                {progress.stage} - Round {progress.round} - Tick {progress.tick}
              </span>
              <span className="text-gray-400">{getProgressPercent().toFixed(1)}%</span>
            </div>
            <div className="w-full h-3 bg-surface rounded-full overflow-hidden border border-border">
              <div
                className="h-full bg-accent transition-all duration-300"
                style={{ width: `${getProgressPercent()}%` }}
              />
            </div>
          </div>
        )}

        {/* Error Display */}
        {error && (
          <div className="p-3 bg-red-900/20 border border-red-500/50 rounded text-red-400 text-sm">
            {error}
          </div>
        )}

        {/* Logs */}
        <div className="flex flex-col bg-surface rounded border border-border overflow-hidden" style={{ height: '300px' }}>
          <div className="px-4 py-2 border-b border-border flex-shrink-0 flex items-center justify-between">
            <h3 className="text-sm font-medium text-gray-300">Console Log</h3>
            {isParsing && (
              <div className="flex items-center gap-2">
                {onRunInBackground && (
                  <button
                    onClick={onRunInBackground}
                    className="px-3 py-1 text-xs bg-surface border border-border text-gray-300 rounded hover:bg-surface/80 transition-colors"
                    title={t('parsing.runInBackgroundDesc')}
                  >
                    {t('parsing.runInBackground')}
                  </button>
                )}
                <button
                  onClick={handleStop}
                  className="px-3 py-1 text-xs bg-red-600 text-white rounded hover:bg-red-700 transition-colors"
                >
                  Stop
                </button>
              </div>
            )}
          </div>
          <div className="flex-1 overflow-y-auto p-4 font-mono text-xs min-h-0">
            {logs.length === 0 ? (
              <p className="text-gray-500">Starting parser...</p>
            ) : (
              logs.map((log) => (
                <div
                  key={log.id}
                  className={`mb-1 ${
                    log.level === 'error'
                      ? 'text-red-400'
                      : log.level === 'warn'
                      ? 'text-yellow-400'
                      : log.level === 'progress'
                      ? 'text-accent'
                      : 'text-gray-300'
                  }`}
                >
                  <span className="text-gray-500">
                    [{log.timestamp.toLocaleTimeString()}]
                  </span>{' '}
                  <span className="uppercase text-gray-500">{log.level}</span>: {log.message}
                </div>
              ))
            )}
            <div ref={logsEndRef} />
          </div>
        </div>
      </div>
    </Modal>

    {/* Abort Confirmation Modal */}
    <Modal
      isOpen={showAbortConfirm}
      onClose={() => setShowAbortConfirm(false)}
      title="Abort Parsing?"
      size="md"
      footer={
        <div className="flex justify-end gap-2">
          <button
            onClick={() => setShowAbortConfirm(false)}
            className="px-4 py-2 bg-surface border border-border text-white rounded hover:bg-surface/80 transition-colors text-sm"
          >
            Cancel
          </button>
          <button
            onClick={handleAbortConfirm}
            className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 transition-colors text-sm"
          >
            Abort & Delete
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="flex items-start gap-3">
          <div className="flex-shrink-0 w-12 h-12 rounded-full bg-red-500/20 flex items-center justify-center">
            <svg
              className="w-6 h-6 text-red-400"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
            </svg>
          </div>
          <div className="flex-1">
            <h3 className="text-lg font-semibold text-white mb-2">
              Are you sure you want to abort parsing?
            </h3>
            <p className="text-sm text-gray-400 mb-2">
              This will stop the parser and delete the incomplete match database.
            </p>
            <p className="text-sm text-red-400 font-medium">
              This action cannot be undone.
            </p>
          </div>
        </div>
      </div>
    </Modal>
    </>
  )
}
