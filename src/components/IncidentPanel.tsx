import { useState, useEffect } from 'react'
import { Loader2, ArrowLeft } from 'lucide-react'
import type { Incident } from '../types/electron'

interface IncidentPanelProps {
  incident: Incident | null,
  interactive: boolean
  onBack?: () => void
  externalLoading?: boolean
}

function IncidentPanel({ incident, interactive, onBack, externalLoading = false }: IncidentPanelProps) {
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'loading' } | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [spectatingPlayer, setSpectatingPlayer] = useState<string | null>(null)
  
  // Show loading state when external loading is triggered (e.g., event selection)
  useEffect(() => {
    if (externalLoading) {
      setIsLoading(true)
      setToast({ 
        message: 'Loading...', 
        type: 'loading' 
      })
    }
  }, [externalLoading])

  // Listen for action results from main process via IPC
  useEffect(() => {
    if (!window.electronAPI) return

    window.electronAPI.overlay.onActionResult((result) => {
      const { success, action, player, error, clearLoadingOnly } = result
      
      // Clear loading state when player has been selected (clearLoadingOnly means player was successfully spectated)
      if (clearLoadingOnly) {
        setIsLoading(false)
      }
      
      if (success && player && player !== 'Event playback successful') {
        // Update spectating player info (for display in UI)
        // Don't update if it's the final success message
        if (action === 'viewOffender' || action === 'viewVictim') {
          setSpectatingPlayer(player)
        }
      }
      
      // Only show toast if not clearLoadingOnly flag
      if (!clearLoadingOnly) {
        setIsLoading(false) // Also clear loading for non-clearLoadingOnly results
        if (success) {
          setToast({ 
            message: player || 'Success', 
            type: 'success' 
          })
          setTimeout(() => setToast(null), 3000)
        } else {
          setToast({ 
            message: error || `Failed to spectate ${action === 'viewOffender' ? 'offender' : 'victim'}`, 
            type: 'error' 
          })
          setTimeout(() => setToast(null), 3000)
        }
      }
      // If clearLoadingOnly is true, just clear loading state without showing toast
    })
  }, [])

  if (!incident) {
    return null
  }

  const handleViewOffender = async () => {
    if (!window.electronAPI || isLoading) return
    
    setIsLoading(true)
    setToast({ 
      message: 'Loading...', 
      type: 'loading' 
    })
    
    try {
      await window.electronAPI.overlay.actions.viewOffender()
      // Toast will be updated via onActionResult listener
    } catch (err) {
      setIsLoading(false)
      setToast({ 
        message: err instanceof Error ? err.message : 'Failed to spectate offender', 
        type: 'error' 
      })
      setTimeout(() => setToast(null), 3000)
    }
  }

  const handleViewVictim = async () => {
    if (!window.electronAPI || isLoading) return
    
    setIsLoading(true)
    setToast({ 
      message: 'Loading...', 
      type: 'loading' 
    })
    
    try {
      await window.electronAPI.overlay.actions.viewVictim()
      // Toast will be updated via onActionResult listener
    } catch (err) {
      setIsLoading(false)
      setToast({ 
        message: err instanceof Error ? err.message : 'Failed to spectate victim', 
        type: 'error' 
      })
      setTimeout(() => setToast(null), 3000)
    }
  }


  return (
    <div className="bg-primary/95 backdrop-blur-sm rounded-lg border border-border/50 p-4 shadow-xl min-w-[300px] max-w-sm">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          {onBack && (
            <button
              onClick={onBack}
              className="p-1.5 hover:bg-surface/50 rounded transition-colors flex-shrink-0"
              title="Back to events"
            >
              <ArrowLeft className="w-4 h-4 text-white" />
            </button>
          )}
          <h3 className="text-white text-base font-semibold">Perspective</h3>
        </div>
        {spectatingPlayer && (
          <div className="text-xs text-gray-400">
            Spectating: <span className="text-gray-300 font-medium">{spectatingPlayer}</span>
          </div>
        )}
      </div>
      
      <div className="space-y-4 mb-4">
        {incident.eventType && (
          <div className="bg-surface/50 rounded p-3 border border-border/30">
            <div className="text-xs text-gray-400 mb-1.5 uppercase tracking-wide">Event Type</div>
            <div className="text-white text-base font-semibold">
              {incident.eventType.split('_').map(word => word.charAt(0) + word.slice(1).toLowerCase()).join(' ')}
            </div>
          </div>
        )}
        <div className="bg-surface/50 rounded p-3 border border-border/30">
          <div className="text-xs text-gray-400 mb-1.5 uppercase tracking-wide">Offender</div>
          <div className="text-white text-base font-semibold">
            {incident.offender.name}
          </div>
        </div>
        
        <div className="bg-surface/50 rounded p-3 border border-border/30">
          <div className="text-xs text-gray-400 mb-1.5 uppercase tracking-wide">Victim</div>
          <div className="text-white text-base font-semibold">
            {incident.victim.name}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-2.5" >
        {interactive && (
          <>
        <button
            onClick={handleViewOffender}
            disabled={isLoading}
            className="px-4 py-2.5 bg-accent hover:bg-accent/80 active:bg-accent/70 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold rounded transition-colors shadow-md flex items-center justify-center gap-2"
            >
            {isLoading && <Loader2 className="w-4 h-4 animate-spin" />}
            View Offender
            </button>
            <button
            onClick={handleViewVictim}
            disabled={isLoading}
            className="px-4 py-2.5 bg-surface hover:bg-surface/80 active:bg-surface/70 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold rounded border border-border transition-colors flex items-center justify-center gap-2"
            >
            {isLoading && <Loader2 className="w-4 h-4 animate-spin" />}
            View Victim
        </button>
        </>
        )}
      </div>

      {toast && (
        <div className={`mt-3 px-3 py-2 rounded text-xs font-medium flex items-center gap-2 ${
          toast.type === 'success' 
            ? 'bg-green-500/20 text-green-300 border border-green-500/30' 
            : toast.type === 'loading'
            ? 'bg-blue-500/20 text-blue-300 border border-blue-500/30'
            : 'bg-red-500/20 text-red-300 border border-red-500/30'
        }`}>
          {toast.type === 'loading' && <Loader2 className="w-3 h-3 animate-spin flex-shrink-0" />}
          {toast.message}
        </div>
      )}
    </div>
  )
}

export default IncidentPanel
