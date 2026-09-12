import { LIVE_AGENT_STATUSES } from "@aegisx/shared"
import { and, eq, inArray } from "drizzle-orm"

import type { Database } from "../db"
import { agents } from "../db/schema"
import { logEvent } from "../lib/log"
import { renderTemplateBody } from "../orchestration/prompt-templates"

type BootReentryDeps = {
  db: Database
  /** Direct send into the scheduler's runtime (service.sendToAgent). */
  send(agentId: string, text: string): Promise<void>
  /** A disabled scheduler is not woken (W3). */
  isSchedulerPaused(eventId: string): boolean
  /** The (user-editable) noticeBootReentry template body — same store as
   * orch-notices; `{{idleAgents}}` is its only variable. */
  templateBody: (key: "noticeBootReentry") => string
}

/**
 * Restart re-entry notice. `recoverOnBoot` intentionally does not resume
 * agents, and only `AEGISX_BOOTSTRAP=1` deployments restart the scheduler —
 * an event whose non-terminal scheduler already exists would otherwise sit
 * silent after a restart with no one to re-sync.
 *
 * One message per event, to the SCHEDULER only: waking every solver directly
 * would cost a token burst per agent and pre-empt the scheduler's own
 * re-dispatch decision. Events without a non-terminal scheduler are skipped
 * (bootstrap / the user starts it), as are events whose scheduler is
 * deliberately disabled.
 */
export async function notifyBootReentry(deps: BootReentryDeps): Promise<void> {
  const orchestrators = deps.db
    .select({ id: agents.id, eventId: agents.eventId })
    .from(agents)
    .where(
      and(
        eq(agents.role, "orchestrator"),
        inArray(agents.status, [...LIVE_AGENT_STATUSES])
      )
    )
    .all()
  for (const scheduler of orchestrators) {
    if (deps.isSchedulerPaused(scheduler.eventId)) continue
    // The actionable count for the scheduler: live solvers it manages.
    const idleAgents = deps.db
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.eventId, scheduler.eventId),
          eq(agents.role, "solver"),
          inArray(agents.status, [...LIVE_AGENT_STATUSES])
        )
      )
      .all().length
    try {
      await deps.send(
        scheduler.id,
        renderTemplateBody(deps.templateBody("noticeBootReentry"), {
          idleAgents,
        })
      )
      logEvent("boot", "scheduler_reentry", {
        eventId: scheduler.eventId,
        idleAgents,
      })
    } catch (error) {
      // Best-effort: one scheduler failing to rebuild (provider gone, gateway
      // down, ...) must not abort re-entry for other events or fail boot.
      console.warn("boot: scheduler re-entry failed", {
        eventId: scheduler.eventId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}
