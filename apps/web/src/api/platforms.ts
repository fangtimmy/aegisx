import { apiRequest, jsonRequest } from "./client"
import type {
  EventPlatform,
  PlatformType,
  RemoteChallengeSummary,
  RemoteEvent,
} from "./types"

export type PlatformConnectionInput = {
  type: PlatformType
  baseUrl: string
  credential: string
}

export type BindPlatformInput = PlatformConnectionInput & {
  remoteEventId: string
}

export function discoverRemoteEvents(input: PlatformConnectionInput) {
  return apiRequest<{ items: RemoteEvent[] }>(
    "/platform/events/discover",
    jsonRequest("POST", input)
  )
}

export function testPlatformConnection(input: PlatformConnectionInput) {
  return apiRequest<{ credential: string | null }>(
    "/platform/connection/test",
    jsonRequest("POST", input)
  )
}

export function bindPlatform(eventId: string, input: BindPlatformInput) {
  return apiRequest<EventPlatform>(
    `/events/${eventId}/platform`,
    jsonRequest("PUT", input)
  )
}

export function testBoundPlatform(eventId: string) {
  return apiRequest<{ ok: true }>(`/events/${eventId}/platform/test`, {
    method: "POST",
  })
}

export function unbindPlatform(eventId: string) {
  return apiRequest<void>(`/events/${eventId}/platform`, { method: "DELETE" })
}

export function discoverChallenges(eventId: string) {
  return apiRequest<{ syncedAt: string; items: RemoteChallengeSummary[] }>(
    `/events/${eventId}/platform/challenges/discover`,
    { method: "POST" }
  )
}
