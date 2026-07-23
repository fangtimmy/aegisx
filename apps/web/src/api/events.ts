import { apiRequest, jsonRequest } from "./client"
import type {
  Challenge,
  ChallengeInput,
  EventInput,
  EventStats,
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

export function getEventStats(eventId: string) {
  return apiRequest<EventStats>(`/events/${eventId}/stats`)
}

export function createChallenge(eventId: string, input: ChallengeInput) {
  return apiRequest<Challenge>(
    `/events/${eventId}/challenges`,
    jsonRequest("POST", input)
  )
}
