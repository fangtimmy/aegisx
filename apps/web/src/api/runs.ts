import { apiRequest, jsonRequest } from "./client"
import type {
  AgentInspector,
  AgentMessages,
  Message,
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

export function getAgentMessages(runId: string, agentId: string, after = 0) {
  const params = new URLSearchParams({
    agentId,
    after: String(after),
  })
  return apiRequest<AgentMessages>(`/runs/${runId}/messages?${params}`)
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
  const path =
    action === "message"
      ? `/runs/${runId}/messages`
      : `/runs/${runId}/${action}`
  return apiRequest<RunPublic>(path, jsonRequest("POST", body))
}

export function deleteRun(runId: string) {
  return apiRequest<void>(`/runs/${runId}`, { method: "DELETE" })
}

export function getRunFile(runId: string, path: string) {
  return apiRequest<RunFile>(
    `/runs/${runId}/files?path=${encodeURIComponent(path)}`
  )
}

export type { Message }
