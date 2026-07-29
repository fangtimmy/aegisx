import type { RunPublic } from "../../../shared"
import type { runs } from "../db/schema"

export type RunRow = typeof runs.$inferSelect

export type ChallengeMeta = {
  name: string
  eventId: string
  targetSupported: boolean
}

export function toRunPublic(row: RunRow, challenge?: ChallengeMeta): RunPublic {
  return {
    id: row.id,
    challengeId: row.challengeId,
    challengeName: challenge?.name ?? "",
    eventId: challenge?.eventId ?? "",
    status: row.status as RunPublic["status"],
    targetSupported: challenge?.targetSupported ?? false,
    launcher: (row.launcher ?? "pi") as "pi",
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
    piSessionId: row.piSessionId,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
    error: row.error,
    summary: row.summary,
    flag: row.flag,
    hasFlag: Boolean(row.flag),
  }
}
