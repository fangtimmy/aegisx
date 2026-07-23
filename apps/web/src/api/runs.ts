import { apiRequest, jsonRequest } from "./client"
import type {
  AgentConversation,
  AgentInspector,
  RunDetail,
  RunFile,
  RunPublic,
  ThinkingLevel,
} from "./types"

export type CreateRunInput = {
  modelId?: string
  environment?: "local" | "container"
  image?: string
  thinkingLevel?: ThinkingLevel
}

export type RunControlAction = "message" | "pause" | "resume" | "stop"

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

export function getAgentConversation(runId: string, agentId: string) {
  return apiRequest<AgentConversation>(
    `/runs/${runId}/conversation?agentId=${encodeURIComponent(agentId)}`
  )
}

export function getAgentInspector(runId: string, agentId: string) {
  return apiRequest<AgentInspector>(
    `/runs/${runId}/agents/${agentId}/inspector`
  )
}

export function controlRun(
  runId: string,
  action: RunControlAction,
  body: { message?: string; clientMessageId?: string } = {}
) {
  return apiRequest<void>(`/runs/${runId}/${action}`, jsonRequest("POST", body))
}

export function deleteRun(runId: string) {
  return apiRequest<void>(`/runs/${runId}`, { method: "DELETE" })
}

export function getRunFile(runId: string, path: string) {
  return apiRequest<RunFile>(
    `/runs/${runId}/files?path=${encodeURIComponent(path)}`
  )
}
