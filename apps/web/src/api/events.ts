import { apiRequest, jsonRequest } from "./client"
import type {
  AgentUsage,
  Challenge,
  ChallengeInput,
  EventInput,
  EventSummary,
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

export function deleteEventAgents(eventId: string, scope: "solver" | "all" = "solver") {
  const query = scope === "all" ? "?scope=all" : ""
  return apiRequest<void>(`/events/${eventId}/agents${query}`, {
    method: "DELETE",
  })
}

/** Event-wide token usage + cost (aggregated by agents.event_id). */
export function getEventUsage(eventId: string) {
  return apiRequest<{ usage?: AgentUsage }>(`/events/${eventId}/usage`)
}

export function createChallenge(eventId: string, input: ChallengeInput) {
  return apiRequest<Challenge>(
    `/events/${eventId}/challenges`,
    jsonRequest("POST", input)
  )
}
