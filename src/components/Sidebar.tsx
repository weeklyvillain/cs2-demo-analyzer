import { useState, useEffect } from 'react'
import { t, getLanguage } from '../utils/translations'

interface SidebarProps {
  currentScreen: 'matches' | 'settings' | 'dbviewer' | 'stats' | 'unparsed'
  onNavigate: (screen: 'matches' | 'settings' | 'dbviewer' | 'stats' | 'unparsed') => void
}

function Sidebar({ currentScreen, onNavigate }: SidebarProps) {
  const [enableDbViewer, setEnableDbViewer] = useState(false)
  const [logoUrl, setLogoUrl] = useState<string | null>(null)
  const [, forceUpdate] = useState(0)

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
    // Check language every second (simple polling approach)
    const interval = setInterval(checkLanguage, 1000)
    return () => clearInterval(interval)
  }, [])

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
    </aside>
  )
}

export default Sidebar

