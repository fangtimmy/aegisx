import type { Database as Sqlite } from "bun:sqlite"

import { and, eq, inArray, sql } from "drizzle-orm"

import type { LiveBus } from "../agents/live"
import type { Database } from "../db"
import { agents, runs } from "../db/schema"
import type { EventScopePayload } from "../orchestration/types"
import { orchKey, type ChannelService } from "./channels"
import type { RunQueries } from "./queries"

export type RunStatusDeps = {
  db: Database
  /** Raw sqlite handle (rows-affected for the atomic finishing UPDATE). */
  sqlite: Sqlite
  queries: RunQueries
  bus: LiveBus
  /** Derived-key channel core — run lifecycle events post into orch. */
  channels: ChannelService
  /** Whether the event's scheduler is paused (W3): paused → the run-lifecycle
   * events are dropped before they reach the orchestrator. */
  isSchedulerPaused(eventId: string): boolean
  now(): string
  updateAgent(agentId: string, patch: Partial<typeof agents.$inferInsert>): void
  /** Agent turn settled (idle/failed): arms the stall watchdog for the run
   * (challenge-scope only — the watchdog gates scope itself). */
  onAgentSettled(agentId: string, runId: string): void
}

export type RunStatus = ReturnType<typeof createRunStatus>

/**
 * Run status + live-emit helpers. A run's status is SQL-derived from its
 * agents' statuses (running ↔ idle) plus sanctioned explicit `closed`
 * transitions; the emit helpers broadcast the run/agent snapshots and post
 * run lifecycle events as system messages into the event's orch channel
 * (v18 §五: events ARE messages — urgent per the §五 table).
 */
export function createRunStatus(deps: RunStatusDeps) {
  const { db, sqlite, queries, bus, channels, now, updateAgent } = deps

  function emitRun(runId: string) {
    const run = queries.get(runId)
    if (run) bus.emit(runId, { type: "run.updated", run })
  }

  function emitAgents(runId: string) {
    for (const agent of queries.listAgents(runId)) {
      bus.emit(runId, { type: "agent.updated", agent })
    }
  }

  /** Event display line (the orch message body). */
  function eventName(p: EventScopePayload): string {
    switch (p.type) {
      case "run.started":
        return p.source === "manual" ? "started(手动)" : "started"
      case "run.idle":
        return p.failed ? "idle(failed)" : "idle"
      case "run.flagAccepted":
        return "flagAccepted"
      case "run.finished":
        return "finished"
      case "run.timedOut":
        return `timedOut(${p.outcome})`
      case "run.resumed":
        return "resumed"
    }
  }

  /** Dispatch a run lifecycle event as an orch system message (§五). Only
   * challenge-scoped runs emit — the scheduler observes its child runs,
   * never itself. A paused scheduler (W3) is silent: events are dropped
   * here (the one-line gate before post). Urgent = timedOut only. The
   * payload carries the run's `source` (W5) so the scheduler can tell
   * manual runs apart. */
  function emitRunEvent(runId: string, payload: EventScopePayload): void {
    const run = queries.getRow(runId)
    if (run?.scopeType !== "challenge") return
    if (deps.isSchedulerPaused(run.eventId)) return
    channels.post({
      channelKey: orchKey(run.eventId),
      author: { type: "system" },
      body: eventName({
        ...payload,
        source: run.source as "manual" | "scheduler",
      }),
      meta: {
        runId,
        eventType: payload.type,
        source: run.source as "manual" | "scheduler",
      },
      urgent: payload.type === "run.timedOut",
    })
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
    deps.onAgentSettled(agentId, runId)
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
