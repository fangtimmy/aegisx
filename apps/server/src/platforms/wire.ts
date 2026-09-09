import type { ChallengeFlag } from "@aegisx/shared"
import { isActiveAgentStatus } from "@aegisx/shared"

import type { agents, challengeFlags } from "../db/schema"

export function toFlagPublic(
  row: typeof challengeFlags.$inferSelect
): ChallengeFlag {
  return {
    id: row.id,
    challengeId: row.challengeId,
    flag: row.flag,
    status: row.status,
    source: row.source,
    agentId: row.agentId,
    remoteId: row.remoteId,
    message: row.message,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/** Collapse raw agent rows into real dispatch attempts: every agent row a
 * queue item spawned shares that item's queueItemId (a re-launch after a
 * crash-recovery reset, or a ghost replay), and to a scheduler reading
 * "prior attempts" those extra rows read as independent failures. One
 * representative per queue item (running > live > newest); direct spawns
 * (no queue item) each count as their own attempt. */
export function collapseToAttempts(
  rows: Array<typeof agents.$inferSelect>
): Array<typeof agents.$inferSelect> {
  const byItem = new Map<string, Array<typeof agents.$inferSelect>>()
  const direct: Array<typeof agents.$inferSelect> = []
  for (const row of rows) {
    if (row.queueItemId) {
      const group = byItem.get(row.queueItemId)
      if (group) group.push(row)
      else byItem.set(row.queueItemId, [row])
    } else {
      direct.push(row)
    }
  }
  const representatives = [...byItem.values()].map(
    (group) =>
      group.toSorted(
        (a, b) =>
          attemptRank(b) - attemptRank(a) ||
          (a.createdAt < b.createdAt ? 1 : -1)
      )[0]
  )
  return [...representatives, ...direct].toSorted((a, b) =>
    a.createdAt === b.createdAt
      ? a.id < b.id
        ? -1
        : 1
      : a.createdAt < b.createdAt
        ? -1
        : 1
  )
}

/** Representative preference within one queue item's rows. */
function attemptRank(row: typeof agents.$inferSelect): number {
  if (row.status === "running") return 3
  return isActiveAgentStatus(row.status) ? 2 : 1
}
