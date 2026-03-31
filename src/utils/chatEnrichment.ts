import { formatDisconnectReason } from './disconnectReason'

/** Builds a map of disconnect events keyed by `${actorSteamId}-${startTick}`. */
export function buildDisconnectEventMap(disconnectEvents: any[]): Map<string, any> {
  const map = new Map<string, any>()
  disconnectEvents.forEach((event) => {
    if (!event.actorSteamId) return
    if (event.meta && typeof event.meta === 'string') {
      try { event.meta = JSON.parse(event.meta) } catch (e) { console.warn('Failed to parse disconnect event meta:', e) }
    }
    map.set(`${event.actorSteamId}-${event.startTick}`, event)
  })
  return map
}

/** Enriches chat messages that are disconnect messages with the disconnect reason from the event map. */
export function enrichChatWithDisconnectReasons(messages: any[], disconnectEventMap: Map<string, any>): any[] {
  return messages.map((msg) => {
    const isDisconnectMessage = msg.message && (
      msg.message.toLowerCase().includes('left the game') ||
      msg.message.toLowerCase().includes('disconnected') ||
      msg.message.toLowerCase().includes('disconnect')
    )
    if (!isDisconnectMessage || !msg.steamid) return msg

    let matchingEvent: any = null
    let closestTickDiff = Infinity
    for (const [key, event] of disconnectEventMap.entries()) {
      if (!key.startsWith(`${msg.steamid}-`)) continue
      const tickDiff = Math.abs((event.startTick || 0) - (msg.tick || 0))
      if (tickDiff <= 500 && tickDiff < closestTickDiff) {
        matchingEvent = event
        closestTickDiff = tickDiff
      }
    }
    if (!matchingEvent) {
      console.log('No matching disconnect event found for message:', msg.message, 'steamid:', msg.steamid, 'tick:', msg.tick)
      return msg
    }

    let reason: any = null
    if (matchingEvent.meta) {
      if (typeof matchingEvent.meta === 'string') {
        try { reason = JSON.parse(matchingEvent.meta).reason } catch { reason = matchingEvent.meta.reason }
      } else {
        reason = matchingEvent.meta.reason
      }
    }
    if (!reason) {
      console.log('No reason found for disconnect event:', matchingEvent)
      return msg
    }
    console.log('Found disconnect reason for', msg.steamid, ':', reason)
    return { ...msg, message: `${msg.message} (${formatDisconnectReason(reason)})` }
  })
}
