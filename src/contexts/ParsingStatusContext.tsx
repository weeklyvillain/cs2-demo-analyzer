import {
  createContext,
  useCallback,
  useContext,
  useState,
  useEffect,
  ReactNode,
} from 'react'
import { parseNDJSONLine } from '../utils/ndjson'

export interface ParsingProgress {
  stage: string
  tick: number
  round: number
  pct: number
}

export interface ParsingLogEntry {
  id: number
  timestamp: Date
  level: 'info' | 'warn' | 'error' | 'progress'
  message: string
}

const MAX_LOGS = 200
let logIdCounter = 0

interface ParsingStatusState {
  isParsing: boolean
  progress: ParsingProgress | null
  demoPath: string | null
  matchId: string | null
  demoFileName: string | null
  logs: ParsingLogEntry[]
  error: string | null
  /** Total demos in the current queue (set by ParsingModal when it starts). */
  queueTotal: number
}

interface ParsingStatusContextValue extends ParsingStatusState {
  showParsingPanel: boolean
  openParsingPanel: () => void
  closeParsingPanel: () => void
  stopParsing: () => Promise<void>
  setQueueTotal: (n: number) => void
  /** Call when the whole queue is done so the sidebar hides (modal calls this on last demo). */
  setParsingEnded: () => void
}

const initialState: ParsingStatusState = {
  isParsing: false,
  progress: null,
  demoPath: null,
  matchId: null,
  demoFileName: null,
  logs: [],
  error: null,
  queueTotal: 1,
}

const ParsingStatusContext = createContext<ParsingStatusContextValue | null>(null)

export function ParsingStatusProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ParsingStatusState>(initialState)
  const [showParsingPanel, setShowParsingPanel] = useState(false)

  const addLog = useCallback(
    (level: ParsingLogEntry['level'], message: string) => {
      setState((prev) => {
        const next = [...prev.logs, { id: ++logIdCounter, timestamp: new Date(), level, message }]
        return { ...prev, logs: next.slice(-MAX_LOGS) }
      })
    },
    []
  )

  useEffect(() => {
    if (!window.electronAPI) return

    const handleStarted = (data: { matchId: string; demoPath: string }) => {
      const fileName = data.demoPath.replace(/^.*[/\\]/, '') || data.matchId
      setState((prev) => ({
        ...prev,
        isParsing: true,
        progress: null,
        demoPath: data.demoPath,
        matchId: data.matchId,
        demoFileName: fileName,
        logs: [],
        error: null,
      }))
      setShowParsingPanel(false)
    }

    const handleMessage = (payload: string | { processId: string; message: string }) => {
      const message = typeof payload === 'string' ? payload : payload.message
      const parsed = parseNDJSONLine(message)
      if (!parsed) return

      if (parsed.type === 'progress') {
        const progress: ParsingProgress = {
          stage: (parsed.stage as string) || 'parsing',
          tick: (parsed.tick as number) || 0,
          round: (parsed.round as number) || 0,
          pct: (parsed.pct as number) || 0,
        }
        setState((prev) => ({ ...prev, progress }))
        addLog('progress', `Round ${progress.round}, Tick ${progress.tick} — ${(progress.pct * 100).toFixed(1)}%`)
      } else if (parsed.type === 'log') {
        const level = (parsed.level as string) || 'info'
        const msg = (parsed.msg as string) || ''
        addLog(level as 'info' | 'warn' | 'error', msg)
      } else if (parsed.type === 'error') {
        const msg = (parsed.msg as string) || 'Unknown error'
        addLog('error', msg)
        setState((prev) => ({ ...prev, error: msg }))
      }
    }

    const handleExit = (data: { code: number | null; signal: string | null; processId?: string }) => {
      setState((prev) => ({
        ...prev,
        // Only hide sidebar on error/stop; when code === 0 we may have more demos in queue
        isParsing: data.code !== 0,
        error: data.code === 0 ? null : prev.error,
        queueTotal: data.code === 0 ? Math.max(0, prev.queueTotal - 1) : prev.queueTotal,
      }))
      if (data.code === 0) {
        addLog('info', 'Parsing completed successfully')
      }
    }

    const unsubStarted = window.electronAPI.onParserStarted(handleStarted)
    const unsubMessage = window.electronAPI.onParserMessage(handleMessage)
    const unsubExit = window.electronAPI.onParserExit(handleExit)

    return () => {
      unsubStarted()
      unsubMessage()
      unsubExit()
    }
  }, [addLog])

  const stopParsing = useCallback(async () => {
    if (window.electronAPI) {
      try {
        await window.electronAPI.stopParser()
      } catch (e) {
        console.warn('Stop parser:', e)
      }
    }
  }, [])

  const setQueueTotal = useCallback((n: number) => {
    setState((prev) => ({ ...prev, queueTotal: n }))
  }, [])

  const setParsingEnded = useCallback(() => {
    setState((prev) => ({ ...prev, isParsing: false }))
  }, [])

  const value: ParsingStatusContextValue = {
    ...state,
    showParsingPanel,
    openParsingPanel: () => setShowParsingPanel(true),
    closeParsingPanel: () => setShowParsingPanel(false),
    stopParsing,
    setQueueTotal,
    setParsingEnded,
  }

  return (
    <ParsingStatusContext.Provider value={value}>
      {children}
    </ParsingStatusContext.Provider>
  )
}

export function useParsingStatus() {
  const ctx = useContext(ParsingStatusContext)
  if (!ctx) {
    throw new Error('useParsingStatus must be used within ParsingStatusProvider')
  }
  return ctx
}
