import { useEffect, useRef, useState } from 'react'
import { Copy, Check } from 'lucide-react'
import Modal from './Modal'

interface ParserLogsModalProps {
  isOpen: boolean
  onClose: () => void
  matchId: string
}

export default function ParserLogsModal({ isOpen, onClose, matchId }: ParserLogsModalProps) {
  const [logs, setLogs] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const logsRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isOpen || !matchId) return

    const fetchLogs = async () => {
      setLoading(true)
      setError(null)
      try {
        const result = await window.electronAPI.getMatchParserLogs(matchId)
        setLogs(result.logs || 'No logs available for this demo')
      } catch (err) {
        setError(`Failed to load parser logs: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        setLoading(false)
      }
    }

    fetchLogs()
  }, [isOpen, matchId])

  const handleCopyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(logs)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      setError(`Failed to copy to clipboard: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Parser Logs" size="xl">
      <div className="flex flex-col h-[600px]">
        {loading && (
          <div className="flex items-center justify-center h-full">
            <div className="text-gray-400">Loading parser logs...</div>
          </div>
        )}

        {error && (
          <div className="flex items-center justify-center h-full">
            <div className="text-red-400">{error}</div>
          </div>
        )}

        {!loading && !error && (
          <>
            <div className="flex justify-end mb-4">
              <button
                onClick={handleCopyToClipboard}
                className="flex items-center gap-2 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded text-sm transition-colors"
              >
                {copied ? (
                  <>
                    <Check size={16} />
                    Copied!
                  </>
                ) : (
                  <>
                    <Copy size={16} />
                    Copy to Clipboard
                  </>
                )}
              </button>
            </div>

            <div
              ref={logsRef}
              className="flex-1 bg-gray-950 rounded border border-gray-700 p-4 overflow-auto font-mono text-sm text-gray-300"
            >
              {logs.split('\n').map((line, index) => (
                <div key={index} className="whitespace-pre-wrap break-words">
                  {line}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}
