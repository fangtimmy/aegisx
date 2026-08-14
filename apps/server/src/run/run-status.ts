import type { Database as Sqlite } from "bun:sqlite"

import { and, eq, inArray, sql } from "drizzle-orm"

import type { LiveBus } from "../agents/live"
import type { Database } from "../db"
import { agents, runs } from "../db/schema"
import type { EventScopeEmitter } from "../orchestration/run-handle"
import type { RunEmitter } from "../orchestration/run-handle"
import type { EventScopePayload } from "../orchestration/types"
import type { RunQueries } from "./queries"

export type RunStatusDeps = {
  db: Database
  /** Raw sqlite handle (rows-affected for the atomic finishing UPDATE). */
  sqlite: Sqlite
  queries: RunQueries
  bus: LiveBus
  /** Per-run plugin event emitters; the settle hook notifies the plugin. */
  emitters: Map<string, RunEmitter>
  /** Per-event run-lifecycle emitters (scheduler observation). */
  eventScopes: Map<string, EventScopeEmitter>
  /** Whether the event's scheduler is paused (W3): paused → the run-lifecycle
   * events are dropped before they reach the orchestrator. */
  isSchedulerPaused(eventId: string): boolean
  now(): string
  updateAgent(agentId: string, patch: Partial<typeof agents.$inferInsert>): void
}

export type RunStatus = ReturnType<typeof createRunStatus>

/**
 * Run status + live-emit helpers. A run's status is SQL-derived from its
 * agents' statuses (running ↔ idle) plus sanctioned explicit `closed`
 * transitions; the emit helpers broadcast the run/agent snapshots and dispatch
 * run lifecycle events to the event's scheduler.
 */
export function createRunStatus(deps: RunStatusDeps) {
  const { db, sqlite, queries, bus, emitters, eventScopes, now, updateAgent } =
    deps

  function emitRun(runId: string) {
    const run = queries.get(runId)
    if (run) bus.emit(runId, { type: "run.updated", run })
  }

  function emitAgents(runId: string) {
    for (const agent of queries.listAgents(runId)) {
      bus.emit(runId, { type: "agent.updated", agent })
    }
  }

  /** Dispatch a run lifecycle event to its event's scheduler. Only
   * challenge-scoped runs emit — the scheduler observes its child runs, never
   * itself (an event-scoped run's own turns don't re-notify it). The payload
   * carries the run's `source` (W5) so the scheduler can tell manual runs
   * apart. A paused scheduler (W3) is silent: events are dropped here (no
   * memory buildup) — it re-syncs on resume. */
  function emitRunEvent(runId: string, payload: EventScopePayload): void {
    const run = queries.getRow(runId)
    if (run?.scopeType !== "challenge") return
    if (deps.isSchedulerPaused(run.eventId)) return
    eventScopes
      .get(run.eventId)
      ?.emit({ ...payload, source: run.source as "manual" | "scheduler" })
  }

  /** Recompute a run's status from its agents' statuses. No-op once the run is
   * closed or finishing (the aggregate guards). Replaces direct status writes. */
  function recomputeRunStatus(runId: string): void {
    db.update(runs)
      .set({
        status: sql`CASE WHEN EXISTS(SELECT 1 FROM ${agents} WHERE ${agents.runId} = ${runId} AND ${agents.status} = 'running') THEN 'running' ELSE 'idle' END`,
        updatedAt: now(),
      })
      .where(
        and(
          eq(runs.id, runId),
          inArray(runs.status, ["running", "idle"]),
          eq(runs.finishing, false)
        )
      )
      .run()
  }

  /** Atomically claim the finish for a run. Returns true for the one agent whose
   * UPDATE hit (rows-affected = 1); that agent tears the run down. Guarded on
   * status: a closed run (already torn down) can never be claimed again — a
   * late finish_run must not double-teardown. */
  function markFinishing(runId: string): boolean {
    const res = sqlite.run(
      `UPDATE runs SET finishing = 1 WHERE id = ? AND finishing = 0 AND status IN ('running', 'idle')`,
      [runId]
    )
    return res.changes > 0
  }

  /** Mark an agent's turn starting and rederive the run status. */
  function agentTurnStart(agentId: string, runId: string): void {
    const ts = now()
    updateAgent(agentId, { status: "running", error: null, updatedAt: ts })
    recomputeRunStatus(runId)
    emitRun(runId)
    emitAgents(runId)
  }

  /** Mark an agent's turn settled and rederive the run status. `error` (already
   * logged by the lifecycle core) sends the agent to `failed`. The last settle
   * flips the run to idle — notify the event's scheduler. */
  function agentTurnSettled(
    agentId: string,
    runId: string,
    error: string | null
  ): void {
    const ts = now()
    updateAgent(agentId, {
      status: error ? "failed" : "idle",
      ...(error ? { error } : {}),
      updatedAt: ts,
    })
    recomputeRunStatus(runId)
    const run = queries.getRow(runId)
    if (run?.status === "idle") {
      // A failed settle flips the run idle too — mark the event so the
      // scheduler can tell a healthy pause from a dead solver (it reads the
      // failed agent's error via read_run).
      const failed = db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.runId, runId), eq(agents.status, "failed")))
        .get()
      emitRunEvent(runId, {
        type: "run.idle",
        runId,
        failed: Boolean(failed),
      })
    }
    emitRun(runId)
    emitAgents(runId)
    emitters
      .get(runId)
      ?.emit(agentId, { type: "turnEnded", ...(error ? { error } : {}) })
  }

  return {
    emitRun,
    emitAgents,
    emitRunEvent,
    recomputeRunStatus,
    markFinishing,
    agentTurnStart,
    agentTurnSettled,
  }
}
