import { useRef, useEffect } from 'react'
import Modal from './Modal'
import { useParsingStatus } from '../contexts/ParsingStatusContext'
import { t } from '../utils/translations'

export default function ParsingPanelModal() {
  const {
    isParsing,
    progress,
    demoFileName,
    logs,
    error,
    showParsingPanel,
    closeParsingPanel,
    stopParsing,
  } = useParsingStatus()
  const logsEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (showParsingPanel && logs.length > 0) {
      logsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [showParsingPanel, logs.length])

  if (!showParsingPanel) return null

  const pct = progress ? Math.min(100, Math.max(0, progress.pct * 100)) : 0

  return (
    <Modal
      isOpen={true}
      onClose={closeParsingPanel}
      title={isParsing ? t('parsing.titleParsing') : t('parsing.titleDetails')}
      size="lg"
      canClose={true}
      footer={
        <div className="flex justify-end gap-2">
          {isParsing && (
            <button
              onClick={() => stopParsing()}
              className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 transition-colors text-sm"
            >
              {t('parsing.stop')}
            </button>
          )}
          <button
            onClick={closeParsingPanel}
            className="px-4 py-2 bg-surface border border-border text-white rounded hover:bg-surface/80 transition-colors text-sm"
          >
            {t('parsing.close')}
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        {demoFileName && (
          <div className="px-4 py-2 bg-surface rounded border border-border">
            <p className="text-xs text-gray-500 mb-1">{t('parsing.demoFile')}</p>
            <p className="text-sm text-gray-300 truncate" title={demoFileName}>
              {demoFileName}
            </p>
          </div>
        )}

        {progress && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-gray-400">
                {progress.stage} — {t('parsing.round')} {progress.round}, Tick {progress.tick}
              </span>
              <span className="text-gray-400">{pct.toFixed(1)}%</span>
            </div>
            <div className="w-full h-3 bg-surface rounded-full overflow-hidden border border-border">
              <div
                className="h-full bg-accent transition-all duration-300"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        )}

        {error && (
          <div className="p-3 bg-red-900/20 border border-red-500/50 rounded text-red-400 text-sm">
            {error}
          </div>
        )}

        <div
          className="flex flex-col bg-surface rounded border border-border overflow-hidden font-mono text-xs"
          style={{ height: '280px' }}
        >
          <div className="px-4 py-2 border-b border-border flex-shrink-0">
            <h3 className="text-sm font-medium text-gray-300">{t('parsing.consoleLog')}</h3>
          </div>
          <div className="flex-1 overflow-y-auto p-4 min-h-0">
            {logs.length === 0 ? (
              <p className="text-gray-500">{isParsing ? t('parsing.starting') : t('parsing.noLogs')}</p>
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
                  <span className="text-gray-500">[{log.timestamp.toLocaleTimeString()}]</span>{' '}
                  <span className="uppercase text-gray-500">{log.level}</span>: {log.message}
                </div>
              ))
            )}
            <div ref={logsEndRef} />
          </div>
        </div>
      </div>
    </Modal>
  )
}
