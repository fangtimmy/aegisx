import type { SolverSpec } from "@aegisx/shared"

import { apiRequest, jsonRequest } from "./client"
import type {
  FleetInfo,
  MessageList,
  QueueItem,
  RunDetail,
  RunFile,
  RunPublic,
} from "./types"

export type CreateRunInput = {
  /** v9 run-level strategy — rendered into every solver's initial Strategy
   *  section. */
  strategy?: string
  /** Per-run hard deadline (ms). Defaults to scheduler.defaultRunTimeoutMs. */
  timeoutMs?: number
  /** v9 solver count (1..4, default 1). */
  solver_count?: number
  /** v9 model ref applied to every solver. */
  model?: string
  /** v9 per-solver specs (advanced); takes precedence over model/solver_count. */
  solvers?: SolverSpec[]
}

export function listEventRuns(eventId: string) {
  return apiRequest<{ items: RunPublic[] }>(`/events/${eventId}/runs`)
}

/** W7.3: the event overview's single fleet poll (runs + agents + scheduler
 * run/agents + config/status) — replaces listEventRuns + N× getRun + GET
 * /scheduler for the fleet view. */
export function getFleet(eventId: string) {
  return apiRequest<FleetInfo>(`/events/${eventId}/fleet`)
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

/** Add one more solver to a run (POST /api/runs/:runId/agents).
 * `prompt` is required — expansion always comes with a job. A closed run is
 * cold-restored first (the old solvers stay dormant until messaged). */
export function addRunAgent(
  runId: string,
  input: {
    prompt: string
    model?: string
    promptMode?: "strategy" | "override"
  }
) {
  return apiRequest<RunPublic>(
    `/runs/${runId}/agents`,
    jsonRequest("POST", input)
  )
}

export function closeRun(runId: string) {
  return apiRequest<RunPublic>(`/runs/${runId}/close`, jsonRequest("POST", {}))
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
