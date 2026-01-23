/**
 * CS2 Overlay Tracker
 * Manages overlay window synchronization with CS2 game window
 * Only tracks when demo playback is active
 */

import { BrowserWindow, app } from 'electron'
import {
  findWindowByPid,
  findProcessIdByName,
  getClientBoundsOnScreen,
  isMinimized,
  getDpiScaleForHwnd,
  getForegroundPid,
  forceActivateWindow,
  startWinEventHook,
  stopWinEventHook,
  WindowBounds,
  WinEvent,
} from './native-addon'

export interface TrackingOptions {
  /** Process ID if we already know it (from launching CS2) */
  pid?: number
  /** Process name to find (default: "cs2.exe") */
  processName?: string
  /** Timeout in ms to wait for window (default: 15000) */
  windowTimeout?: number
  /** Retry interval in ms (default: 200) */
  retryInterval?: number
}

interface TrackingState {
  pid: number | null
  hwnd: bigint | null
  dpiScale: number
  isTracking: boolean
  pendingBoundsUpdate: NodeJS.Timeout | null
  lastBounds: WindowBounds | null
  lastUpdateTime: number
  healthCheckInterval: NodeJS.Timeout | null
  isMoving: boolean
  isCs2Foreground: boolean // Track if CS2 is the foreground window
  cs2Minimized: boolean // Track if CS2 is minimized
  isInteractive: boolean // Track if overlay is interactive (not click-through)
  overlayPid: number | null // Track Electron process PID (for checking if overlay is foreground)
  handoffUntil: number | null // Timestamp until which overlay should stay visible during handoff (ms)
}

const UPDATE_THROTTLE_MS = 8 // ~120fps max update rate for smoother tracking
const HEALTH_CHECK_INTERVAL_MS = 1000 // Check every second if CS2 window still exists

class CS2OverlayTracker {
  private state: TrackingState = {
    pid: null,
    hwnd: null,
    dpiScale: 1.0,
    isTracking: false,
    pendingBoundsUpdate: null,
    lastBounds: null,
    lastUpdateTime: 0,
    healthCheckInterval: null,
    isMoving: false,
    isCs2Foreground: false, // Will be set when tracking starts
    cs2Minimized: false,
    isInteractive: false, // Track overlay interactive state
    overlayPid: null, // Electron process PID
    handoffUntil: null, // Grace period for overlay-to-CS2 handoff
  }

  private overlayWindow: BrowserWindow | null = null

  /**
   * Set overlay interactive state
   * When turning interactive OFF (closing), force activate CS2 and set grace period
   * This should ONLY be called when closing interactive mode, not when opening it
   */
  setOverlayInteractive(isInteractive: boolean): void {
    const wasInteractive = this.state.isInteractive
    
    // Only perform handoff when CLOSING interactive mode (was ON, now OFF)
    // Do NOT perform handoff when OPENING interactive mode (was OFF, now ON)
    if (wasInteractive && !isInteractive) {
      console.log('[CS2OverlayTracker] Closing interactive mode - performing handoff to CS2')
      
      // Start handoff grace period (500ms)
      this.state.handoffUntil = Date.now() + 500
      console.log('[CS2OverlayTracker] Starting handoff grace period (500ms)')
      
      // Force activate CS2 if we have its window handle
      if (this.state.hwnd && this.state.pid) {
        console.log('[CS2OverlayTracker] Force activating CS2 window')
        const success = forceActivateWindow(this.state.hwnd)
        if (success) {
          console.log('[CS2OverlayTracker] CS2 window force activated successfully')
          // Update foreground state after activation
          setTimeout(() => {
            const fgPid = getForegroundPid()
            this.state.isCs2Foreground = fgPid === this.state.pid
            if (this.state.hwnd) {
              this.state.cs2Minimized = isMinimized(this.state.hwnd)
            }
            console.log(`[CS2OverlayTracker] Post-activation state - foreground: ${this.state.isCs2Foreground}, minimized: ${this.state.cs2Minimized}`)
          }, 50)
        } else {
          console.warn('[CS2OverlayTracker] Failed to force activate CS2 window')
        }
      } else {
        console.warn('[CS2OverlayTracker] Cannot force activate CS2 - window handle or PID not available')
      }
    } else if (!wasInteractive && isInteractive) {
      // Opening interactive mode - no handoff needed
      console.log('[CS2OverlayTracker] Opening interactive mode - no handoff needed')
    }
    
    // Update state after handoff logic
    this.state.isInteractive = isInteractive
    
    // When overlay becomes interactive, ensure it's visible if CS2 is foreground and not minimized
    if (isInteractive && this.overlayWindow && !this.overlayWindow.isDestroyed()) {
      if (this.state.isCs2Foreground && !this.state.cs2Minimized && !this.state.isMoving) {
        // Sync bounds first to ensure correct position
        this.syncBounds()
        // Then show if not already visible
        if (!this.overlayWindow.isVisible()) {
          this.overlayWindow.showInactive()
          console.log('[CS2OverlayTracker] Overlay shown (became interactive)')
        }
      }
    }
  }

  /**
   * Start tracking CS2 window for overlay synchronization
   */
  async startTrackingCs2ForDemo(
    overlayWin: BrowserWindow,
    options: TrackingOptions = {}
  ): Promise<void> {
    if (this.state.isTracking) {
      console.log('[CS2OverlayTracker] Already tracking, stopping first')
      this.stopTrackingCs2(overlayWin)
    }

    this.overlayWindow = overlayWin
    this.state.isTracking = true

    const processName = options.processName || 'cs2.exe'
    const windowTimeout = options.windowTimeout || 15000
    const retryInterval = options.retryInterval || 200

    try {
      // Resolve PID
      let pid: number | null = null

      if (options.pid) {
        pid = options.pid
        console.log(`[CS2OverlayTracker] Using provided PID: ${pid}`)
      } else {
        console.log(`[CS2OverlayTracker] Finding process: ${processName}`)
        pid = findProcessIdByName(processName)
        if (!pid) {
          throw new Error(`Process ${processName} not found`)
        }
        console.log(`[CS2OverlayTracker] Found PID: ${pid}`)
      }

      this.state.pid = pid

      // Wait for window to appear
      const startTime = Date.now()
      let hwnd: bigint | null = null

      while (Date.now() - startTime < windowTimeout) {
        hwnd = findWindowByPid(pid)
        if (hwnd) {
          console.log(`[CS2OverlayTracker] Found window: ${hwnd.toString(16)}`)
          break
        }
        await new Promise(resolve => setTimeout(resolve, retryInterval))
      }

      if (!hwnd) {
        throw new Error(`Window for PID ${pid} not found within ${windowTimeout}ms`)
      }

      this.state.hwnd = hwnd
      this.state.dpiScale = getDpiScaleForHwnd(hwnd)
      this.state.overlayPid = process.pid // Store Electron process PID
      console.log(`[CS2OverlayTracker] DPI scale: ${this.state.dpiScale}, Overlay PID: ${this.state.overlayPid}`)

      // Check initial foreground state
      const fgPid = getForegroundPid()
      this.state.isCs2Foreground = fgPid === pid
      this.state.cs2Minimized = isMinimized(hwnd)
      console.log(`[CS2OverlayTracker] Initial state - foreground PID: ${fgPid}, CS2 PID: ${pid}, isCs2Foreground: ${this.state.isCs2Foreground}, minimized: ${this.state.cs2Minimized}`)

      // Start WinEvent hook
      startWinEventHook(pid, (event: WinEvent) => {
        this.handleWinEvent(event)
      })

      // Re-check foreground state after a short delay (in case it changed during hook setup)
      // Also ensures we have the latest state before showing overlay
      setTimeout(() => {
        const currentFgPid = getForegroundPid()
        const wasForeground = this.state.isCs2Foreground
        this.state.isCs2Foreground = currentFgPid === pid
        this.state.cs2Minimized = isMinimized(hwnd)
        console.log(`[CS2OverlayTracker] Post-hook state - foreground PID: ${currentFgPid}, isCs2Foreground: ${this.state.isCs2Foreground}, minimized: ${this.state.cs2Minimized}`)
        
        // If foreground state changed or we need to update visibility, sync bounds
        if (wasForeground !== this.state.isCs2Foreground || this.state.isCs2Foreground) {
          this.syncBounds()
        }
      }, 100)

      // Initial bounds sync (will handle visibility based on foreground/minimized state)
      this.syncBounds()

      // Start health check to verify window/process still exists
      this.startHealthCheck()

      console.log('[CS2OverlayTracker] Tracking started successfully')
    } catch (err) {
      console.error('[CS2OverlayTracker] Failed to start tracking:', err)
      this.stopTrackingCs2(overlayWin)
      throw err
    }
  }

  /**
   * Stop tracking CS2 window
   */
  stopTrackingCs2(overlayWin: BrowserWindow): void {
    console.log('[CS2OverlayTracker] Stopping tracking')

    this.state.isTracking = false

    // Stop WinEvent hook
    stopWinEventHook()

    // Stop health check
    this.stopHealthCheck()

    // Clear pending updates
    if (this.state.pendingBoundsUpdate) {
      clearTimeout(this.state.pendingBoundsUpdate)
      this.state.pendingBoundsUpdate = null
    }

    // Hide overlay
    if (overlayWin && !overlayWin.isDestroyed()) {
      overlayWin.hide()
    }

      // Clear state
    this.state.pid = null
    this.state.hwnd = null
    this.state.lastBounds = null
    this.state.isMoving = false
    this.state.isCs2Foreground = false
    this.state.cs2Minimized = false
    this.state.handoffUntil = null
    this.overlayWindow = null

    console.log('[CS2OverlayTracker] Tracking stopped')
  }

  /**
   * Handle WinEvent callback
   */
  private handleWinEvent(event: WinEvent): void {
    if (!this.state.isTracking) {
      return
    }

    // For foreground events, check PID instead of hwnd
    if (event.type === 'foreground') {
      // Check if the foreground window is CS2 or the overlay itself (if interactive)
      const fgPid = event.pid !== undefined ? event.pid : null
      const isCs2Foreground = fgPid === this.state.pid
      const isOverlayForeground = this.state.isInteractive && fgPid === this.state.overlayPid
      const wasForeground = this.state.isCs2Foreground
      this.state.isCs2Foreground = isCs2Foreground
      
      console.log(`[CS2OverlayTracker] Foreground event - PID: ${fgPid}, CS2 PID: ${this.state.pid}, Overlay PID: ${this.state.overlayPid}, isCs2Foreground: ${isCs2Foreground}, isOverlayForeground: ${isOverlayForeground}, isInteractive: ${this.state.isInteractive}`)
      
      if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
        if (isCs2Foreground) {
          // CS2 became foreground - show overlay if not minimized and not moving
          // Update minimized state first
          if (this.state.hwnd) {
            this.state.cs2Minimized = isMinimized(this.state.hwnd)
          }
          if (!this.state.cs2Minimized && !this.state.isMoving) {
            this.syncBounds()
            console.log('[CS2OverlayTracker] Overlay shown (CS2 became foreground)')
          } else {
            console.log(`[CS2OverlayTracker] Overlay not shown (minimized: ${this.state.cs2Minimized}, moving: ${this.state.isMoving})`)
          }
        } else if (isOverlayForeground) {
          // Overlay itself became foreground (user clicked on it) - keep it visible if interactive
          console.log('[CS2OverlayTracker] Overlay kept visible (overlay is foreground, interactive mode)')
          // Don't hide, but also don't update bounds (CS2 is not foreground)
        } else {
          // Another window became foreground - hide overlay if not interactive
          if (!this.state.isInteractive && this.overlayWindow.isVisible()) {
            this.overlayWindow.hide()
            console.log('[CS2OverlayTracker] Overlay hidden (another window became foreground, click-through mode)')
          } else if (this.state.isInteractive) {
            console.log('[CS2OverlayTracker] Overlay kept visible (interactive mode, user might be using it)')
          }
        }
      }
      return
    }

    // For other events, verify hwnd matches (except destroy which might have different hwnd)
    if (event.type !== 'destroy') {
      if (!this.state.hwnd || event.hwnd !== this.state.hwnd) {
        return
      }
    }

    switch (event.type) {
      case 'locationchange':
        // Regular location change (not during move/resize)
        // Only update bounds if overlay should be visible (foreground & not minimized)
        if (!this.state.isMoving && this.state.isCs2Foreground && !this.state.cs2Minimized) {
          this.scheduleBoundsUpdate()
        }
        break

      case 'movestart':
        // Hide overlay when movement starts (like Discord)
        this.state.isMoving = true
        if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
          this.overlayWindow.hide()
          console.log('[CS2OverlayTracker] Overlay hidden (window movement started)')
        }
        break

      case 'moveend':
        // Show overlay and sync bounds when movement ends (if CS2 is foreground)
        this.state.isMoving = false
        if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
          if (this.state.isCs2Foreground && !this.state.cs2Minimized) {
            this.syncBounds()
            console.log('[CS2OverlayTracker] Overlay shown (window movement ended)')
          }
        }
        break

      case 'minimizestart':
        this.state.cs2Minimized = true
        if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
          this.overlayWindow.hide()
          console.log('[CS2OverlayTracker] Overlay hidden (CS2 minimized)')
        }
        break

      case 'minimizeend':
        this.state.cs2Minimized = false
        if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
          // Only show if CS2 is foreground
          if (this.state.isCs2Foreground && !this.state.isMoving) {
            this.syncBounds()
            console.log('[CS2OverlayTracker] Overlay shown (CS2 restored)')
          }
        }
        break

      case 'destroy':
        console.log('[CS2OverlayTracker] CS2 window destroyed')
        if (this.overlayWindow) {
          this.stopTrackingCs2(this.overlayWindow)
        }
        break
    }
  }

  /**
   * Schedule a bounds update (with coalescing)
   */
  private scheduleBoundsUpdate(): void {
    if (this.state.isMoving) {
      // During movement, update more frequently
      this.syncBounds()
      return
    }

    if (this.state.pendingBoundsUpdate) {
      return // Already scheduled
    }

    const now = Date.now()
    const timeSinceLastUpdate = now - this.state.lastUpdateTime

    const doUpdate = () => {
      this.state.pendingBoundsUpdate = null
      this.syncBounds()
    }

    if (timeSinceLastUpdate >= UPDATE_THROTTLE_MS) {
      // Update immediately
      doUpdate()
    } else {
      // Schedule update
      this.state.pendingBoundsUpdate = setTimeout(
        doUpdate,
        UPDATE_THROTTLE_MS - timeSinceLastUpdate
      )
    }
  }

  /**
   * Start periodic health check to verify CS2 window/process still exists
   */
  private startHealthCheck(): void {
    this.stopHealthCheck() // Clear any existing interval

    this.state.healthCheckInterval = setInterval(() => {
      if (!this.state.isTracking || !this.state.hwnd || !this.state.pid) {
        return
      }

      try {
        // Check if window still exists
        const currentHwnd = findWindowByPid(this.state.pid)
        if (!currentHwnd || currentHwnd !== this.state.hwnd) {
          console.log('[CS2OverlayTracker] CS2 window lost (health check)')
          if (this.overlayWindow) {
            this.stopTrackingCs2(this.overlayWindow)
          }
          return
        }

        // Verify window is still valid by checking if it's minimized (this also validates the handle)
        // If the window is destroyed, isMinimized will fail or return unexpected results
        try {
          isMinimized(this.state.hwnd)
        } catch (err) {
          console.log('[CS2OverlayTracker] CS2 window handle invalid (health check)')
          if (this.overlayWindow) {
            this.stopTrackingCs2(this.overlayWindow)
          }
        }
      } catch (err) {
        console.error('[CS2OverlayTracker] Health check error:', err)
        // If health check fails, assume window is gone
        if (this.overlayWindow) {
          this.stopTrackingCs2(this.overlayWindow)
        }
      }
    }, HEALTH_CHECK_INTERVAL_MS)
  }

  /**
   * Stop health check interval
   */
  private stopHealthCheck(): void {
    if (this.state.healthCheckInterval) {
      clearInterval(this.state.healthCheckInterval)
      this.state.healthCheckInterval = null
    }
  }

  /**
   * Sync overlay bounds with CS2 window bounds
   */
  private syncBounds(): void {
    if (!this.state.hwnd || !this.overlayWindow || this.overlayWindow.isDestroyed()) {
      return
    }

    try {
      // Update minimized state
      this.state.cs2Minimized = isMinimized(this.state.hwnd)
      
      // Re-check foreground state to ensure we have the latest
      const fgPid = getForegroundPid()
      this.state.isCs2Foreground = fgPid === this.state.pid
      const isOverlayForeground = this.state.isInteractive && fgPid === this.state.overlayPid
      
      // Check if we're in handoff grace period
      const now = Date.now()
      const inHandoffPeriod = this.state.handoffUntil !== null && now < this.state.handoffUntil
      if (this.state.handoffUntil !== null && now >= this.state.handoffUntil) {
        // Grace period expired, clear it
        this.state.handoffUntil = null
      }

      // Check if overlay should be visible
      // Overlay should be shown when:
      // 1. CS2 is foreground (isCs2Foreground) AND CS2 is not minimized AND not moving
      // OR
      // 2. Overlay is interactive AND overlay itself is foreground (user clicked on it)
      // OR
      // 3. During handoff grace period AND CS2 exists and is not minimized (don't require foreground during grace period)
      const shouldShow = (
        (this.state.isCs2Foreground && !this.state.cs2Minimized && !this.state.isMoving) ||
        (this.state.isInteractive && isOverlayForeground) ||
        (inHandoffPeriod && !this.state.cs2Minimized && this.state.hwnd !== null)
      )

      console.log(`[CS2OverlayTracker] syncBounds - shouldShow: ${shouldShow}, foreground: ${this.state.isCs2Foreground} (fgPid: ${fgPid}, cs2Pid: ${this.state.pid}), overlayForeground: ${isOverlayForeground}, minimized: ${this.state.cs2Minimized}, moving: ${this.state.isMoving}, interactive: ${this.state.isInteractive}, handoffPeriod: ${inHandoffPeriod}`)

      if (!shouldShow) {
        // Hide overlay if it shouldn't be visible
        if (this.overlayWindow.isVisible()) {
          this.overlayWindow.hide()
          console.log(`[CS2OverlayTracker] Overlay hidden (foreground: ${this.state.isCs2Foreground}, minimized: ${this.state.cs2Minimized}, moving: ${this.state.isMoving})`)
        }
        return // Don't update bounds if overlay is hidden
      }

      // Overlay should be visible - show it if not already visible
      if (!this.overlayWindow.isVisible()) {
        this.overlayWindow.showInactive()
        console.log('[CS2OverlayTracker] Overlay shown (CS2 is foreground and not minimized)')
      }

      // Get and update bounds
      const bounds = getClientBoundsOnScreen(this.state.hwnd)
      if (!bounds) {
        return
      }

      // Check if bounds actually changed
      if (
        this.state.lastBounds &&
        this.state.lastBounds.x === bounds.x &&
        this.state.lastBounds.y === bounds.y &&
        this.state.lastBounds.width === bounds.width &&
        this.state.lastBounds.height === bounds.height
      ) {
        return // No change
      }

      // Convert to DIP (Electron uses DIP internally)
      const dipBounds = {
        x: bounds.x / this.state.dpiScale,
        y: bounds.y / this.state.dpiScale,
        width: bounds.width / this.state.dpiScale,
        height: bounds.height / this.state.dpiScale,
      }

      this.overlayWindow.setBounds(dipBounds, false)
      this.state.lastBounds = bounds
      this.state.lastUpdateTime = Date.now()

      console.log(`[CS2OverlayTracker] Bounds synced: ${dipBounds.x},${dipBounds.y} ${dipBounds.width}x${dipBounds.height}`)
    } catch (err) {
      console.error('[CS2OverlayTracker] Error syncing bounds:', err)
    }
  }
}

// Export singleton instance
export const cs2OverlayTracker = new CS2OverlayTracker()
