/**
 * Utility functions for mapping keyboard accelerators to keyboard icon paths
 */

/**
 * Map Electron accelerator keys to keyboard icon file names
 */
function mapKeyToIconName(key: string): string {
  const normalized = key.toLowerCase().trim()
  
  // Modifier keys
  if (normalized === 'commandorcontrol' || normalized === 'control' || normalized === 'ctrl') {
    return 'keyboard_ctrl'
  }
  if (normalized === 'command' || normalized === 'cmd') {
    return 'keyboard_command'
  }
  if (normalized === 'alt' || normalized === 'option') {
    return 'keyboard_alt'
  }
  if (normalized === 'shift') {
    return 'keyboard_shift'
  }
  if (normalized === 'meta' || normalized === 'super') {
    return 'keyboard_win'
  }
  
  // Special keys
  if (normalized === 'plus' || normalized === '+') {
    return 'keyboard_plus'
  }
  if (normalized === 'space') {
    return 'keyboard_space'
  }
  if (normalized === 'tab') {
    return 'keyboard_tab'
  }
  if (normalized === 'enter' || normalized === 'return') {
    return 'keyboard_return'
  }
  if (normalized === 'escape' || normalized === 'esc') {
    return 'keyboard_escape'
  }
  if (normalized === 'backspace') {
    return 'keyboard_backspace'
  }
  if (normalized === 'delete' || normalized === 'del') {
    return 'keyboard_delete'
  }
  
  // Function keys
  if (normalized.startsWith('f') && /^f\d+$/.test(normalized)) {
    return `keyboard_${normalized}`
  }
  
  // Arrow keys
  if (normalized === 'up' || normalized === 'arrowup') {
    return 'keyboard_arrow_up'
  }
  if (normalized === 'down' || normalized === 'arrowdown') {
    return 'keyboard_arrow_down'
  }
  if (normalized === 'left' || normalized === 'arrowleft') {
    return 'keyboard_arrow_left'
  }
  if (normalized === 'right' || normalized === 'arrowright') {
    return 'keyboard_arrow_right'
  }
  
  // Numbers
  if (/^\d$/.test(normalized)) {
    return `keyboard_${normalized}`
  }
  
  // Letters (single character)
  if (/^[a-z]$/.test(normalized)) {
    return `keyboard_${normalized}`
  }
  
  // Default fallback
  return 'keyboard_any'
}

/**
 * Parse an Electron accelerator string and return icon paths for each key
 * @param accelerator - Electron accelerator string (e.g., "CommandOrControl+Shift+O")
 * @returns Array of icon file names (without extension)
 */
export function parseAcceleratorToIcons(accelerator: string): string[] {
  if (!accelerator) {
    return []
  }
  
  // Split by + and map each key to its icon name
  const keys = accelerator.split('+').map(key => key.trim())
  return keys.map(key => mapKeyToIconName(key))
}

/**
 * Get keyboard icon as base64 data URL via IPC
 * @param iconName - Icon name without extension (e.g., "keyboard_ctrl")
 * @returns Promise resolving to base64 data URL or null if not found
 */
export async function getKeyboardIconDataUrl(iconName: string): Promise<string | null> {
  if (!window.electronAPI?.getKeyboardIcon) {
    return null
  }
  
  try {
    const result = await window.electronAPI.getKeyboardIcon(iconName)
    if (result.success && result.data) {
      return result.data
    }
    // Try outline version as fallback
    const outlineResult = await window.electronAPI.getKeyboardIcon(`${iconName}_outline`)
    if (outlineResult.success && outlineResult.data) {
      return outlineResult.data
    }
    return null
  } catch (error) {
    console.error(`Failed to load keyboard icon ${iconName}:`, error)
    return null
  }
}
