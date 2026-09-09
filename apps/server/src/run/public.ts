import type { AgentSummary, ToolDefinitionSnapshot } from "@aegisx/shared/agent"

import type { agents } from "../db/schema"

export type AgentRow = typeof agents.$inferSelect

/** Per-challenge display metadata, batch-prefetched by the fleet/list
 * queries. */
export type ChallengeMeta = {
  name: string
  eventId: string
  targetSupported: boolean
}

export function toAgentSummary(
  row: AgentRow,
  challengeName = ""
): AgentSummary {
  return {
    id: row.id,
    eventId: row.eventId,
    challengeId: row.challengeId,
    challengeName,
    role: row.role,
    name: row.name,
    model: row.model,
    status: row.status,
    source: row.source,
    prompt: row.prompt,
    summary: row.summary,
    error: row.error,
    deadlineAt: row.deadlineAt,
    lastTimeoutAt: row.lastTimeoutAt,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
  }
}

/** Parse the agents.tools JSON array string (defensively — a malformed value
 * yields [] rather than a render crash). */
export function parseAgentTools(value: string): string[] {
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed)
      ? parsed.filter((t): t is string => typeof t === "string")
      : []
  } catch {
    return []
  }
}

/** Parse the agents.tool_definitions JSON array (name/description/schema).
 * Defensive: null / malformed → []. */
export function parseAgentToolDefinitions(
  value: string | null | undefined
): ToolDefinitionSnapshot[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (item): item is Record<string, unknown> =>
          typeof item === "object" && item !== null && !Array.isArray(item)
      )
      .map((item) => {
        const tool: ToolDefinitionSnapshot = {
          name: typeof item.name === "string" ? item.name : "",
          description:
            typeof item.description === "string" ? item.description : "",
          parameters: item.parameters,
        }
        if (Array.isArray(item.promptGuidelines)) {
          tool.promptGuidelines = item.promptGuidelines.filter(
            (g): g is string => typeof g === "string"
          )
        }
        return tool
      })
  } catch {
    return []
  }
}
