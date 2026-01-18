import { useState, useEffect } from 'react'
import { Loader2 } from 'lucide-react'
import Sidebar from './components/Sidebar'
import MatchesScreen from './components/MatchesScreen'
import SettingsScreen from './components/SettingsScreen'
import DBViewerScreen from './components/DBViewerScreen'

type Screen = 'matches' | 'settings' | 'dbviewer'

function App() {
  const [currentScreen, setCurrentScreen] = useState<Screen>('matches')
  const [isLoading, setIsLoading] = useState(true)
  const [enableDbViewer, setEnableDbViewer] = useState(false)

  useEffect(() => {
    // Check if electronAPI is available and app is ready
    const checkReady = async () => {
      if (window.electronAPI) {
        // Load DB viewer setting
        const dbViewerEnabled = await window.electronAPI.getSetting('enable_db_viewer', 'false')
        setEnableDbViewer(dbViewerEnabled === 'true')
        
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

  return (
    <div className="flex h-screen bg-primary text-white overflow-hidden">
      <Sidebar currentScreen={currentScreen} onNavigate={setCurrentScreen} />
      <main className="flex-1 flex flex-col">
        {currentScreen === 'matches' && <MatchesScreen />}
        {currentScreen === 'settings' && <SettingsScreen />}
        {currentScreen === 'dbviewer' && <DBViewerScreen />}
      </main>
    </div>
  )
}

export default App

