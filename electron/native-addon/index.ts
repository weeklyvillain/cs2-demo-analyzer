/**
 * TypeScript wrapper for CS2 window tracker native addon
 */

import * as path from 'path'
import * as fs from 'fs'
import { app } from 'electron'

// Try to load the native addon
let nativeAddon: any = null

try {
  // __dirname in compiled JS will be dist-electron/native-addon
  // The addon is built in electron/native-addon/build/Release
  // From dist-electron/native-addon, go up to project root, then to electron/native-addon
  
  // Try multiple possible paths
  const possiblePaths = [
    // Development/production: from dist-electron/native-addon to project root, then electron/native-addon
    path.resolve(__dirname, '..', '..', 'electron', 'native-addon', 'build', 'Release', 'cs2_window_tracker.node'),
    // Alternative: if we're in electron/native-addon directly (source location)
    path.resolve(__dirname, '..', '..', '..', 'electron', 'native-addon', 'build', 'Release', 'cs2_window_tracker.node'),
  ]
  
  let addonPath: string | null = null
  for (const testPath of possiblePaths) {
    if (fs.existsSync(testPath)) {
      addonPath = testPath
      nativeAddon = require(testPath)
      break
    }
  }
  
  if (addonPath && nativeAddon) {
    console.log('[CS2WindowTracker] Native addon loaded successfully from:', addonPath)
  } else {
    throw new Error(`Could not find native addon. Tried: ${possiblePaths.join(', ')}`)
  }
} catch (err) {
  console.error('[CS2WindowTracker] Failed to load native addon:', err)
  console.error('[CS2WindowTracker] Make sure to build the addon: npm run build:addon')
  console.error('[CS2WindowTracker] __dirname:', __dirname)
  // Don't throw - allow app to continue without overlay tracking
  // throw err
}

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface WinEvent {
  type: 'locationchange' | 'movestart' | 'moveend' | 'minimizestart' | 'minimizeend' | 'destroy' | 'foreground'
  hwnd: bigint
  pid?: number // Only present for 'foreground' events
}

/**
 * Find a window by process ID
 * @param pid Process ID
 * @returns Window handle (bigint) or null if not found
 */
export function findWindowByPid(pid: number): bigint | null {
  if (!nativeAddon) {
    console.warn('[CS2WindowTracker] Native addon not loaded, cannot find window')
    return null
  }
  try {
    const result = nativeAddon.findWindowByPid(pid)
    return result === null ? null : BigInt(result)
  } catch (err) {
    console.error('[CS2WindowTracker] Error in findWindowByPid:', err)
    return null
  }
}

/**
 * Find process ID by process name
 * @param processName Process name (e.g., "cs2.exe")
 * @returns Process ID or null if not found
 */
export function findProcessIdByName(processName: string): number | null {
  if (!nativeAddon) {
    console.warn('[CS2WindowTracker] Native addon not loaded, cannot find process')
    return null
  }
  try {
    const result = nativeAddon.findProcessIdByName(processName)
    return result === null ? null : Number(result)
  } catch (err) {
    console.error('[CS2WindowTracker] Error in findProcessIdByName:', err)
    return null
  }
}

/**
 * Get client bounds of a window in screen coordinates
 * @param hwnd Window handle
 * @returns Bounds object or null if failed
 */
export function getClientBoundsOnScreen(hwnd: bigint): WindowBounds | null {
  if (!nativeAddon) {
    console.warn('[CS2WindowTracker] Native addon not loaded, cannot get bounds')
    return null
  }
  try {
    const result = nativeAddon.getClientBoundsOnScreen(hwnd)
    if (!result) {
      return null
    }
    return {
      x: Number(result.x),
      y: Number(result.y),
      width: Number(result.width),
      height: Number(result.height),
    }
  } catch (err) {
    console.error('[CS2WindowTracker] Error in getClientBoundsOnScreen:', err)
    return null
  }
}

/**
 * Check if a window is minimized
 * @param hwnd Window handle
 * @returns true if minimized, false otherwise
 */
export function isMinimized(hwnd: bigint): boolean {
  if (!nativeAddon) {
    return false
  }
  try {
    return Boolean(nativeAddon.isMinimized(hwnd))
  } catch (err) {
    console.error('[CS2WindowTracker] Error in isMinimized:', err)
    return false
  }
}

/**
 * Get DPI scale for a window
 * @param hwnd Window handle
 * @returns DPI scale (e.g., 1.0 for 100%, 1.25 for 125%)
 */
export function getDpiScaleForHwnd(hwnd: bigint): number {
  if (!nativeAddon) {
    return 1.0 // Default to 100% scale
  }
  try {
    return Number(nativeAddon.getDpiScaleForHwnd(hwnd))
  } catch (err) {
    console.error('[CS2WindowTracker] Error in getDpiScaleForHwnd:', err)
    return 1.0
  }
}

/**
 * Start WinEvent hook for a process
 * @param targetPid Target process ID
 * @param callback Callback function for events
 */
export function startWinEventHook(targetPid: number, callback: (event: WinEvent) => void): void {
  if (!nativeAddon) {
    console.warn('[CS2WindowTracker] Native addon not loaded, cannot start WinEvent hook')
    return
  }
  try {
    nativeAddon.startWinEventHook(targetPid, (event: any) => {
      const winEvent: WinEvent = {
        type: event.type,
        hwnd: BigInt(event.hwnd),
      }
      // Add pid if present (for foreground events)
      if (event.pid !== undefined) {
        winEvent.pid = Number(event.pid)
      }
      callback(winEvent)
    })
  } catch (err) {
    console.error('[CS2WindowTracker] Error in startWinEventHook:', err)
  }
}

/**
 * Stop WinEvent hook
 */
export function stopWinEventHook(): void {
  if (!nativeAddon) {
    return
  }
  nativeAddon.stopWinEventHook()
}

/**
 * Get the process ID of the foreground window
 * @returns Process ID or null if failed
 */
export function getForegroundPid(): number | null {
  if (!nativeAddon) {
    console.warn('[CS2WindowTracker] Native addon not loaded, cannot get foreground PID')
    return null
  }
  try {
    const result = nativeAddon.getForegroundPid()
    return result === null ? null : Number(result)
  } catch (err) {
    console.error('[CS2WindowTracker] Error in getForegroundPid:', err)
    return null
  }
}

/**
 * Force activate a window (bring to foreground)
 * Uses AttachThreadInput to reliably bypass Windows foreground lock
 * @param hwnd Window handle
 * @returns true if successful, false otherwise
 */
export function forceActivateWindow(hwnd: bigint): boolean {
  if (!nativeAddon) {
    console.warn('[CS2WindowTracker] Native addon not loaded, cannot force activate window')
    return false
  }
  try {
    return Boolean(nativeAddon.forceActivateWindow(hwnd))
  } catch (err) {
    console.error('[CS2WindowTracker] Error in forceActivateWindow:', err)
    return false
  }
}