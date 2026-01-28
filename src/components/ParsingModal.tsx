import { useState, useEffect, useRef } from 'react'
import Modal from './Modal'
import { parseNDJSONLine } from '../utils/ndjson'
import { X } from 'lucide-react'

interface ParsingModalProps {
  demosToParse: string[] // Array of demo file paths to parse
  onClose: () => void
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
}: ParsingModalProps) {
  const [isParsing, setIsParsing] = useState(false)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [progress, setProgress] = useState<ProgressState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [hasError, setHasError] = useState(false) // Track if there was an error
  const [showAbortConfirm, setShowAbortConfirm] = useState(false)
  const [matchId, setMatchId] = useState<string | null>(null)
  const [currentDemoIndex, setCurrentDemoIndex] = useState(0)
  const stoppedByUserRef = useRef(false)
  const parsingStartedRef = useRef(false) // Track if we've actually started parsing
  const logIdRef = useRef(0)
  const logsEndRef = useRef<HTMLDivElement>(null)
  
  const totalDemos = demosToParse?.length || 0

  const maxLogs = 100

  useEffect(() => {
    if (!window.electronAPI) return

    // Set up IPC listeners
    const handleMessage = (message: string) => {
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

    const handleExit = (data: { code: number | null; signal: string | null }) => {
      setIsParsing(false)
      if (data.code === 0) {
        addLog('info', 'Parsing completed successfully')
        setError(null)
        setHasError(false)
        
        // Check if there are more demos to parse
        if (currentDemoIndex < (demosToParse?.length || 0) - 1) {
          // Move to next demo in queue
          setTimeout(() => {
            setCurrentDemoIndex(prev => prev + 1)
            setIsParsing(false)
            setProgress(null)
            setLogs([])
            parsingStartedRef.current = false
            // The auto-start effect will pick up the new demoPath
          }, 500)
        } else {
          // All demos parsed - close modal and return to previous screen
          setTimeout(() => {
            onClose()
          }, 1000)
        }
      } else {
        // On error or user stop, keep modal open so user can copy logs
        if (stoppedByUserRef.current) {
          addLog('info', 'Parser stopped by user')
          stoppedByUserRef.current = false // Reset for next time
          setHasError(false) // User stop is not an error
        } else {
          // This is an error - keep modal open
          // Ignore SIGKILL signals if parsing hasn't actually started yet (cleanup of old process)
          if (data.signal === 'SIGKILL' && !parsingStartedRef.current) {
            // Process was killed before we started parsing (cleanup) - not an error
            addLog('info', 'Previous parser process cleaned up')
            setHasError(false)
            parsingStartedRef.current = false // Reset
          } else {
            // Actual error occurred
            const errorMsg = `Parser exited with code ${data.code}${data.signal ? ` (signal: ${data.signal})` : ''}`
            addLog('error', errorMsg)
            setError(errorMsg)
            setHasError(true)
          }
        }
        // Don't auto-close - let user close manually after copying logs
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

    window.electronAPI.onParserMessage(handleMessage)
    window.electronAPI.onParserLog(handleLog)
    window.electronAPI.onParserExit(handleExit)
    window.electronAPI.onParserError(handleError)

    return () => {
      window.electronAPI.removeAllListeners('parser:message')
      window.electronAPI.removeAllListeners('parser:log')
      window.electronAPI.removeAllListeners('parser:exit')
      window.electronAPI.removeAllListeners('parser:error')
    }
  }, [onClose, currentDemoIndex])

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

  // Auto-start parsing when modal opens or when moving to next demo
  useEffect(() => {
    if (currentDemoPath && !isParsing) {
      handleStartParse()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentDemoPath, currentDemoIndex])

  return (
    <>
      <Modal
        isOpen={true}
        onClose={handleClose}
        title={totalDemos > 1 ? `Parsing Demo (${currentDemoIndex + 1} of ${totalDemos})` : 'Parsing Demo'}
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
              <button
                onClick={handleStop}
                className="px-3 py-1 text-xs bg-red-600 text-white rounded hover:bg-red-700 transition-colors"
              >
                Stop
              </button>
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
