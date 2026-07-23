import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm"
import type { createDatabase } from "../db"
import { agentToolCalls, runAgents, runEvents, runs } from "../db/schema"
import { parseEnvironment } from "./config"

type Database = ReturnType<typeof createDatabase>["db"]

const terminalRunStatuses = ["completed", "failed", "stopped"] as const

export function recoverInterruptedRuns(db: Database): string[] {
  const staleContainerRuns = db
    .select({ id: runs.id, environmentConfig: runs.environmentConfig })
    .from(runs)
    .all()
    .filter(
      ({ environmentConfig }) =>
        parseEnvironment(environmentConfig).type === "container"
    )
    .map(({ id }) => id)

  const pendingCompletions = db
    .select({ id: runs.id, summary: runs.pendingCompletionSummary })
    .from(runs)
    .where(
      and(eq(runs.status, "running"), isNotNull(runs.pendingCompletionSummary))
    )
    .all()

  const interruptedAt = new Date().toISOString()
  db.update(agentToolCalls)
    .set({
      status: "abandoned",
      succeeded: false,
      error: "Server stopped before the tool call completed",
      completedAt: interruptedAt,
    })
    .where(eq(agentToolCalls.status, "running"))
    .run()

  for (const pending of pendingCompletions) {
    const completedAt = new Date().toISOString()
    db.transaction((tx) => {
      tx.update(runAgents)
        .set({ status: "stopped", completedAt, updatedAt: completedAt })
        .where(
          and(
            eq(runAgents.runId, pending.id),
            isNotNull(runAgents.parentAgentId),
            inArray(runAgents.status, ["running", "idle", "paused"])
          )
        )
        .run()
      tx.update(runAgents)
        .set({
          status: "completed",
          summary: pending.summary,
          error: null,
          completedAt,
          updatedAt: completedAt,
        })
        .where(
          and(eq(runAgents.runId, pending.id), isNull(runAgents.parentAgentId))
        )
        .run()
      tx.update(runs)
        .set({
          status: "completed",
          summary: pending.summary,
          pendingCompletionSummary: null,
          error: null,
          completedAt,
          updatedAt: completedAt,
        })
        .where(eq(runs.id, pending.id))
        .run()
      tx.insert(runEvents)
        .values({
          runId: pending.id,
          type: "run_updated",
          createdAt: completedAt,
        })
        .run()
    })
  }

  db.update(runs)
    .set({ status: "paused", updatedAt: new Date().toISOString() })
    .where(eq(runs.status, "running"))
    .run()
  db.update(runAgents)
    .set({ status: "paused", updatedAt: new Date().toISOString() })
    .where(inArray(runAgents.status, ["running", "idle"]))
    .run()

  for (const run of db
    .select({ id: runs.id, status: runs.status, summary: runs.summary })
    .from(runs)
    .where(inArray(runs.status, [...terminalRunStatuses]))
    .all()) {
    const completedAt = new Date().toISOString()
    db.transaction((tx) => {
      tx.update(runAgents)
        .set({
          status:
            run.status === "completed"
              ? "completed"
              : run.status === "failed"
                ? "failed"
                : "stopped",
          ...(run.status === "completed" ? { summary: run.summary } : {}),
          completedAt,
          updatedAt: completedAt,
        })
        .where(
          and(
            eq(runAgents.runId, run.id),
            isNull(runAgents.parentAgentId),
            inArray(runAgents.status, ["running", "idle", "paused"])
          )
        )
        .run()
      tx.update(runAgents)
        .set({ status: "stopped", completedAt, updatedAt: completedAt })
        .where(
          and(
            eq(runAgents.runId, run.id),
            isNotNull(runAgents.parentAgentId),
            inArray(runAgents.status, ["running", "idle", "paused"])
          )
        )
        .run()
    })
  }

  return staleContainerRuns
}
