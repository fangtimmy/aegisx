import { apiRequest, jsonRequest } from "./client"
import type {
  RunDetail,
  RunFile,
  RunPublic,
  RunSessionList,
  ThinkingLevel,
} from "./types"

export type CreateRunInput = {
  modelId?: string
  image?: string
  thinkingLevel?: ThinkingLevel
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

export function resumeRun(runId: string) {
  return apiRequest<RunPublic>(`/runs/${runId}/resume`, jsonRequest("POST", {}))
}

export function deleteRun(runId: string) {
  return apiRequest<void>(`/runs/${runId}`, { method: "DELETE" })
}

export function getRunFile(runId: string, path: string) {
  return apiRequest<RunFile>(
    `/runs/${runId}/files?path=${encodeURIComponent(path)}`
  )
}

export function listRunSessions(runId: string) {
  return apiRequest<RunSessionList>(`/runs/${runId}/sessions`)
}
