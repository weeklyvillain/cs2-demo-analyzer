/**
 * Overlay Synchronization Module
 * Syncs overlay window bounds with CS2 window bounds
 */

import { BrowserWindow } from 'electron'
import { CS2WindowTracker, CS2WindowInfo } from './cs2WindowEvents'

export class OverlaySync {
  private tracker: CS2WindowTracker
  private overlayWindow: BrowserWindow | null = null
  private isActive: boolean = false
  private pendingUpdate: NodeJS.Timeout | null = null
  private lastUpdateTime: number = 0
  private readonly UPDATE_THROTTLE_MS = 16 // ~60fps max update rate

  constructor(overlayWindow: BrowserWindow) {
    this.overlayWindow = overlayWindow
    this.tracker = new CS2WindowTracker()
    this.setupEventHandlers()
  }

  private setupEventHandlers(): void {
    // Handle window found
    this.tracker.on('windowFound', (info: CS2WindowInfo) => {
      console.log('[OverlaySync] CS2 window found:', info)
      this.syncBounds(info)
    })

    // Handle bounds changed
    this.tracker.on('boundsChanged', (info: CS2WindowInfo) => {
      this.syncBounds(info)
    })

    // Handle state changed
    this.tracker.on('stateChanged', (info: CS2WindowInfo) => {
      if (info.isMinimized || !info.isVisible) {
        this.hideOverlay()
      } else {
        this.showOverlay()
        this.syncBounds(info)
      }
    })

    // Handle window lost
    this.tracker.on('windowLost', () => {
      console.log('[OverlaySync] CS2 window lost')
      this.hideOverlay()
    })
  }

  private syncBounds(info: CS2WindowInfo): void {
    if (!this.overlayWindow || this.overlayWindow.isDestroyed()) {
      return
    }

    // Throttle updates to avoid excessive setBounds calls
    const now = Date.now()
    const timeSinceLastUpdate = now - this.lastUpdateTime

    if (this.pendingUpdate) {
      clearTimeout(this.pendingUpdate)
    }

    const doUpdate = () => {
      if (!this.overlayWindow || this.overlayWindow.isDestroyed()) {
        return
      }

      try {
        // Use requestAnimationFrame-like scheduling for smooth updates
        // Electron's setBounds is synchronous, so we throttle manually
        this.overlayWindow.setBounds({
          x: info.bounds.x,
          y: info.bounds.y,
          width: info.bounds.width,
          height: info.bounds.height,
        }, false) // false = don't animate

        this.lastUpdateTime = Date.now()
        this.pendingUpdate = null
      } catch (err) {
        console.error('[OverlaySync] Error syncing bounds:', err)
      }
    }

    if (timeSinceLastUpdate >= this.UPDATE_THROTTLE_MS) {
      // Update immediately if enough time has passed
      doUpdate()
    } else {
      // Schedule update after throttle period
      this.pendingUpdate = setTimeout(doUpdate, this.UPDATE_THROTTLE_MS - timeSinceLastUpdate)
    }
  }

  private hideOverlay(): void {
    if (!this.overlayWindow || this.overlayWindow.isDestroyed()) {
      return
    }

    if (this.overlayWindow.isVisible()) {
      this.overlayWindow.hide()
      console.log('[OverlaySync] Overlay hidden (CS2 minimized/not visible)')
    }
  }

  private showOverlay(): void {
    if (!this.overlayWindow || this.overlayWindow.isDestroyed()) {
      return
    }

    if (!this.overlayWindow.isVisible()) {
      this.overlayWindow.show()
      console.log('[OverlaySync] Overlay shown (CS2 restored/visible)')
    }
  }

  public start(): void {
    if (this.isActive) {
      return
    }

    this.isActive = true
    console.log('[OverlaySync] Starting overlay synchronization...')
    this.tracker.start()
  }

  public stop(): void {
    if (!this.isActive) {
      return
    }

    this.isActive = false
    console.log('[OverlaySync] Stopping overlay synchronization...')

    if (this.pendingUpdate) {
      clearTimeout(this.pendingUpdate)
      this.pendingUpdate = null
    }

    this.tracker.stop()
  }

  public updateOverlayWindow(overlayWindow: BrowserWindow): void {
    this.overlayWindow = overlayWindow
  }

  public getCS2WindowInfo(): CS2WindowInfo | null {
    return this.tracker.getCurrentWindow()
  }
}
