import type {
  AgentSummary,
  InboxSnapshot,
  SpawnQueueParams,
} from "@aegisx/shared"

import { apiRequest, jsonRequest } from "./client"
import type { QueueItem, QueueSnapshot, SchedulerInfo } from "./types"

export function getScheduler(eventId: string) {
  return apiRequest<SchedulerInfo>(`/events/${eventId}/scheduler`)
}

/** PATCH the event-level scheduler config (model / instruction / target cap /
 * orchestration policy). Model + instruction affect the scheduler agent at
 * next start; policy toggles apply live. */
export function updateSchedulerConfig(
  eventId: string,
  patch: {
    modelId?: string | null
    instruction?: string
    maxConcurrentTargets?: number
    notifyTeamOnFlag?: boolean
    stopSiblingsOnSolve?: boolean
    stopTargetOnSolve?: boolean
    nextTaskPolicy?: "eager" | "drained"
    urgentTeamMessages?: boolean
    blockSpawnOnSolved?: boolean
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

/** The scheduler orch inbox status (the scheduler DM view's status header):
 * unread backlog / next flush tick / delivery hold. */
export function getInbox(eventId: string) {
  return apiRequest<InboxSnapshot>(`/events/${eventId}/inbox`)
}

/** Hold delivery for the event (posts store only — the flush tick and
 * urgent deliveries skip the event entirely). */
export function pauseInbox(eventId: string) {
  return apiRequest<{ deliveryPaused: boolean }>(
    `/events/${eventId}/inbox/pause`,
    jsonRequest("POST", {})
  )
}

/** Resume delivery — the next tick/urgent post catches up the backlog. */
export function resumeInbox(eventId: string) {
  return apiRequest<{ deliveryPaused: boolean }>(
    `/events/${eventId}/inbox/resume`,
    jsonRequest("POST", {})
  )
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
    params?: SpawnQueueParams
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

/** Start the event's scheduler agent. W3.2: default = reopen semantics
 * (terminal agent → reopened keeping files + memory); `reset: true` deletes
 * the terminal agent (cascade sessions) and starts fresh. */
export function startScheduler(eventId: string, reset = false) {
  return apiRequest<AgentSummary>(
    `/events/${eventId}/scheduler/start`,
    jsonRequest("POST", { reset })
  )
}

/** W3.1: disable the scheduler (paused flag + abort current turn, container
 * kept warm). The flag is written even with no scheduler agent. */
export function pauseScheduler(eventId: string) {
  return apiRequest<AgentSummary | null>(
    `/events/${eventId}/scheduler/pause`,
    jsonRequest("POST", {})
  )
}

/** W3.1: re-enable the scheduler (clear flag + tell the orchestrator to
 * re-sync before acting). */
export function resumeScheduler(eventId: string) {
  return apiRequest<AgentSummary | null>(
    `/events/${eventId}/scheduler/resume`,
    jsonRequest("POST", {})
  )
}

/** Close the scheduler agent (→ aborted; reopenable via start). */
export function closeScheduler(eventId: string) {
  return apiRequest<AgentSummary>(
    `/events/${eventId}/scheduler/close`,
    jsonRequest("POST", {})
  )
}
