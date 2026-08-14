import { apiRequest, jsonRequest } from "./client"
import type { AgentSessionSummary, RunPublic, SwitchModelInput } from "./types"

/** Per-agent message (spec §10: POST /api/agents/:agentId/message). A closed
 * run's agent cold-restores the run (fence → container → session). */
export type AgentMessageInput = {
  text: string
  deliverAs?: "steer" | "followUp"
}

export function sendMessage(agentId: string, input: AgentMessageInput) {
  return apiRequest<RunPublic>(
    `/agents/${agentId}/message`,
    jsonRequest("POST", input)
  )
}

export function switchModel(agentId: string, input: SwitchModelInput) {
  return apiRequest<RunPublic>(
    `/agents/${agentId}/model`,
    jsonRequest("POST", input)
  )
}

export function stopAgent(agentId: string) {
  return apiRequest<RunPublic>(
    `/agents/${agentId}/stop`,
    jsonRequest("POST", {})
  )
}

/** Manually compact an agent's context (POST /api/agents/:agentId/compact).
 * Requires an active, idle session; the server rejects a running turn. */
export function compactAgent(agentId: string) {
  return apiRequest<RunPublic>(
    `/agents/${agentId}/compact`,
    jsonRequest("POST", {})
  )
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
  return apiRequest<RunPublic>(
    `/agents/${agentId}/sessions`,
    jsonRequest("POST", {})
  )
}

/** Switch the agent's active session. */
export function activateSession(agentId: string, sessionId: string) {
  return apiRequest<RunPublic>(
    `/agents/${agentId}/sessions/${sessionId}/activate`,
    jsonRequest("POST", {})
  )
}

/** Flat backtrack: delete every committed entry after `seq` (the target is
 * kept) in the agent's active session. Irreversible. */
export function backtrack(agentId: string, seq: number) {
  return apiRequest<RunPublic>(
    `/agents/${agentId}/backtrack`,
    jsonRequest("POST", { seq })
  )
}
