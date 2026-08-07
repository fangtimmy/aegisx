import type { RunPublic, RunUsage } from "@aegisx/shared"
import type { AgentSummary } from "@aegisx/shared/agent"

import type { agents, runs } from "../db/schema"

export type RunRow = typeof runs.$inferSelect
export type AgentRow = typeof agents.$inferSelect

export type ChallengeMeta = {
  name: string
  eventId: string
  targetSupported: boolean
}

export function toRunPublic(
  row: RunRow,
  challenge?: ChallengeMeta,
  usage?: RunUsage
): RunPublic {
  return {
    id: row.id,
    challengeId: row.challengeId,
    challengeName: challenge?.name ?? "",
    eventId: challenge?.eventId ?? "",
    status: row.status as RunPublic["status"],
    targetSupported: challenge?.targetSupported ?? false,
    provider: row.provider,
    modelId: row.modelId,
    modelName: row.modelLabel ?? row.modelId,
    thinkingLevel: row.thinkingLevel as RunPublic["thinkingLevel"],
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
    error: row.error,
    summary: row.summary,
    flag: row.flag,
    hasFlag: Boolean(row.flag),
    usage,
  }
}

export function toAgentSummary(row: AgentRow): AgentSummary {
  return {
    id: row.id,
    runId: row.runId,
    role: row.role as AgentSummary["role"],
    parentAgentId: row.parentAgentId,
    name: row.name,
    task: row.task,
    status: row.status as AgentSummary["status"],
    sessionFile: row.sessionFile,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
    error: row.error,
  }
}
