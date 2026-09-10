import type { LiveEvent } from "@/api"

import { parseLiveEvent } from "./parse-event"

type LiveListener = (event: LiveEvent) => void
/** A reconnect SUCCEEDED after the socket had been away: durable history may
 * have moved and ephemeral state is stale. */
type ReconnectListener = () => void
type StatusListener = (disconnected: boolean) => void

const DEFAULT_PATH = "/api/stream"

/**
 * The one process-level EventSource. `GET /api/stream` multiplexes every
 * agent's events plus every channel message, each frame keeping its own
 * identity (`agentId` / `message.channelKey`) — so the old "one stream per
 * agent, one agent at a time" constraint is gone; subscribers register once
 * and dispatch by that identity themselves.
 *
 * The connection opens lazily with the first subscriber and closes with the
 * last, so a tree with nothing live holds no socket. EventSource reconnects
 * natively; {@link LiveConnection.onReconnect} fires on a successful re-open
 * (after a drop) and {@link LiveConnection.onStatus} reports connect/drop for
 * "reconnecting…" affordances. `createSource` is the test seam.
 */
export function createLiveConnection(
  path: string = DEFAULT_PATH,
  createSource: (path: string) => EventSource = (url) => new EventSource(url)
) {
  const listeners = new Set<LiveListener>()
  const reconnectListeners = new Set<ReconnectListener>()
  const statusListeners = new Set<StatusListener>()
  let source: EventSource | null = null
  /** A connection has completed at least once on the current source. */
  let opened = false

  function open() {
    if (source) return
    const next = createSource(path)
    source = next
    opened = false
    next.addEventListener("open", () => {
      if (source !== next) return
      const reconnected = opened
      opened = true
      for (const listener of statusListeners) listener(false)
      if (reconnected) for (const listener of reconnectListeners) listener()
    })
    next.addEventListener("error", () => {
      if (source !== next) return
      for (const listener of statusListeners) listener(true)
    })
    next.addEventListener("message", (message) => {
      if (source !== next) return
      let payload: unknown
      try {
        payload = JSON.parse(message.data)
      } catch {
        return
      }
      const event = parseLiveEvent(payload)
      if (event) for (const listener of listeners) listener(event)
    })
  }

  function closeIfIdle() {
    if (listeners.size > 0 || !source) return
    source.close()
    source = null
    opened = false
  }

  return {
    /** Every parsed event, in arrival order. */
    subscribe(listener: LiveListener) {
      listeners.add(listener)
      open()
      return () => {
        listeners.delete(listener)
        closeIfIdle()
      }
    },
    onReconnect(listener: ReconnectListener) {
      reconnectListeners.add(listener)
      return () => {
        reconnectListeners.delete(listener)
      }
    },
    onStatus(listener: StatusListener) {
      statusListeners.add(listener)
      return () => {
        statusListeners.delete(listener)
      }
    },
  }
}

export const liveConnection = createLiveConnection()
