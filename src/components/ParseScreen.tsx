import { useState, useEffect, useRef } from 'react'
import { Copy, Check } from 'lucide-react'
import { parseNDJSONLine } from '../utils/ndjson'

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

function ParseScreen() {
  const [demoPath, setDemoPath] = useState<string | null>(null)
  const [isParsing, setIsParsing] = useState(false)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [progress, setProgress] = useState<ProgressState | null>(null)
  const [apiPort, setApiPort] = useState<number | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [copied, setCopied] = useState(false)
  const logIdRef = useRef(0)
  const logsEndRef = useRef<HTMLDivElement>(null)
  const dropZoneRef = useRef<HTMLDivElement>(null)

  const maxLogs = 500

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
      } else if (parsed.type === 'ready') {
        const port = (parsed.port as number) || null
        setApiPort(port)
        if (port) {
          localStorage.setItem('apiPort', port.toString())
        }
        addLog('info', `API server ready on port ${port}`)
      }
    }

    const handleLog = (log: string) => {
      addLog('info', log)
    }

    const handleExit = (data: { code: number | null; signal: string | null }) => {
      setIsParsing(false)
      if (data.code === 0) {
        addLog('info', 'Parsing completed successfully')
      } else {
        addLog('error', `Parser exited with code ${data.code}${data.signal ? ` (signal: ${data.signal})` : ''}`)
      }
    }

    const handleError = (error: string) => {
      setIsParsing(false)
      addLog('error', `Parser error: ${error}`)
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

  const handleOpenDemo = async () => {
    if (!window.electronAPI) return

    try {
      const path = await window.electronAPI.openFileDialog()
      if (path) {
        setDemoPath(path)
        addLog('info', `Selected demo: ${path}`)
        // Auto-parse the selected file
        await autoParse(path)
      }
    } catch (error) {
      addLog('error', `Failed to open file dialog: ${error}`)
    }
  }

  const handleParse = async () => {
    if (!window.electronAPI || !demoPath || isParsing) return

    setIsParsing(true)
    setProgress(null)
    setApiPort(null)
    addLog('info', `Starting parse: ${demoPath}`)

    try {
      const result = await window.electronAPI.parseDemo({ demoPath })
      addLog('info', `Match ID: ${result.matchId}, DB: ${result.dbPath}`)
    } catch (error) {
      setIsParsing(false)
      addLog('error', `Failed to start parser: ${error}`)
    }
  }

  const handleStop = async () => {
    if (!window.electronAPI) return

    try {
      await window.electronAPI.stopParser()
      addLog('info', 'Parser stopped by user')
    } catch (error) {
      addLog('error', `Failed to stop parser: ${error}`)
    }
  }

  const getProgressPercent = () => {
    if (!progress) return 0
    return Math.min(100, Math.max(0, progress.pct * 100))
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (!isDragging) {
      setIsDragging(true)
    }
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    // Only set isDragging to false if we're leaving the drop zone
    if (dropZoneRef.current && !dropZoneRef.current.contains(e.relatedTarget as Node)) {
      setIsDragging(false)
    }
  }

  const autoParse = async (path: string) => {
    if (!window.electronAPI || !path || isParsing) return

    setIsParsing(true)
    setProgress(null)
    setApiPort(null)
    addLog('info', `Starting parse: ${path}`)

    try {
      const result = await window.electronAPI.parseDemo({ demoPath: path })
      addLog('info', `Match ID: ${result.matchId}, DB: ${result.dbPath}`)
    } catch (error) {
      setIsParsing(false)
      addLog('error', `Failed to start parser: ${error}`)
    }
  }

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)

    if (isParsing) {
      addLog('warn', 'Cannot change demo file while parsing')
      return
    }

    const files = Array.from(e.dataTransfer.files)
    if (files.length === 0) {
      addLog('warn', 'No files dropped')
      return
    }

    // Get the first .dem file
    const demFile = files.find(file => file.name.toLowerCase().endsWith('.dem'))
    if (!demFile) {
      addLog('error', 'Please drop a .dem file')
      return
    }

    // In Electron, we need to get the full path from the file
    // The file.path property should contain the full path in Electron
    const filePath = (demFile as any).path || demFile.name
    
    if (filePath) {
      setDemoPath(filePath)
      addLog('info', `Dropped demo: ${filePath}`)
      // Auto-parse the dropped file
      await autoParse(filePath)
    } else {
      addLog('error', 'Could not get file path from dropped file')
    }
  }

  return (
    <div className="flex-1 flex flex-col p-6">
      <div className="mb-6">
        <h2 className="text-2xl font-bold mb-4">Parse Demo</h2>
        
        <div className="space-y-4">
          {/* Drop Zone */}
          <div
            ref={dropZoneRef}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={`border-2 border-dashed rounded-lg p-8 transition-colors ${
              isDragging
                ? 'border-accent bg-accent/10'
                : 'border-border bg-surface/50 hover:border-accent/50'
            }`}
          >
            <div className="text-center">
              <div className="mb-4">
                <svg
                  className="mx-auto h-12 w-12 text-gray-400"
                  stroke="currentColor"
                  fill="none"
                  viewBox="0 0 48 48"
                  aria-hidden="true"
                >
                  <path
                    d="M28 8H12a4 4 0 00-4 4v20m32-12v8m0 0v8a4 4 0 01-4 4H12a4 4 0 01-4-4v-4m32-4l-3.172-3.172a4 4 0 00-5.656 0L28 28M8 32l9.172-9.172a4 4 0 015.656 0L28 28m0 0l4 4m4-24h8m-4-4v8m-12 4h.02"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
              <p className="text-sm text-gray-400 mb-2">
                {isDragging ? (
                  <span className="text-accent font-medium">Drop the demo file here</span>
                ) : (
                  <>
                    <span className="text-gray-300 font-medium">Drag and drop a .dem file here</span>
                    <span className="text-gray-500"> or</span>
                  </>
                )}
              </p>
              <button
                onClick={handleOpenDemo}
                disabled={isParsing}
                className="px-4 py-2 bg-accent text-white rounded hover:bg-opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                Browse for Demo File...
              </button>
            </div>
          </div>

          {/* Selected File Display */}
          {demoPath && (
            <div className="px-4 py-2 bg-surface rounded border border-border">
              <p className="text-xs text-gray-500 mb-1">Selected Demo:</p>
              <p className="text-sm text-gray-300 truncate">{demoPath}</p>
            </div>
          )}

          <div className="flex items-center gap-4">
            <button
              onClick={handleParse}
              disabled={!demoPath || isParsing}
              className="px-6 py-2 bg-accent text-white rounded hover:bg-opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isParsing ? 'Parsing...' : 'Parse'}
            </button>

            {isParsing && (
              <button
                onClick={handleStop}
                className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 transition-colors"
              >
                Stop
              </button>
            )}

            {apiPort && (
              <div className="px-4 py-2 bg-surface rounded border border-border">
                <span className="text-sm text-gray-300">API: localhost:{apiPort}</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {progress && (
        <div className="mb-6">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm text-gray-400">
              {progress.stage} - Round {progress.round} - Tick {progress.tick}
            </span>
            <span className="text-sm text-gray-400">{getProgressPercent().toFixed(1)}%</span>
          </div>
          <div className="w-full h-3 bg-surface rounded-full overflow-hidden border border-border">
            <div
              className="h-full bg-accent transition-all duration-300"
              style={{ width: `${getProgressPercent()}%` }}
            />
          </div>
        </div>
      )}

      <div className="flex flex-col bg-surface rounded border border-border overflow-hidden" style={{ height: '400px' }}>
        <div className="px-4 py-2 border-b border-border flex-shrink-0 flex items-center justify-between">
          <h3 className="text-sm font-medium text-gray-300">Console Log</h3>
          <button
            onClick={async () => {
              const logText = logs.map(log => {
                const level = log.level.toUpperCase()
                const timestamp = log.timestamp.toLocaleTimeString()
                return `[${timestamp}] ${level}: ${log.message}`
              }).join('\n')
              
              try {
                await navigator.clipboard.writeText(logText)
                setCopied(true)
                setTimeout(() => setCopied(false), 2000)
              } catch (err) {
                console.error('Failed to copy logs:', err)
              }
            }}
            className="flex items-center gap-2 px-3 py-1.5 text-xs bg-secondary hover:bg-secondary/80 border border-border rounded transition-colors text-gray-300 hover:text-white"
            title="Copy all logs to clipboard"
          >
            {copied ? (
              <>
                <Check size={14} />
                Copied!
              </>
            ) : (
              <>
                <Copy size={14} />
                Copy Logs
              </>
            )}
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 font-mono text-xs min-h-0">
          {logs.length === 0 ? (
            <p className="text-gray-500">No logs yet...</p>
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
                <span className="uppercase text-gray-500">{log.level}</span>:{' '}
                {log.message}
              </div>
            ))
          )}
          <div ref={logsEndRef} />
        </div>
      </div>
    </div>
  )
}

export default ParseScreen

