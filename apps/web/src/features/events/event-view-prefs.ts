import { useEffect, useState } from "react"

import type {
  LocalChallengeStatus,
  RemoteChallengeStatus,
} from "./event-shared"

export type ChallengeSort = "event" | "name" | "points"
export type ChallengeGroup = "category" | "status" | "none"

export type EventViewPrefs = {
  sort: ChallengeSort
  group: ChallengeGroup
  categoryFilter: string[]
  localFilter: LocalChallengeStatus[]
  remoteFilter: RemoteChallengeStatus[]
}

export const DEFAULT_EVENT_VIEW_PREFS: EventViewPrefs = {
  sort: "event",
  group: "category",
  categoryFilter: [],
  localFilter: [],
  remoteFilter: [],
}

const STORAGE_PREFIX = "aegisx:event-view:"

const LOCAL_STATUS_VALUES: readonly LocalChallengeStatus[] = [
  "not_started",
  "in_progress",
  "solved",
]
const REMOTE_STATUS_VALUES: readonly RemoteChallengeStatus[] = [
  "no_remote",
  "unsolved",
  "solved",
  "unavailable",
]

function isChallengeSort(value: unknown): value is ChallengeSort {
  return value === "event" || value === "name" || value === "points"
}

function isChallengeGroup(value: unknown): value is ChallengeGroup {
  return value === "category" || value === "status" || value === "none"
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string")
}

function filterEnum<T extends string>(
  values: unknown,
  allowed: readonly T[]
): T[] {
  if (!Array.isArray(values)) return []
  const allowedSet = new Set(allowed)
  return values.filter(
    (item): item is T => typeof item === "string" && allowedSet.has(item as T)
  )
}

/**
 * Coerce an untyped (localStorage / JSON) blob into a valid prefs object,
 * dropping anything unrecognized. Category filters are kept as-is even when a
 * name no longer matches a current challenge — it simply matches nothing and
 * is inert (categories load async, so pruning against them at load time would
 * wipe legitimate filters on the first render).
 */
function sanitize(raw: unknown): EventViewPrefs {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_EVENT_VIEW_PREFS }
  const obj = raw as Record<string, unknown>
  return {
    sort: isChallengeSort(obj.sort) ? obj.sort : DEFAULT_EVENT_VIEW_PREFS.sort,
    group: isChallengeGroup(obj.group)
      ? obj.group
      : DEFAULT_EVENT_VIEW_PREFS.group,
    categoryFilter: stringArray(obj.categoryFilter),
    localFilter: filterEnum(obj.localFilter, LOCAL_STATUS_VALUES),
    remoteFilter: filterEnum(obj.remoteFilter, REMOTE_STATUS_VALUES),
  }
}

export function loadEventViewPrefs(eventId: string): EventViewPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + eventId)
    if (!raw) return { ...DEFAULT_EVENT_VIEW_PREFS }
    return sanitize(JSON.parse(raw))
  } catch {
    return { ...DEFAULT_EVENT_VIEW_PREFS }
  }
}

export function saveEventViewPrefs(
  eventId: string,
  prefs: EventViewPrefs
): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + eventId, JSON.stringify(prefs))
  } catch {
    // non-fatal: storage unavailable (private mode / quota) — prefs stay in-memory
  }
}

/**
 * Per-event challenge list preferences (sort / grouping / filters), persisted
 * to localStorage keyed by event id. Reloads when the event id changes (even
 * without a remount, e.g. a future direct event-to-event link) and writes
 * through on every change.
 */
export function useEventViewPrefs(eventId: string | undefined) {
  const [prefs, setPrefs] = useState<EventViewPrefs>(() =>
    eventId ? loadEventViewPrefs(eventId) : { ...DEFAULT_EVENT_VIEW_PREFS }
  )
  const [loadedEventId, setLoadedEventId] = useState(eventId)
  // React's "adjust state when a prop changes" pattern: when eventId changes
  // mid-life, reload that event's prefs synchronously during render so we
  // neither render with the previous event's filters nor persist them under
  // the new key.
  if (eventId !== loadedEventId) {
    setLoadedEventId(eventId)
    setPrefs(eventId ? loadEventViewPrefs(eventId) : DEFAULT_EVENT_VIEW_PREFS)
  }
  useEffect(() => {
    if (!eventId) return
    saveEventViewPrefs(eventId, prefs)
  }, [eventId, prefs])
  return [prefs, setPrefs] as const
}
