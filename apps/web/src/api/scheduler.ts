import { apiRequest, jsonRequest } from "./client"
import type { QueueItem, SchedulerInfo } from "./types"

export function getScheduler(eventId: string) {
  return apiRequest<SchedulerInfo>(`/events/${eventId}/scheduler`)
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

/** Stop the scheduler run's current turn (container kept). */
export function stopScheduler(eventId: string) {
  return apiRequest<void>(
    `/events/${eventId}/scheduler/stop`,
    jsonRequest("POST", {})
  )
}

/** Close the scheduler run (releases container + session). */
export function closeScheduler(eventId: string) {
  return apiRequest<void>(
    `/events/${eventId}/scheduler/close`,
    jsonRequest("POST", {})
  )
}
