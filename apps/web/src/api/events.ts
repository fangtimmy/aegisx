import { apiRequest, jsonRequest } from "./client"
import type {
  AgentUsage,
  Challenge,
  ChallengeInput,
  EventInput,
  EventStats,
  EventSummary,
  EventTargetRow,
} from "./types"

export function listEvents() {
  return apiRequest<{ items: EventSummary[] }>("/events")
}

export function createEvent(input: EventInput) {
  return apiRequest<EventSummary>("/events", jsonRequest("POST", input))
}

export function getEvent(eventId: string) {
  return apiRequest<{ event: EventSummary; challenges: Challenge[] }>(
    `/events/${eventId}`
  )
}

export function updateEvent(eventId: string, input: Partial<EventInput>) {
  return apiRequest<EventSummary>(
    `/events/${eventId}`,
    jsonRequest("PATCH", input)
  )
}

export function deleteEvent(eventId: string) {
  return apiRequest<void>(`/events/${eventId}`, { method: "DELETE" })
}

export function deleteEventChallenges(eventId: string) {
  return apiRequest<void>(`/events/${eventId}/challenges`, {
    method: "DELETE",
  })
}

export function deleteEventAgents(
  eventId: string,
  scope: "solver" | "all" = "solver"
) {
  const query = scope === "all" ? "?scope=all" : ""
  return apiRequest<void>(`/events/${eventId}/agents${query}`, {
    method: "DELETE",
  })
}

/** Event emergency halt: freeze the queue + pause the scheduler + hold the
 * inbox + close all live solvers + stop all targets. Reversible. */
export function haltEvent(eventId: string) {
  return apiRequest<{
    closed: number
    targetsStopped: number
    targetFailures: number
  }>(`/events/${eventId}/halt`, jsonRequest("POST", {}))
}

/** Release a halt: inbox backlog flushes, scheduler re-syncs, queue drains. */
export function resumeEvent(eventId: string) {
  return apiRequest<{ state: "running" }>(
    `/events/${eventId}/resume`,
    jsonRequest("POST", {})
  )
}

/** Close every live solver agent (aborted, reopenable); queue and scheduler
 * untouched. */
export function closeEventAgents(eventId: string) {
  return apiRequest<{ closed: number }>(
    `/events/${eventId}/agents/close`,
    jsonRequest("POST", {})
  )
}

export function listEventTargets(eventId: string) {
  return apiRequest<{ items: EventTargetRow[] }>(`/events/${eventId}/targets`)
}

/** Stop every active target of the event (best-effort per row). */
export function stopEventTargets(eventId: string) {
  return apiRequest<{
    stopped: number
    failures: Array<{ challengeId: string; name: string; error: string }>
  }>(`/events/${eventId}/targets/stop-all`, jsonRequest("POST", {}))
}

/** Purge ALL channel data of the event (orch + team + dm). */
export function clearEventChannels(eventId: string) {
  return apiRequest<void>(`/events/${eventId}/channels`, { method: "DELETE" })
}

/** Reset every challenge's solve progress (drop flag histories + overrides
 * + cached verdicts). */
export function resetEventFlags(eventId: string) {
  return apiRequest<{ reset: number }>(`/events/${eventId}/flags`, {
    method: "DELETE",
  })
}

/** Event-wide token usage + cost (aggregated by agents.event_id). */
export function getEventUsage(eventId: string) {
  return apiRequest<{ usage?: AgentUsage }>(`/events/${eventId}/usage`)
}

/** Per-event statistics view (score/billing/efficiency/concurrency/…). */
export function getEventStats(eventId: string) {
  return apiRequest<{ stats: EventStats }>(`/events/${eventId}/stats`)
}

export function createChallenge(eventId: string, input: ChallengeInput) {
  return apiRequest<Challenge>(
    `/events/${eventId}/challenges`,
    jsonRequest("POST", input)
  )
}
