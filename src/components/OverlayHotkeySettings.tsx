import { useState, useEffect, useRef } from 'react'

function OverlayHotkeySettings() {
  const [hotkey, setHotkey] = useState<string>('')
  const [isRecording, setIsRecording] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const recordingRef = useRef(false)
  const keysRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    loadHotkey()
  }, [])

  const loadHotkey = async () => {
    if (!window.electronAPI) return
    try {
      const savedHotkey = await window.electronAPI.settings.getHotkey()
      setHotkey(savedHotkey)
    } catch (err) {
      console.error('Failed to load hotkey:', err)
    }
  }

  const formatHotkey = (accelerator: string): string => {
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0
    return accelerator
      .replace(/CommandOrControl/g, isMac ? '⌘' : 'Ctrl')
      .replace(/Command/g, '⌘')
      .replace(/Control/g, 'Ctrl')
      .replace(/Alt/g, 'Alt')
      .replace(/Shift/g, 'Shift')
      .replace(/\+/g, ' + ')
  }

  const startRecording = () => {
    setIsRecording(true)
    setError(null)
    setSuccess(false)
    recordingRef.current = true
    keysRef.current.clear()

    const handleKeyDown = (e: KeyboardEvent) => {
      if (!recordingRef.current) return

      e.preventDefault()
      e.stopPropagation()

      const key = e.key.toLowerCase()
      const modifiers: string[] = []
      const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0

      if (e.ctrlKey || e.metaKey) {
        modifiers.push(isMac ? 'Command' : 'Control')
      }
      if (e.altKey) modifiers.push('Alt')
      if (e.shiftKey) modifiers.push('Shift')

      // Ignore modifier-only keys
      if (['control', 'meta', 'alt', 'shift'].includes(key)) {
        return
      }

      // Map special keys
      let keyName = key
      if (key === ' ') keyName = 'Space'
      else if (key.length === 1) keyName = key.toUpperCase()
      else keyName = key.charAt(0).toUpperCase() + key.slice(1)

      const accelerator = modifiers.length > 0
        ? `${modifiers.join('+')}+${keyName}`
        : keyName

      // Stop recording and save
      recordingRef.current = false
      setIsRecording(false)
      saveHotkey(accelerator)

      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
    }

    const handleKeyUp = () => {
      // Reset on key up if no key was pressed
      if (keysRef.current.size === 0 && recordingRef.current) {
        // Keep listening
      }
    }

    window.addEventListener('keydown', handleKeyDown, true)
    window.addEventListener('keyup', handleKeyUp, true)

    // Cleanup after 10 seconds
    setTimeout(() => {
      if (recordingRef.current) {
        recordingRef.current = false
        setIsRecording(false)
        setError('Recording timeout. Please try again.')
        window.removeEventListener('keydown', handleKeyDown)
        window.removeEventListener('keyup', handleKeyUp)
      }
    }, 10000)
  }

  const saveHotkey = async (accelerator: string) => {
    if (!window.electronAPI) return

    setError(null)
    setSuccess(false)

    try {
      const result = await window.electronAPI.settings.setHotkey(accelerator)
      if (result.success) {
        setHotkey(accelerator)
        setSuccess(true)
        setTimeout(() => setSuccess(false), 2000)
      } else {
        setError(result.error || 'Failed to set hotkey')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to set hotkey')
    }
  }

  const resetHotkey = async () => {
    if (!window.electronAPI) return

    setError(null)
    setSuccess(false)

    try {
      const result = await window.electronAPI.settings.resetHotkey()
      if (result.success) {
        await loadHotkey()
        setSuccess(true)
        setTimeout(() => setSuccess(false), 2000)
      } else {
        setError(result.error || 'Failed to reset hotkey')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset hotkey')
    }
  }

  return (
    <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-2">
            Toggle Overlay Interactive Mode
          </label>
          <div className="flex items-center gap-3">
            <div className="flex-1 px-3 py-2 bg-surface border border-border rounded text-white text-sm">
              {hotkey ? formatHotkey(hotkey) : 'Not set'}
            </div>
            <button
              onClick={startRecording}
              disabled={isRecording}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white text-sm rounded transition-colors whitespace-nowrap"
            >
              {isRecording ? 'Press keys...' : 'Change Hotkey'}
            </button>
            <button
              onClick={resetHotkey}
              className="px-4 py-2 bg-gray-600 hover:bg-gray-700 text-white text-sm rounded transition-colors whitespace-nowrap"
            >
              Reset to Default
            </button>
          </div>
          <p className="text-xs text-gray-500 mt-1">
            Press the hotkey to toggle overlay interactive mode (click-through ↔ interactive).
            Default: Ctrl+Shift+O
          </p>
          {isRecording && (
            <p className="text-xs text-blue-400 mt-1">
              Recording... Press your desired key combination now.
            </p>
          )}
          {error && (
            <p className="text-xs text-red-400 mt-1">{error}</p>
          )}
          {success && (
            <p className="text-xs text-green-400 mt-1">Hotkey saved successfully!</p>
          )}
        </div>

        <div className="pt-2 border-t border-border">
          <p className="text-xs text-gray-400">
            <strong>Note:</strong> The overlay window must be created first before the hotkey will work.
            Use the overlay controls in the main application to show/hide the overlay.
          </p>
        </div>
    </div>
  )
}

export default OverlayHotkeySettings
