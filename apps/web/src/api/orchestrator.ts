import { apiRequest, jsonRequest } from "./client"
import type {
  MessageList,
  OrchestratorConfigInput,
  OrchestratorDetail,
} from "./types"

export type OrchestratorMessageInput = {
  text: string
  deliverAs?: "steer" | "followUp"
}

export function getOrchestrator(eventId: string) {
  return apiRequest<OrchestratorDetail>(`/events/${eventId}/orchestrator`)
}

export function patchOrchestrator(
  eventId: string,
  input: OrchestratorConfigInput
) {
  return apiRequest<OrchestratorDetail>(
    `/events/${eventId}/orchestrator`,
    jsonRequest("PATCH", input)
  )
}

export function listOrchestratorMessages(eventId: string, after = 0) {
  const query = after > 0 ? `?after=${after}` : ""
  return apiRequest<MessageList>(
    `/events/${eventId}/orchestrator/messages${query}`
  )
}

export function sendOrchestratorMessage(
  eventId: string,
  input: OrchestratorMessageInput
) {
  return apiRequest<OrchestratorDetail>(
    `/events/${eventId}/orchestrator/message`,
    jsonRequest("POST", input)
  )
}

export function startOrchestrator(eventId: string) {
  return apiRequest<OrchestratorDetail>(
    `/events/${eventId}/orchestrator/start`,
    jsonRequest("POST", {})
  )
}

export function stopOrchestrator(eventId: string) {
  return apiRequest<OrchestratorDetail>(
    `/events/${eventId}/orchestrator/stop`,
    jsonRequest("POST", {})
  )
}

export function closeOrchestrator(eventId: string) {
  return apiRequest<OrchestratorDetail>(
    `/events/${eventId}/orchestrator/close`,
    jsonRequest("POST", {})
  )
}
