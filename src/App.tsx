import { useState, useEffect } from 'react'
import { Loader2 } from 'lucide-react'
import Sidebar from './components/Sidebar'
import MatchesScreen from './components/MatchesScreen'
import SettingsScreen from './components/SettingsScreen'
import DBViewerScreen from './components/DBViewerScreen'
import StatsScreen from './components/StatsScreen'
import WhatsNewModal from './components/WhatsNewModal'
import TitleBar from './components/TitleBar'

type Screen = 'matches' | 'settings' | 'dbviewer' | 'stats'

function App() {
  const [currentScreen, setCurrentScreen] = useState<Screen>('matches')
  const [isLoading, setIsLoading] = useState(true)
  const [enableDbViewer, setEnableDbViewer] = useState(false)
  const [showWhatsNew, setShowWhatsNew] = useState(false)
  const [appVersion, setAppVersion] = useState<string>('')

  useEffect(() => {
    // Check if electronAPI is available and app is ready
    const checkReady = async () => {
      if (window.electronAPI) {
        // Load DB viewer setting
        const dbViewerEnabled = await window.electronAPI.getSetting('enable_db_viewer', 'false')
        setEnableDbViewer(dbViewerEnabled === 'true')
        
        // Check if we should show What's New
        const shouldShow = await window.electronAPI.shouldShowWhatsNew()
        if (shouldShow) {
          // Get current app version
          const info = await window.electronAPI.getAppInfo()
          setAppVersion(info.version || '')
          setShowWhatsNew(true)
        }
        
        // Small delay to ensure everything is initialized
        setTimeout(() => {
          setIsLoading(false)
        }, 300)
      } else {
        // If electronAPI is not available (e.g., in browser), still show app after delay
        setTimeout(() => {
          setIsLoading(false)
        }, 500)
      }
    }

    checkReady()
  }, [])

  // Redirect from dbviewer if it's disabled
  useEffect(() => {
    if (currentScreen === 'dbviewer' && !enableDbViewer) {
      setCurrentScreen('matches')
    }
  }, [currentScreen, enableDbViewer])

  // Listen for navigation to DB viewer from context menu
  useEffect(() => {
    const handleNavigateToDbViewer = () => {
      if (enableDbViewer) {
        setCurrentScreen('dbviewer')
      }
    }
    window.addEventListener('navigateToDbViewer', handleNavigateToDbViewer)
    return () => window.removeEventListener('navigateToDbViewer', handleNavigateToDbViewer)
  }, [enableDbViewer])

  if (isLoading) {
    return (
      <div className="flex h-screen bg-primary text-white items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="w-12 h-12 text-accent animate-spin" />
          <p className="text-gray-400 text-sm">Loading CS2 Demo Analyzer...</p>
        </div>
      </div>
    )
  }

  const handleWhatsNewClose = async () => {
    setShowWhatsNew(false)
    // Update last seen version to current version
    if (window.electronAPI && appVersion) {
      await window.electronAPI.setLastSeenVersion(appVersion)
    }
  }

  return (
    <div className="flex flex-col h-screen bg-primary text-white overflow-hidden">
      <TitleBar />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar currentScreen={currentScreen} onNavigate={setCurrentScreen} />
        <main className="flex-1 flex flex-col overflow-hidden">
          {currentScreen === 'matches' && <MatchesScreen />}
          {currentScreen === 'settings' && <SettingsScreen />}
          {currentScreen === 'dbviewer' && <DBViewerScreen />}
          {currentScreen === 'stats' && <StatsScreen />}
        </main>
      </div>
      {showWhatsNew && appVersion && (
        <WhatsNewModal version={appVersion} onClose={handleWhatsNewClose} />
      )}
    </div>
  )
}

export default App

