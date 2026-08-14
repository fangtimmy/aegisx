import { apiRequest, jsonRequest } from "./client"
import type {
  QueueItem,
  QueueSnapshot,
  RunPublic,
  SchedulerInfo,
} from "./types"

export function getScheduler(eventId: string) {
  return apiRequest<SchedulerInfo>(`/events/${eventId}/scheduler`)
}

/** PATCH the event-level scheduler config (model / instruction / target cap).
 * Affects the scheduler run at next start; the live model can also be switched
 * per-agent on a running scheduler. */
export function updateSchedulerConfig(
  eventId: string,
  patch: {
    modelId?: string | null
    instruction?: string
    maxConcurrentTargets?: number
  }
) {
  return apiRequest<SchedulerInfo>(
    `/events/${eventId}/scheduler`,
    jsonRequest("PATCH", patch)
  )
}

export function listQueue(eventId: string) {
  return apiRequest<QueueSnapshot>(`/events/${eventId}/queue`)
}

/** Pause the event's queue: blocks FUTURE launches (running runs keep going). */
export function pauseQueue(eventId: string) {
  return apiRequest<{ state: "paused" }>(
    `/events/${eventId}/queue/pause`,
    jsonRequest("POST", {})
  )
}

/** Resume the event's queue (re-enables the drainer). */
export function resumeQueue(eventId: string) {
  return apiRequest<{ state: "running" }>(
    `/events/${eventId}/queue/resume`,
    jsonRequest("POST", {})
  )
}

/** Edit a pending queue item's prompt / timeout / params (running rejects). */
export function updateQueueItem(
  eventId: string,
  itemId: string,
  patch: {
    prompt?: string
    timeoutMs?: number
    params?: Record<string, unknown>
  }
) {
  return apiRequest<QueueItem>(
    `/events/${eventId}/queue/${itemId}`,
    jsonRequest("PATCH", patch)
  )
}

/** Remove a queue item (pending/done/failed; running rejects). */
export function removeQueueItem(eventId: string, itemId: string) {
  return apiRequest<void>(`/events/${eventId}/queue/${itemId}`, {
    method: "DELETE",
  })
}

/** Reorder pending items by id (running items keep their place). */
export function reorderQueue(eventId: string, itemIds: string[]) {
  return apiRequest<{ items: QueueItem[] }>(
    `/events/${eventId}/queue/reorder`,
    jsonRequest("POST", { itemIds })
  )
}

export function clearQueue(eventId: string) {
  return apiRequest<void>(
    `/events/${eventId}/queue/clear`,
    jsonRequest("POST", {})
  )
}

/** Start the event-scoped scheduler run. W3.2: default = restore semantics
 * (closed run → cold-restore keeping memory); `reset: true` deletes the closed
 * run (cascade agents/sessions) and starts fresh. */
export function startScheduler(eventId: string, reset = false) {
  return apiRequest<SchedulerInfo>(
    `/events/${eventId}/scheduler/start`,
    jsonRequest("POST", { reset })
  )
}

/** W3.1: disable the scheduler (paused flag + abort current turn, container
 * kept warm). The flag is written even with no scheduler run. */
export function pauseScheduler(eventId: string) {
  return apiRequest<RunPublic | null>(
    `/events/${eventId}/scheduler/pause`,
    jsonRequest("POST", {})
  )
}

/** W3.1: re-enable the scheduler (clear flag + tell the orchestrator to
 * re-sync before acting). */
export function resumeScheduler(eventId: string) {
  return apiRequest<RunPublic | null>(
    `/events/${eventId}/scheduler/resume`,
    jsonRequest("POST", {})
  )
}

/** Close the scheduler run (→ closed; cold-restorable via start). */
export function closeScheduler(eventId: string) {
  return apiRequest<RunPublic>(
    `/events/${eventId}/scheduler/close`,
    jsonRequest("POST", {})
  )
}
