import { apiRequest, jsonRequest } from "./client"
import type {
  MessageList,
  RunDetail,
  RunFile,
  RunPublic,
  SwitchModelInput,
  ThinkingLevel,
} from "./types"

export type CreateRunInput = {
  modelId?: string
  image?: string
  thinkingLevel?: ThinkingLevel
}

export type SendMessageInput = {
  text: string
  deliverAs?: "steer" | "followUp"
}

export function listEventRuns(eventId: string) {
  return apiRequest<{ items: RunPublic[] }>(`/events/${eventId}/runs`)
}

export function createRun(challengeId: string, input: CreateRunInput) {
  return apiRequest<RunPublic>(
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

export function deleteRun(runId: string) {
  return apiRequest<void>(`/runs/${runId}`, { method: "DELETE" })
}

export function sendMessage(runId: string, input: SendMessageInput) {
  return apiRequest<RunPublic>(
    `/runs/${runId}/message`,
    jsonRequest("POST", input)
  )
}

export function setQueue(
  runId: string,
  input: { steering: string[]; followUp: string[] }
) {
  return apiRequest<void>(`/runs/${runId}/queue`, jsonRequest("PUT", input))
}

export function switchModel(runId: string, input: SwitchModelInput) {
  return apiRequest<RunPublic>(
    `/runs/${runId}/switch-model`,
    jsonRequest("POST", input)
  )
}

export function finishRun(runId: string, summary: string) {
  return apiRequest<RunPublic>(
    `/runs/${runId}/finish`,
    jsonRequest("POST", { summary })
  )
}

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
