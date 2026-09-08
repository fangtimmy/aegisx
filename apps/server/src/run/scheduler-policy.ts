import type { NextTaskPolicy } from "@aegisx/shared/scheduler"
import { eq } from "drizzle-orm"

import type { Database } from "../db"
import { schedulerConfig } from "../db/schema"

export type { NextTaskPolicy }

export type SchedulerPolicy = {
  notifyTeamOnFlag: boolean
  stopSiblingsOnSolve: boolean
  stopTargetOnSolve: boolean
  stopSubmitterOnSolve: boolean
  nextTaskPolicy: NextTaskPolicy
  urgentTeamMessages: boolean
  blockSpawnOnSolved: boolean
}

/** The event's orchestration policy with defaults coalesced (a missing
 * scheduler_config row behaves like the defaults). Shared read side for the
 * flag hooks (service.ts), the spawn fence (fence.ts), and the channel
 * delivery path (channels.ts) — the single place these knobs resolve. */
export function schedulerPolicyFor(
  db: Database,
  eventId: string
): SchedulerPolicy {
  const row = db
    .select({
      notifyTeamOnFlag: schedulerConfig.notifyTeamOnFlag,
      stopSiblingsOnSolve: schedulerConfig.stopSiblingsOnSolve,
      stopTargetOnSolve: schedulerConfig.stopTargetOnSolve,
      stopSubmitterOnSolve: schedulerConfig.stopSubmitterOnSolve,
      nextTaskPolicy: schedulerConfig.nextTaskPolicy,
      urgentTeamMessages: schedulerConfig.urgentTeamMessages,
      blockSpawnOnSolved: schedulerConfig.blockSpawnOnSolved,
    })
    .from(schedulerConfig)
    .where(eq(schedulerConfig.eventId, eventId))
    .get()
  return {
    notifyTeamOnFlag: row?.notifyTeamOnFlag ?? true,
    stopSiblingsOnSolve: row?.stopSiblingsOnSolve ?? true,
    stopTargetOnSolve: row?.stopTargetOnSolve ?? true,
    stopSubmitterOnSolve: row?.stopSubmitterOnSolve ?? false,
    nextTaskPolicy: row?.nextTaskPolicy === "drained" ? "drained" : "eager",
    urgentTeamMessages: row?.urgentTeamMessages ?? true,
    blockSpawnOnSolved: row?.blockSpawnOnSolved ?? true,
  }
}
