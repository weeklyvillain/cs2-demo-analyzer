/** Converts a duration in seconds to a human-readable string e.g. "2m 5s" */
export function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${Math.round(seconds)}s`
  }
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = Math.round(seconds % 60)
  if (minutes < 60) {
    return `${minutes}m ${remainingSeconds}s`
  }
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return `${hours}h ${remainingMinutes}m`
}

/** Converts a demo tick to a MM:SS string */
export function formatTime(tick: number, tickRate = 64): string {
  const seconds = tick / tickRate
  const minutes = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${minutes}:${secs.toString().padStart(2, '0')}`
}

/**
 * Converts a value already expressed in seconds (as pre-converted by the Go parser)
 * to a MM:SS string. Use this — NOT formatTime — when the Go parser has already
 * divided by tickRate (e.g. disconnect_time, reconnect_time in event meta).
 */
export function formatSeconds(seconds: number): string {
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

/** Returns the duration between two ticks as e.g. "3.2s", or "N/A" if endTick is null */
export function formatEventDuration(startTick: number, endTick: number | null, tickRate = 64): string {
  if (!endTick) return 'N/A'
  const duration = (endTick - startTick) / tickRate
  return `${duration.toFixed(1)}s`
}
