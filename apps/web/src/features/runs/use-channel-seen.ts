import { useEffect, useSyncExternalStore } from "react"

/** One localStorage key, per-channel entries: channel key → the newest
 * channel activity (server-time ms) the human viewer has accounted for.
 * The server's per-agent read cursors are agent state, not UI state. */
const STORAGE_KEY = "aegisx:channel-seen"

/** Server-known activity for one channel — the ChannelPublic subset the
 * marker store compares against. */
type ChannelActivity = {
  key: string
  lastMessageAt: string | null
}

type SeenMarkers = Record<string, number>

function loadMarkers(): SeenMarkers {
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(STORAGE_KEY) ?? "{}"
    )
    if (typeof parsed !== "object" || parsed === null) return {}
    const markers: SeenMarkers = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "number") markers[key] = value
    }
    return markers
  } catch {
    // unreadable or corrupted storage: start from an empty marker set
    return {}
  }
}

let markers: SeenMarkers | null = null
const listeners = new Set<() => void>()

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getMarkers(): SeenMarkers {
  // Lazy first touch: the module stays importable where localStorage isn't
  // wired (tests, non-DOM) until a store read actually happens.
  return (markers ??= loadMarkers())
}

function write(next: SeenMarkers) {
  markers = next
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  for (const listener of listeners) listener()
}

function activityOf(channel: ChannelActivity): number {
  return channel.lastMessageAt === null ? 0 : Date.parse(channel.lastMessageAt)
}

/** Unread = the server's newest channel activity postdates the stored
 * marker. A channel without a marker is on first sighting — surfaces seed
 * its current activity as the baseline, so history never counts as unread. */
function isUnread(channel: ChannelActivity, map: SeenMarkers): boolean {
  const marker = map[channel.key]
  return marker !== undefined && activityOf(channel) > marker
}

/** Mark one channel seen (entering/viewing): the marker advances to the
 * channel's server-known activity. No-op while the marker already covers
 * it — surfaces re-mark on every poll, so writes stay at rest. */
function markSeen(channel: ChannelActivity) {
  const map = getMarkers()
  const at = activityOf(channel)
  if (map[channel.key] === at) return
  write({ ...map, [channel.key]: at })
}

/** First-sighting seed: channels without a marker get their current
 * activity as the baseline. Idempotent; never clears existing unreads. */
function seedSeen(channels: readonly ChannelActivity[]) {
  const map = getMarkers()
  let next: SeenMarkers | null = null
  for (const channel of channels) {
    if (channel.key in map) continue
    ;(next ??= { ...map })[channel.key] = activityOf(channel)
  }
  if (next !== null) write(next)
}

/** The single source of truth for channel "unread" across surfaces (task
 * tab badge + channel rail): a localStorage-persisted per-channel seen
 * marker compared against the server's `lastMessageAt`. Every surface asks
 * the same store, so badges cannot disagree — and no message bodies are
 * fetched for counting. Pass the channel list to seed first-sighting
 * baselines (backlog ≠ unread). */
export function useChannelSeen(channels?: readonly ChannelActivity[]) {
  useEffect(() => {
    if (channels !== undefined) seedSeen(channels)
  }, [channels])

  const map = useSyncExternalStore(subscribe, getMarkers, getMarkers)
  return {
    isUnread: (channel: ChannelActivity) => isUnread(channel, map),
    markSeen,
  }
}
