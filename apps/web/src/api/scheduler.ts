import { apiRequest, jsonRequest } from "./client"
import type { QueueItem, SchedulerInfo } from "./types"

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
  return apiRequest<{ items: QueueItem[] }>(`/events/${eventId}/queue`)
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

/** Start the event-scoped scheduler run (creates the orchestrator run + agent). */
export function startScheduler(eventId: string) {
  return apiRequest<SchedulerInfo>(
    `/events/${eventId}/scheduler/start`,
    jsonRequest("POST", {})
  )
}
