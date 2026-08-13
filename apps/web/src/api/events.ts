import { apiRequest, jsonRequest } from "./client"
import type {
  Challenge,
  ChallengeInput,
  EventInput,
  EventSummary,
  RunUsage,
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

/** Event-wide token usage + cost (spec §10; session_entries.runId is the
 * redundant run-level key that makes this one indexed query). */
export function getEventUsage(eventId: string) {
  return apiRequest<{ usage?: RunUsage }>(`/events/${eventId}/usage`)
}

export function createChallenge(eventId: string, input: ChallengeInput) {
  return apiRequest<Challenge>(
    `/events/${eventId}/challenges`,
    jsonRequest("POST", input)
  )
}
