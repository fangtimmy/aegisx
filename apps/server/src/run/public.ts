import type { ChallengeFlag, RunPublic, RunUsage } from "@aegisx/shared"
import type { AgentSummary, ToolDefinitionSnapshot } from "@aegisx/shared/agent"

import type { agents, challengeFlags, runs } from "../db/schema"

export type RunRow = typeof runs.$inferSelect
export type AgentRow = typeof agents.$inferSelect

export type ChallengeMeta = {
  name: string
  eventId: string
  targetSupported: boolean
}

/** Resolved model display fields for {@link toRunPublic}, derived from the run
 * row's `model` ref string by the caller (it needs the provider list). */
export type RunModelDisplay = {
  provider: string
  modelId: string
  modelName: string
  thinkingLevel: RunPublic["thinkingLevel"]
}

export function toFlagPublic(
  row: typeof challengeFlags.$inferSelect
): ChallengeFlag {
  return {
    id: row.id,
    challengeId: row.challengeId,
    flag: row.flag,
    status: row.status as ChallengeFlag["status"],
    source: row.source as ChallengeFlag["source"],
    runId: row.runId,
    remoteId: row.remoteId,
    message: row.message,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export function toRunPublic(
  row: RunRow,
  challenge?: ChallengeMeta,
  flags: ChallengeFlag[] = [],
  usage?: RunUsage,
  model?: RunModelDisplay
): RunPublic {
  return {
    id: row.id,
    scopeType: row.scopeType as RunPublic["scopeType"],
    eventId: row.eventId,
    challengeId: row.challengeId,
    challengeName: challenge?.name ?? "",
    status: row.status as RunPublic["status"],
    finishing: row.finishing,
    source: row.source as RunPublic["source"],
    targetSupported: challenge?.targetSupported ?? false,
    provider: model?.provider ?? "",
    modelId: model?.modelId ?? "",
    modelName: model?.modelName ?? row.model,
    thinkingLevel: (model?.thinkingLevel ??
      "off") as RunPublic["thinkingLevel"],
    environment: "container",
    image: row.image,
    cpus: row.cpus,
    memoryMb: row.memoryMb,
    pidsLimit: row.pidsLimit,
    containerName: row.containerName,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
    deadlineAt: row.deadlineAt,
    lastTimeoutAt: row.lastTimeoutAt,
    error: row.error,
    summary: row.summary,
    flags,
    hasAcceptedFlag: flags.some((flag) => flag.status === "accepted"),
    usage,
  }
}

export function toAgentSummary(row: AgentRow): AgentSummary {
  return {
    id: row.id,
    runId: row.runId,
    slot: row.slot,
    role: row.role,
    parentAgentId: row.parentAgentId,
    isEntry: row.isEntry,
    name: row.name,
    task: row.task,
    model: row.model,
    // System prompt + tool allowlist snapshot (createAgent writes once; the
    // timeline renders a system-config card from them).
    systemPrompt: row.systemPrompt,
    tools: parseAgentTools(row.tools),
    toolDefinitions: parseAgentToolDefinitions(row.toolDefinitions),
    status: row.status as AgentSummary["status"],
    sessionFile: row.sessionFile,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
    error: row.error,
  }
}

/** Parse the agents.tools JSON array string (defensively — a malformed value
 * yields [] rather than a render crash). */
function parseAgentTools(value: string): string[] {
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
function parseAgentToolDefinitions(
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
