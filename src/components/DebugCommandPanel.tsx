import { useState, useEffect, useRef } from 'react'

interface CommandEntry {
  ts: number
  cmd: string
}

interface DebugCommandPanelProps {
  enabled: boolean
}

function DebugCommandPanel({ enabled }: DebugCommandPanelProps) {
  const [commandLog, setCommandLog] = useState<CommandEntry[]>([])
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const shouldAutoScrollRef = useRef(true)

  useEffect(() => {
    if (!enabled || !window.electronAPI) return

    window.electronAPI.overlay.onCommandLog((log) => {
      setCommandLog(log)
      // Auto-scroll to bottom when new commands arrive
      if (shouldAutoScrollRef.current) {
        setTimeout(() => {
          if (scrollContainerRef.current) {
            scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight
          }
        }, 10)
      }
    })
  }, [enabled])

  const formatTime = (timestamp: number): string => {
    const date = new Date(timestamp)
    const hours = date.getHours().toString().padStart(2, '0')
    const minutes = date.getMinutes().toString().padStart(2, '0')
    const seconds = date.getSeconds().toString().padStart(2, '0')
    return `${hours}:${minutes}:${seconds}`
  }

  const handleScroll = () => {
    if (!scrollContainerRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current
    // Auto-scroll if user is near bottom (within 50px)
    shouldAutoScrollRef.current = scrollHeight - scrollTop - clientHeight < 50
  }

  if (!enabled) {
    return null
  }

  return (
    <div className="absolute top-4 right-4 pointer-events-auto z-40">
      <div className="bg-primary/95 backdrop-blur-sm rounded-lg border border-border/50 p-3 shadow-xl min-w-[320px] max-w-md max-h-[400px] flex flex-col">
        <h3 className="text-white text-sm font-semibold mb-2">Debug: Commands</h3>
        
        <div
          ref={scrollContainerRef}
          onScroll={handleScroll}
          className="flex-1 overflow-y-auto space-y-1 pr-2"
          style={{ maxHeight: '320px' }}
        >
          {commandLog.length === 0 ? (
            <div className="text-gray-400 text-xs py-4 text-center">
              No commands sent yet
            </div>
          ) : (
            commandLog.map((entry, index) => (
              <div
                key={index}
                className="bg-surface/50 rounded p-2 text-xs font-mono"
              >
                <div className="flex items-start gap-2">
                  <span className="text-gray-400 flex-shrink-0">
                    {formatTime(entry.ts)}
                  </span>
                  <span className="text-gray-200 break-all">
                    {entry.cmd}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>
        
        {commandLog.length > 0 && (
          <div className="text-xs text-gray-400 mt-2 pt-2 border-t border-border/30">
            {commandLog.length} command{commandLog.length !== 1 ? 's' : ''}
          </div>
        )}
      </div>
    </div>
  )
}

export default DebugCommandPanel
