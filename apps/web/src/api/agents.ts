import { apiRequest, jsonRequest } from "./client"
import type { RunPublic, SwitchModelInput } from "./types"

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
