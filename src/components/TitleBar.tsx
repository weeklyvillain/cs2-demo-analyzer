import { useState, useEffect } from 'react'
import { Minus, Square, X, Maximize2 } from 'lucide-react'

export default function TitleBar() {
  const [isMaximized, setIsMaximized] = useState(false)

  useEffect(() => {
    // Check initial maximized state
    const checkMaximized = async () => {
      if (window.electronAPI) {
        const maximized = await window.electronAPI.windowIsMaximized()
        setIsMaximized(maximized)
      }
    }
    checkMaximized()

    // Listen for window maximize/unmaximize events
    if (window.electronAPI) {
      window.electronAPI.onWindowMaximized((maximized) => {
        setIsMaximized(maximized)
      })
    }

    return () => {
      if (window.electronAPI) {
        window.electronAPI.removeAllListeners('window:maximized')
      }
    }
  }, [])

  const handleMinimize = async () => {
    if (window.electronAPI) {
      await window.electronAPI.windowMinimize()
    }
  }

  const handleMaximize = async () => {
    if (window.electronAPI) {
      await window.electronAPI.windowMaximize()
      // State will be updated via the event listener
    }
  }

  const handleClose = async () => {
    if (window.electronAPI) {
      await window.electronAPI.windowClose()
    }
  }

  return (
    <div 
      className="h-8 bg-surface border-b border-gray-700 flex items-center justify-between px-2 select-none"
      style={{ 
        WebkitAppRegion: 'drag',
        appRegion: 'drag' as any
      }}
    >
      <div className="flex items-center gap-2 px-2">
        <span className="text-sm text-gray-300 font-medium">CS2 Demo Analyzer</span>
      </div>
      
      <div 
        className="flex items-center"
        style={{ 
          WebkitAppRegion: 'no-drag',
          appRegion: 'no-drag' as any
        }}
      >
        <button
          onClick={handleMinimize}
          className="w-10 h-8 flex items-center justify-center hover:bg-gray-700/50 transition-colors text-gray-300 hover:text-white"
          title="Minimize"
        >
          <Minus size={16} />
        </button>
        
        <button
          onClick={handleMaximize}
          className="w-10 h-8 flex items-center justify-center hover:bg-gray-700/50 transition-colors text-gray-300 hover:text-white"
          title={isMaximized ? "Restore" : "Maximize"}
        >
          {isMaximized ? <Square size={14} /> : <Maximize2 size={14} />}
        </button>
        
        <button
          onClick={handleClose}
          className="w-10 h-8 flex items-center justify-center hover:bg-red-600 transition-colors text-gray-300 hover:text-white"
          title="Close"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  )
}
