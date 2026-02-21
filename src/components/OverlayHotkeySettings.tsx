import { useState, useEffect, useRef } from 'react'
import { parseAcceleratorToIcons, getKeyboardIconDataUrl } from '../utils/keyboardIcons'

function OverlayHotkeySettings() {
  const [hotkey, setHotkey] = useState<string>('')
  const [isRecording, setIsRecording] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [keyboardIcons, setKeyboardIcons] = useState<Map<string, string>>(new Map())
  const recordingRef = useRef(false)
  const keysRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    loadHotkey()
  }, [])

  useEffect(() => {
    if (hotkey) {
      loadKeyboardIcons()
    }
  }, [hotkey])

  const loadHotkey = async () => {
    if (!window.electronAPI) return
    try {
      const savedHotkey = await window.electronAPI.settings.getHotkey()
      setHotkey(savedHotkey)
    } catch (err) {
      console.error('Failed to load hotkey:', err)
    }
  }

  const loadKeyboardIcons = async () => {
    if (!hotkey) return

    const iconNames = parseAcceleratorToIcons(hotkey)
    const iconMap = new Map<string, string>()

    for (const iconName of iconNames) {
      const dataUrl = await getKeyboardIconDataUrl(iconName)
      if (dataUrl) {
        iconMap.set(iconName, dataUrl)
      }
    }

    setKeyboardIcons(iconMap)
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

      const modifiers: string[] = []
      const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0

      if (e.ctrlKey || e.metaKey) {
        modifiers.push(isMac ? 'Command' : 'Control')
      }
      if (e.altKey) modifiers.push('Alt')
      if (e.shiftKey) modifiers.push('Shift')

      // Map special keys to Electron accelerator format
      // Check e.key directly for arrow keys before lowercasing
      let keyName: string
      const originalKey = e.key
      
      if (originalKey === ' ') {
        keyName = 'Space'
      } else if (originalKey.startsWith('Arrow') || originalKey.toLowerCase().startsWith('arrow')) {
        // Arrow keys: ArrowUp -> Up, ArrowDown -> Down, etc.
        // Handle both "ArrowUp" and "arrowup" formats
        const arrowKey = originalKey.toLowerCase()
        if (arrowKey === 'arrowup') keyName = 'Up'
        else if (arrowKey === 'arrowdown') keyName = 'Down'
        else if (arrowKey === 'arrowleft') keyName = 'Left'
        else if (arrowKey === 'arrowright') keyName = 'Right'
        else {
          // Fallback: try to extract direction
          const direction = originalKey.replace(/^arrow/i, '')
          keyName = direction.charAt(0).toUpperCase() + direction.slice(1).toLowerCase()
        }
      } else {
        const key = originalKey.toLowerCase()
        
        // Ignore modifier-only keys
        if (['control', 'meta', 'alt', 'shift'].includes(key)) {
          return
        }
        
        if (key.length === 1) {
          keyName = key.toUpperCase()
        } else {
          // Other special keys: capitalize first letter
          keyName = key.charAt(0).toUpperCase() + key.slice(1)
        }
      }

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
            <div className="flex-1 px-3 py-2 bg-surface border border-border rounded text-white text-sm flex items-center gap-1.5 min-h-[36px]">
              {hotkey ? (
                parseAcceleratorToIcons(hotkey).length > 0 ? (
                  <div className="flex items-center gap-1">
                    {parseAcceleratorToIcons(hotkey).map((iconName, index) => {
                      const iconDataUrl = keyboardIcons.get(iconName)
                      const iconNames = parseAcceleratorToIcons(hotkey)
                      // Modifier keys should be larger
                      const isModifier = ['keyboard_ctrl', 'keyboard_shift', 'keyboard_alt', 'keyboard_command', 'keyboard_win'].includes(iconName)
                      const iconSize = isModifier ? 'h-8 w-8' : 'h-6 w-6'
                      return (
                        <span key={`${iconName}-${index}`} className="flex items-center">
                          {iconDataUrl ? (
                            <img
                              src={iconDataUrl}
                              alt={iconName}
                              className={`${iconSize} object-contain`}
                              style={{ 
                                filter: 'brightness(0) invert(1)',
                                imageRendering: 'crisp-edges'
                              }}
                            />
                          ) : (
                            <span className="text-sm text-white font-mono bg-surface/50 px-1.5 py-0.5 rounded min-w-[24px] text-center">
                              {iconName.replace('keyboard_', '').replace('_outline', '').toUpperCase()}
                            </span>
                          )}
                          {index < iconNames.length - 1 && (
                            <span className="text-gray-400 mx-0.5 text-xs font-medium">+</span>
                          )}
                        </span>
                      )
                    })}
                  </div>
                ) : (
                  <span className="text-gray-400">{formatHotkey(hotkey)}</span>
                )
              ) : (
                <span className="text-gray-400">Not set</span>
              )}
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
            <strong>Note:</strong> Press the hotkey to toggle the overlay (show/hide).
          </p>
        </div>
    </div>
  )
}

export default OverlayHotkeySettings
