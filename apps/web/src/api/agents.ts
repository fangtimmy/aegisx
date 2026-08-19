import { apiRequest, jsonRequest } from "./client"
import type {
  AgentDetail,
  AgentSessionSummary,
  AgentSummary,
  FleetInfo,
  MessageList,
  QueueItem,
  SwitchModelInput,
} from "./types"

/** Per-agent message (POST /api/agents/:agentId/message). A terminal agent
 * is reopened (files + memory kept — only that agent wakes). */
export type AgentMessageInput = {
  text: string
  deliverAs?: "steer" | "followUp"
}

export type SpawnAgentInput = {
  /** The spawn prompt (strategy input; appended as a Strategy section). */
  prompt?: string
  promptMode?: "strategy" | "override"
  timeoutMs?: number
  model?: string
  source?: "manual" | "scheduler"
}

export type EnqueueSpawnInput = SpawnAgentInput & { challengeId: string }

export function spawnAgent(challengeId: string, input: SpawnAgentInput = {}) {
  return apiRequest<AgentSummary>(
    `/challenges/${challengeId}/agents`,
    jsonRequest("POST", input)
  )
}

/** Enqueue a spawn item (POST /api/events/:id/queue returns the queue item,
 * 202 — the drainer launches it when a fence slot is free). */
export function enqueueSpawn(eventId: string, input: EnqueueSpawnInput) {
  return apiRequest<QueueItem>(
    `/events/${eventId}/queue`,
    jsonRequest("POST", input)
  )
}

export function getAgent(agentId: string) {
  return apiRequest<AgentDetail>(`/agents/${agentId}`)
}

/** The agent's durable committed entries, paginated by per-session seq. */
export function listMessages(agentId: string, after = 0, sessionId?: string) {
  const params = new URLSearchParams()
  if (after > 0) params.set("after", String(after))
  if (sessionId) params.set("sessionId", sessionId)
  const query = params.toString() ? `?${params.toString()}` : ""
  return apiRequest<MessageList>(`/agents/${agentId}/messages${query}`)
}

/** Per-agent message (see SpawnAgentInput note on reopen semantics). */
export function sendMessage(agentId: string, input: AgentMessageInput) {
  return apiRequest<AgentSummary>(
    `/agents/${agentId}/message`,
    jsonRequest("POST", input)
  )
}

export function switchModel(agentId: string, input: SwitchModelInput) {
  return apiRequest<AgentSummary>(
    `/agents/${agentId}/model`,
    jsonRequest("POST", input)
  )
}

export function stopAgent(agentId: string) {
  return apiRequest<AgentSummary>(
    `/agents/${agentId}/stop`,
    jsonRequest("POST", {})
  )
}

/** Terminal close (aborted; files + session survive — a message reopens). */
export function closeAgent(agentId: string) {
  return apiRequest<AgentSummary>(
    `/agents/${agentId}/close`,
    jsonRequest("POST", {})
  )
}

/** Manually compact an agent's context (POST /api/agents/:agentId/compact).
 * Requires an active, idle session; the server rejects a running turn. */
export function compactAgent(agentId: string) {
  return apiRequest<AgentSummary>(
    `/agents/${agentId}/compact`,
    jsonRequest("POST", {})
  )
}

/** Replace the agent's steer/followUp queue. */
export function setAgentQueue(
  agentId: string,
  input: { steering: string[]; followUp: string[] }
) {
  return apiRequest<void>(`/agents/${agentId}/queue`, jsonRequest("PUT", input))
}

// --- multi-session + flat backtrack (v12) ---------------------------------

/** List the agent's sessions (oldest first) with message counts + active
 * flag. Exactly one session is active (the conversation being shown). */
export function listSessions(agentId: string) {
  return apiRequest<{ items: AgentSessionSummary[] }>(
    `/agents/${agentId}/sessions`
  )
}

/** Create a fresh session for the agent and make it active (/new). Old
 * sessions stay in the DB and remain switchable. */
export function createSession(agentId: string) {
  return apiRequest<AgentSummary>(
    `/agents/${agentId}/sessions`,
    jsonRequest("POST", {})
  )
}

/** Switch the agent's active session. */
export function activateSession(agentId: string, sessionId: string) {
  return apiRequest<AgentSummary>(
    `/agents/${agentId}/sessions/${sessionId}/activate`,
    jsonRequest("POST", {})
  )
}

/** Flat backtrack: delete every committed entry after `seq` (the target is
 * kept) in the agent's active session. Irreversible. */
export function backtrack(agentId: string, seq: number) {
  return apiRequest<AgentSummary>(
    `/agents/${agentId}/backtrack`,
    jsonRequest("POST", { seq })
  )
}

/** The event overview's single fleet poll: challenges + per-challenge
 * agents + the scheduler agent + scheduler config/status. */
export function getFleet(eventId: string) {
  return apiRequest<FleetInfo>(`/events/${eventId}/fleet`)
}
