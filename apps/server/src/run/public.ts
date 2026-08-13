import type { ChallengeFlag, RunPublic, RunUsage } from "@aegisx/shared"
import type { AgentSummary } from "@aegisx/shared/agent"

import type { agents, challengeFlags, runs } from "../db/schema"

export type RunRow = typeof runs.$inferSelect
export type AgentRow = typeof agents.$inferSelect

export type ChallengeMeta = {
  name: string
  eventId: string
  targetSupported: boolean
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
  usage?: RunUsage
): RunPublic {
  return {
    id: row.id,
    scopeType: row.scopeType as RunPublic["scopeType"],
    eventId: row.eventId,
    challengeId: row.challengeId,
    challengeName: challenge?.name ?? "",
    orchestration: row.orchestration,
    status: row.status as RunPublic["status"],
    finishing: row.finishing,
    source: row.source as RunPublic["source"],
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
    status: row.status as AgentSummary["status"],
    sessionFile: row.sessionFile,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
    error: row.error,
  }
}
