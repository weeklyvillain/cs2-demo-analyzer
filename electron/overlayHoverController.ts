/**
 * Overlay Hover Controller
 * Manages hover-to-interact functionality for the transparent Electron overlay
 * - Overlay is click-through by default
 * - Becomes interactive when cursor hovers over interactive UI regions
 * - Returns to click-through when cursor leaves
 * - Prevents overlay from disappearing during hover transitions
 */

import { BrowserWindow } from 'electron'

interface HoverState {
  isHovered: boolean
  hoverGraceUntil: number | null // Timestamp until which hover grace period is active (ms)
  clickThroughSafetyTimer: NodeJS.Timeout | null // Timer to delay re-enabling click-through
  needsFocusable: boolean // Whether we need focusable=true for clicks to work
}

const HOVER_GRACE_PERIOD_MS = 300 // Grace period when hover becomes true
const CLICK_THROUGH_SAFETY_DELAY_MS = 80 // Delay before re-enabling click-through after hover ends

class OverlayHoverController {
  private state: HoverState = {
    isHovered: false,
    hoverGraceUntil: null,
    clickThroughSafetyTimer: null,
    needsFocusable: false, // Start with focusable=false, enable if clicks don't work
  }

  private overlayWindow: BrowserWindow | null = null

  /**
   * Set the overlay window to control
   */
  setOverlayWindow(window: BrowserWindow | null): void {
    this.overlayWindow = window
  }

  /**
   * Handle hover state change from renderer
   */
  async setHovered(hovered: boolean): Promise<void> {
    const wasHovered = this.state.isHovered
    
    // Only process if state actually changed
    if (wasHovered === hovered) {
      return
    }

    this.state.isHovered = hovered

    if (!this.overlayWindow || this.overlayWindow.isDestroyed()) {
      return
    }

    if (hovered) {
      // Cursor entered interactive region
      console.log('[OverlayHoverController] Hover started - making overlay interactive')
      
      // Set grace period
      this.state.hoverGraceUntil = Date.now() + HOVER_GRACE_PERIOD_MS
      
      // Clear any pending click-through safety timer
      if (this.state.clickThroughSafetyTimer) {
        clearTimeout(this.state.clickThroughSafetyTimer)
        this.state.clickThroughSafetyTimer = null
      }

      // Make overlay interactive
      // First try with focusable=false (some Electron builds allow clicks without focus)
      this.overlayWindow.setIgnoreMouseEvents(false, { forward: true })
      this.overlayWindow.setFocusable(false)
      
      // Ensure overlay is visible (use showInactive to avoid stealing focus)
      if (!this.overlayWindow.isVisible()) {
        this.overlayWindow.showInactive()
      }
      
      // Note: We don't call focus() - this prevents stealing focus from CS2
      // If clicks don't work in testing, we'll need to enable focusable=true as fallback
      
    } else {
      // Cursor left interactive region
      console.log('[OverlayHoverController] Hover ended - scheduling click-through re-enable')
      
      // Clear grace period
      this.state.hoverGraceUntil = null
      
      // Clear any existing timer
      if (this.state.clickThroughSafetyTimer) {
        clearTimeout(this.state.clickThroughSafetyTimer)
      }
      
      // Schedule click-through re-enable with safety delay
      this.state.clickThroughSafetyTimer = setTimeout(() => {
        if (!this.overlayWindow || this.overlayWindow.isDestroyed()) {
          return
        }
        
        // Only re-enable click-through if we're still not hovered
        if (!this.state.isHovered) {
          console.log('[OverlayHoverController] Re-enabling click-through after safety delay')
          this.overlayWindow.setIgnoreMouseEvents(true, { forward: true })
          this.overlayWindow.setFocusable(false)
          this.state.clickThroughSafetyTimer = null
        }
      }, CLICK_THROUGH_SAFETY_DELAY_MS)
    }
  }

  /**
   * Get current hover state
   */
  getHovered(): boolean {
    return this.state.isHovered
  }

  /**
   * Check if we're in hover grace period
   */
  isInHoverGracePeriod(): boolean {
    if (this.state.hoverGraceUntil === null) {
      return false
    }
    
    const now = Date.now()
    const inGrace = now < this.state.hoverGraceUntil
    
    // Clean up expired grace period
    if (!inGrace && this.state.hoverGraceUntil !== null) {
      this.state.hoverGraceUntil = null
    }
    
    return inGrace
  }

  /**
   * Enable focusable mode (fallback if clicks don't work with focusable=false)
   * This should be called if testing shows clicks don't register
   */
  enableFocusableMode(): void {
    if (this.state.needsFocusable) {
      return // Already enabled
    }
    
    console.log('[OverlayHoverController] Enabling focusable mode (clicks require focus)')
    this.state.needsFocusable = true
    
    // If currently hovered, update window state
    if (this.state.isHovered && this.overlayWindow && !this.overlayWindow.isDestroyed()) {
      this.overlayWindow.setFocusable(true)
      // Still use showInactive() instead of focus() to minimize focus stealing
      if (!this.overlayWindow.isVisible()) {
        this.overlayWindow.showInactive()
      }
    }
  }

  /**
   * Cleanup on shutdown
   */
  cleanup(): void {
    if (this.state.clickThroughSafetyTimer) {
      clearTimeout(this.state.clickThroughSafetyTimer)
      this.state.clickThroughSafetyTimer = null
    }
    this.state.hoverGraceUntil = null
    this.overlayWindow = null
  }
}

// Export singleton instance
export const overlayHoverController = new OverlayHoverController()
