import { useState, useEffect } from 'react'
import { t } from '../utils/translations'
import { useParsingStatus } from '../contexts/ParsingStatusContext'

interface SidebarProps {
  currentScreen: 'matches' | 'settings' | 'dbviewer' | 'stats' | 'unparsed'
  onNavigate: (screen: 'matches' | 'settings' | 'dbviewer' | 'stats' | 'unparsed') => void
}

const SIZE = 44
const STROKE = 4
const R = (SIZE - STROKE) / 2
const CIRCUMFERENCE = 2 * Math.PI * R

function Sidebar({ currentScreen, onNavigate }: SidebarProps) {
  const [enableDbViewer, setEnableDbViewer] = useState(false)
  const [logoUrl, setLogoUrl] = useState<string | null>(null)
  const [, forceUpdate] = useState(0)
  const { isParsing, progress, demoFileName, queueTotal, openParsingPanel, stopParsing } = useParsingStatus()

  // Open the parsing details panel only (progress + logs). Do not reopen the queue modal.
  const handleOpenParsing = () => openParsingPanel()

  useEffect(() => {
    const loadSetting = async () => {
      if (window.electronAPI) {
        const value = await window.electronAPI.getSetting('enable_db_viewer', 'false')
        setEnableDbViewer(value === 'true')
      }
    }
    loadSetting()

    // Listen for setting changes
    const interval = setInterval(loadSetting, 1000) // Check every second
    return () => clearInterval(interval)
  }, [])

  // Load logo image
  useEffect(() => {
    const loadLogo = async () => {
      if (window.electronAPI?.getLogoImage) {
        try {
          const result = await window.electronAPI.getLogoImage()
          if (result.success && result.data) {
            setLogoUrl(result.data)
          }
        } catch (error) {
          console.error('Failed to load logo:', error)
        }
      }
    }
    loadLogo()
  }, [])

  // Subscribe to language changes
  useEffect(() => {
    const checkLanguage = () => {
      forceUpdate((prev) => prev + 1)
    }
    const interval = setInterval(checkLanguage, 1000)
    return () => clearInterval(interval)
  }, [])

  const pct = progress ? Math.min(1, Math.max(0, progress.pct)) : 0
  const strokeDashoffset = CIRCUMFERENCE * (1 - pct)

  return (
    <aside className="w-64 bg-secondary border-r border-border flex flex-col">
      <div className="p-4 border-b border-border">
        <div className="flex items-center gap-3">
          {logoUrl && (
            <img 
              src={logoUrl} 
              alt={t('sidebar.logo')} 
              className="w-16 h-16 object-contain flex-shrink-0"
            />
          )}
          <div className="flex-1 min-w-0">
            <h1 className="text-lg font-bold text-white leading-tight">
              <span className="bg-gradient-to-r from-accent to-orange-400 bg-clip-text text-transparent">
                CS2 Demo
              </span>
              <br />
              <span className="text-gray-300 text-sm font-semibold">Analyzer</span>
            </h1>
          </div>
        </div>
      </div>
      <nav className="flex-1 p-4">
        <ul className="space-y-2">
          <li>
            <button
              onClick={() => onNavigate('matches')}
              className={`w-full text-left block px-4 py-2 rounded transition-colors ${
                currentScreen === 'matches'
                  ? 'bg-surface text-accent font-medium'
                  : 'text-gray-400 hover:bg-surface hover:text-white'
              }`}
            >
              {t('sidebar.matches')}
            </button>
          </li>
          <li>
            <button
              onClick={() => onNavigate('unparsed')}
              className={`w-full text-left block px-4 py-2 rounded transition-colors ${
                currentScreen === 'unparsed'
                  ? 'bg-surface text-accent font-medium'
                  : 'text-gray-400 hover:bg-surface hover:text-white'
              }`}
            >
              {t('sidebar.unparsedDemos')}
            </button>
          </li>
          <li>
            <button
              onClick={() => onNavigate('stats')}
              className={`w-full text-left block px-4 py-2 rounded transition-colors ${
                currentScreen === 'stats'
                  ? 'bg-surface text-accent font-medium'
                  : 'text-gray-400 hover:bg-surface hover:text-white'
              }`}
            >
              {t('sidebar.statistics')}
            </button>
          </li>
          <li>
            <button
              onClick={() => onNavigate('settings')}
              className={`w-full text-left block px-4 py-2 rounded transition-colors ${
                currentScreen === 'settings'
                  ? 'bg-surface text-accent font-medium'
                  : 'text-gray-400 hover:bg-surface hover:text-white'
              }`}
            >
              {t('sidebar.settings')}
            </button>
          </li>
          {enableDbViewer && (
            <li>
              <button
                onClick={() => onNavigate('dbviewer')}
                className={`w-full text-left block px-4 py-2 rounded transition-colors ${
                  currentScreen === 'dbviewer'
                    ? 'bg-surface text-accent font-medium'
                    : 'text-gray-400 hover:bg-surface hover:text-white'
                }`}
              >
                {t('sidebar.dbViewer')}
              </button>
            </li>
          )}
        </ul>
      </nav>

      {/* Bottom: parsing progress when active */}
      {isParsing && (
        <div className="p-4 border-t border-border flex-shrink-0">
          <div className="rounded-lg bg-surface border border-border p-3 space-y-3">
            <div className="flex items-center gap-3">
              <div className="relative flex-shrink-0" style={{ width: SIZE, height: SIZE }}>
                <svg width={SIZE} height={SIZE} className="rotate-[-90deg]">
                  <circle
                    cx={SIZE / 2}
                    cy={SIZE / 2}
                    r={R}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={STROKE}
                    className="text-border"
                  />
                  <circle
                    cx={SIZE / 2}
                    cy={SIZE / 2}
                    r={R}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={STROKE}
                    strokeLinecap="round"
                    className="text-accent transition-all duration-300"
                    strokeDasharray={CIRCUMFERENCE}
                    strokeDashoffset={strokeDashoffset}
                  />
                </svg>
                <span className="absolute inset-0 flex items-center justify-center text-xs font-medium text-gray-300">
                  {Math.round(pct * 100)}%
                </span>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-white truncate">
                  {t('sidebar.parsing')}
                  {demoFileName ? `: ${demoFileName}` : ''}
                </p>
                <p className="text-xs text-gray-500">
                  {t('sidebar.parsingRemaining').replace('{count}', String(queueTotal ?? 1))}
                </p>
              </div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleOpenParsing}
                className="flex-1 px-3 py-1.5 text-xs bg-surface border border-border text-gray-300 rounded hover:bg-white/10 hover:text-white transition-colors"
              >
                {t('sidebar.openParsing')}
              </button>
              <button
                onClick={() => stopParsing()}
                className="px-3 py-1.5 text-xs bg-red-600/80 text-white rounded hover:bg-red-600 transition-colors"
              >
                {t('sidebar.stopParsing')}
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  )
}

export default Sidebar

