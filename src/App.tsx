import { useState, useEffect } from 'react'
import { Loader2, Download } from 'lucide-react'
import Sidebar from './components/Sidebar'
import MatchesScreen from './components/MatchesScreen'
import SettingsScreen from './components/SettingsScreen'
import DBViewerScreen from './components/DBViewerScreen'
import Modal from './components/Modal'

type Screen = 'matches' | 'settings' | 'dbviewer'

function App() {
  const [currentScreen, setCurrentScreen] = useState<Screen>('matches')
  const [isLoading, setIsLoading] = useState(true)
  const [enableDbViewer, setEnableDbViewer] = useState(false)
  const [updateAvailable, setUpdateAvailable] = useState(false)
  const [updateVersion, setUpdateVersion] = useState<string | null>(null)
  const [updateReleaseUrl, setUpdateReleaseUrl] = useState<string | null>(null)
  const [currentVersion, setCurrentVersion] = useState<string>('1.0.0')

  useEffect(() => {
    // Check if electronAPI is available and app is ready
    const checkReady = async () => {
      if (window.electronAPI) {
        // Load DB viewer setting
        const dbViewerEnabled = await window.electronAPI.getSetting('enable_db_viewer', 'false')
        setEnableDbViewer(dbViewerEnabled === 'true')
        
        // Check for updates on startup
        try {
          const appInfo = await window.electronAPI.getAppInfo()
          setCurrentVersion(appInfo.version)
          if (appInfo.updateAvailable && appInfo.updateVersion && appInfo.updateReleaseUrl) {
            setUpdateAvailable(true)
            setUpdateVersion(appInfo.updateVersion)
            setUpdateReleaseUrl(appInfo.updateReleaseUrl)
          }
        } catch (error) {
          console.error('Error checking for updates:', error)
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

  const handleDownloadUpdate = async () => {
    if (updateReleaseUrl && window.electronAPI?.openExternal) {
      await window.electronAPI.openExternal(updateReleaseUrl)
    } else if (updateReleaseUrl) {
      window.open(updateReleaseUrl, '_blank')
    }
    setUpdateAvailable(false)
  }

  const handleDismissUpdate = () => {
    setUpdateAvailable(false)
  }

  return (
    <div className="flex h-screen bg-primary text-white overflow-hidden">
      <Sidebar currentScreen={currentScreen} onNavigate={setCurrentScreen} />
      <main className="flex-1 flex flex-col">
        {currentScreen === 'matches' && <MatchesScreen />}
        {currentScreen === 'settings' && <SettingsScreen />}
        {currentScreen === 'dbviewer' && <DBViewerScreen />}
      </main>

      {/* Update Available Modal */}
      <Modal
        isOpen={updateAvailable}
        onClose={handleDismissUpdate}
        title="Update Available"
        size="md"
        footer={
          <div className="flex items-center justify-end gap-3">
            <button
              onClick={handleDismissUpdate}
              className="px-4 py-2 text-gray-300 hover:text-white transition-colors"
            >
              Later
            </button>
            <button
              onClick={handleDownloadUpdate}
              className="px-4 py-2 bg-accent hover:bg-accent/90 text-white rounded transition-colors flex items-center gap-2"
            >
              <Download size={16} />
              Download Update
            </button>
          </div>
        }
      >
        <div className="space-y-4">
          <p className="text-gray-300">
            A new version of CS2 Demo Analyzer is available!
          </p>
          <div className="bg-surface/50 border border-border rounded p-3">
            <div className="flex items-center justify-between">
              <span className="text-gray-400 text-sm">Current Version:</span>
              <span className="text-white font-mono text-sm">v{currentVersion}</span>
            </div>
            <div className="flex items-center justify-between mt-2">
              <span className="text-accent text-sm font-medium">New Version:</span>
              <span className="text-accent font-mono text-sm font-semibold">v{updateVersion}</span>
            </div>
          </div>
          <p className="text-gray-400 text-sm">
            Download the latest version to get new features and bug fixes.
          </p>
        </div>
      </Modal>
    </div>
  )
}

export default App

