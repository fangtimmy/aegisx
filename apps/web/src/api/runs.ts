import { apiRequest, jsonRequest } from "./client"
import type {
  MessageList,
  QueueItem,
  RunDetail,
  RunFile,
  RunPublic,
} from "./types"

export type CreateRunInput = {
  /** Orchestration plugin id (defaults to 'classic' server-side). */
  orchestration?: string
  /** Overrides the rendered `initial` template as the run's first prompt. */
  prompt?: string
  /** Per-run hard deadline (ms). Defaults to scheduler.defaultRunTimeoutMs. */
  timeoutMs?: number
}

export function listEventRuns(eventId: string) {
  return apiRequest<{ items: RunPublic[] }>(`/events/${eventId}/runs`)
}

/** Enqueue a run (POST /api/challenges/:id/runs returns a queue
 * item, 202 — the drainer launches it when a fence slot is free). */
export function createRun(challengeId: string, input: CreateRunInput) {
  return apiRequest<QueueItem>(
    `/challenges/${challengeId}/runs`,
    jsonRequest("POST", input)
  )
}

export function getRun(runId: string) {
  return apiRequest<RunDetail>(`/runs/${runId}`)
}

export function stopRun(runId: string) {
  return apiRequest<RunPublic>(`/runs/${runId}/stop`, jsonRequest("POST", {}))
}

export function closeRun(runId: string) {
  return apiRequest<RunPublic>(`/runs/${runId}/close`, jsonRequest("POST", {}))
}

export function setQueue(
  runId: string,
  input: { steering: string[]; followUp: string[] }
) {
  return apiRequest<void>(`/runs/${runId}/queue`, jsonRequest("PUT", input))
}

/**
 * List a run's committed messages, paginated. The `after` cursor is opaque —
 * echo back `nextAfter` from the previous response. Two semantics server-side:
 * run-level (no `agentId`) → SQLite rowid (insertion order across all agents'
 * active sessions); per-agent → the per-session seq. `after=0` (default) is a
 * full pull, which is what all current call sites use.
 */
export function listMessages(runId: string, after = 0, agentId?: string) {
  const params = new URLSearchParams()
  if (after > 0) params.set("after", String(after))
  if (agentId) params.set("agentId", agentId)
  const query = params.toString() ? `?${params.toString()}` : ""
  return apiRequest<MessageList>(`/runs/${runId}/messages${query}`)
}

export function getRunFile(runId: string, path: string) {
  return apiRequest<RunFile>(
    `/runs/${runId}/files?path=${encodeURIComponent(path)}`
  )
}
