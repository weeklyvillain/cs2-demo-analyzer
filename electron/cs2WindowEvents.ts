/**
 * CS2 Window Event Tracker
 * Uses node-window-manager to detect CS2 window position/size changes
 */

import { EventEmitter } from 'events'
import { windowManager, Window } from 'node-window-manager'

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface CS2WindowInfo {
  hwnd: number
  pid: number
  bounds: WindowBounds
  isMinimized: boolean
  isVisible: boolean
}

export class CS2WindowTracker extends EventEmitter {
  private cs2Window: Window | null = null
  private isRunning: boolean = false
  private pollInterval: NodeJS.Timeout | null = null
  private lastBounds: WindowBounds | null = null
  private lastIsMinimized: boolean = false
  private lastIsVisible: boolean = false
  private readonly POLL_INTERVAL_MS = 100 // Poll every 100ms for smooth updates

  constructor() {
    super()
  }

  private findCS2Window(): Window | null {
    try {
      const windows = windowManager.getWindows()
      
      // Find CS2 window by process path (most reliable)
      // CS2 executable is typically: ...\steamapps\common\Counter-Strike Global Offensive\game\bin\win64\cs2.exe
      let cs2Window = windows.find((win: Window) => {
        try {
          const path = win.path || ''
          const pathLower = path.toLowerCase()
          // Check for exact cs2.exe in the path
          return pathLower.includes('cs2.exe') && 
                 (pathLower.includes('counter-strike') || pathLower.includes('steamapps'))
        } catch (err) {
          return false
        }
      })

      // If not found by path, try by title (but be more specific)
      if (!cs2Window) {
        cs2Window = windows.find((win: Window) => {
          try {
            const title = win.getTitle().toLowerCase()
            // More specific title check - should be exactly "Counter-Strike 2" or contain it
            return title === 'counter-strike 2' || 
                   (title.includes('counter-strike 2') && !title.includes('demo'))
          } catch (err) {
            return false
          }
        })
      }

      return cs2Window || null
    } catch (err) {
      console.error('[CS2WindowTracker] Error finding CS2 window:', err)
      return null
    }
  }

  private getWindowInfo(window: Window): CS2WindowInfo | null {
    try {
      const bounds = window.getBounds()
      const isVisible = window.isVisible()
      const pid = window.processId
      const hwnd = window.id

      if (bounds.x === undefined || bounds.y === undefined || bounds.width === undefined || bounds.height === undefined) {
        return null
      }

      // Check if window is minimized by checking if it's visible and has valid bounds
      // On Windows, minimized windows often have bounds off-screen or very small
      const isMinimized = !isVisible || bounds.width <= 0 || bounds.height <= 0

      return {
        hwnd: hwnd || 0,
        pid: pid || 0,
        bounds: {
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
        },
        isMinimized,
        isVisible,
      }
    } catch (err) {
      console.error('[CS2WindowTracker] Error getting window info:', err)
      return null
    }
  }

  private poll(): void {
    if (!this.isRunning) return

    try {
      const window = this.findCS2Window()

      if (!window) {
        // CS2 not running
        if (this.cs2Window) {
          this.cs2Window = null
          this.lastBounds = null
          this.lastIsMinimized = false
          this.lastIsVisible = false
          this.emit('windowLost')
        }
        return
      }

      // Check if this is a new window or the same one
      const isNewWindow = !this.cs2Window || this.cs2Window.id !== window.id

      if (isNewWindow) {
        // New window found
        this.cs2Window = window
        const info = this.getWindowInfo(window)
        if (info) {
          this.lastBounds = info.bounds
          this.lastIsMinimized = info.isMinimized
          this.lastIsVisible = info.isVisible
          this.emit('windowFound', info)
        }
        return
      }

      // Update existing window
      const info = this.getWindowInfo(window)
      if (!info) return

      const boundsChanged = !this.lastBounds ||
        this.lastBounds.x !== info.bounds.x ||
        this.lastBounds.y !== info.bounds.y ||
        this.lastBounds.width !== info.bounds.width ||
        this.lastBounds.height !== info.bounds.height

      const stateChanged = this.lastIsMinimized !== info.isMinimized ||
        this.lastIsVisible !== info.isVisible

      if (boundsChanged) {
        this.lastBounds = info.bounds
        this.emit('boundsChanged', info)
      }

      if (stateChanged) {
        this.lastIsMinimized = info.isMinimized
        this.lastIsVisible = info.isVisible
        this.emit('stateChanged', info)
      }
    } catch (err) {
      console.error('[CS2WindowTracker] Poll error:', err)
    }
  }

  public start(): void {
    if (this.isRunning) {
      return
    }

    this.isRunning = true
    console.log('[CS2WindowTracker] Starting CS2 window tracker (using node-window-manager)...')

    // Start polling
    this.pollInterval = setInterval(() => {
      this.poll()
    }, this.POLL_INTERVAL_MS)

    // Initial poll
    this.poll()
  }

  public stop(): void {
    if (!this.isRunning) {
      return
    }

    this.isRunning = false
    console.log('[CS2WindowTracker] Stopping CS2 window tracker...')

    if (this.pollInterval) {
      clearInterval(this.pollInterval)
      this.pollInterval = null
    }

    this.cs2Window = null
    this.lastBounds = null
    this.lastIsMinimized = false
    this.lastIsVisible = false
  }

  public getCurrentWindow(): CS2WindowInfo | null {
    if (!this.cs2Window) {
      return null
    }

    return this.getWindowInfo(this.cs2Window)
  }
}
