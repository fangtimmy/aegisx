import type { RunPublic } from "@aegisx/shared"
import { get, type FlatSettings } from "@aegisx/shared"
import type { AgentSummary } from "@aegisx/shared/agent"
import { and, eq, inArray } from "drizzle-orm"

import type { Database } from "../db"
import { challenges, runs, schedulerConfig } from "../db/schema"
import type { createCatalogReader } from "../events/catalog"
import { RunActionError } from "./errors"
import { fenceSnapshot } from "./fence"
import type { RunQueries } from "./queries"
import type { QueueService } from "./queue"
import type { CreateRunInput, RunContext } from "./run-factory"
import type {
  RunSchedulerToolContext,
  RunSummary,
  SchedulerStatusSnapshot,
} from "./scheduler-tools"

export type SchedulerAdminDeps = {
  db: Database
  queries: RunQueries
  catalog: ReturnType<typeof createCatalogReader>
  getSettings(): FlatSettings
  now(): string
  /** Reusable per-run handles (to re-arm timers for live runs). */
  contexts: Map<string, RunContext>
  updateRun(runId: string, patch: Partial<typeof runs.$inferInsert>): void
  emitRun(runId: string): void
  requireRun(runId: string): RunPublic
  armRunTimers(runId: string, deadlineAt: string | null): void
  /** Fresh-run launch (run-factory's create). */
  create(input: CreateRunInput): Promise<RunPublic>
  stop(runId: string): Promise<RunPublic>
  sendMessage(
    runId: string,
    input: { text: string; deliverAs?: "steer" | "followUp" }
  ): Promise<RunPublic>
  closeRun(runId: string): Promise<RunPublic>
  lastAssistantText(runId: string, agentId: string): string | null
  /** Scheduler task queue (assigned after construction; read via getter). */
  queue: () => QueueService | undefined
}

export type SchedulerAdmin = ReturnType<typeof createSchedulerAdmin>

/** Compact run summary for the scheduler's read-only tools (list_runs /
 * start_run / ...): enough to identify a run + its outcome without the full
 * flag/usage payload. */
function runSummary(run: RunPublic): RunSummary {
  return {
    id: run.id,
    scopeType: run.scopeType,
    eventId: run.eventId,
    challengeId: run.challengeId,
    challengeName: run.challengeName,
    orchestration: run.orchestration,
    status: run.status,
    source: run.source,
    modelId: run.modelId,
    modelName: run.modelName,
    summary: run.summary,
    error: run.error,
    hasAcceptedFlag: run.hasAcceptedFlag,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
  }
}

/**
 * Scheduler policy + run-management API surface (what the event-scope
 * orchestrator agent and the HTTP routes call). The orchestrator manages the
 * queue + sibling challenge runs in its event; every function here is a pure
 * read/write over the service's shared state, wired by the service.
 */
export function createSchedulerAdmin(deps: SchedulerAdminDeps) {
  const {
    db,
    queries,
    catalog,
    getSettings,
    now,
    contexts,
    updateRun,
    emitRun,
  } = deps

  /** Build the scheduler-tool context for the event-scope orchestrator agent.
   * The orchestrator manages the queue + sibling challenge runs in its event. */
  function buildSchedulerToolContext(
    runId: string,
    agentId: string
  ): RunSchedulerToolContext {
    const row = queries.getRow(runId)
    const eventId = row?.eventId ?? ""
    return {
      runId,
      eventId,
      agentId,
      enqueue: (input) =>
        deps.queue()!.enqueue({
          ...input,
          orchestration: input.orchestration ?? "classic",
          eventId,
          source: "scheduler",
        }),
      listQueue: () => deps.queue()!.list(eventId),
      removeQueue: (itemId) => deps.queue()!.remove(itemId),
      clearQueue: () => deps.queue()!.clear(eventId),
      reorderQueue: (itemIds) => deps.queue()!.reorder(eventId, itemIds),
      startRun: async (input) => {
        const run = await resolveAndCreate({
          ...input,
          orchestration: input.orchestration ?? "classic",
          source: "scheduler",
        })
        return runSummary(run)
      },
      stopRun: async (id) => runSummary(await deps.stop(id)),
      messageRun: async (id, text, deliverAs) =>
        runSummary(await deps.sendMessage(id, { text, deliverAs })),
      closeRun: async (id) => runSummary(await deps.closeRun(id)),
      readRun: (id) => readRun(id),
      listRuns: (filter) =>
        queries.listRuns({ eventId, ...filter }).map(runSummary),
      setRunTimeout: (id, timeoutMs) =>
        runSummary(setRunTimeout(id, timeoutMs)),
      getStatus: () => getStatusSnapshot(eventId),
      listChallenges: () => catalog.listChallengesForEvent(eventId),
      getChallenge: (id) => catalog.getChallenge(id),
      listAgents: (id) => queries.listAgents(id),
      lastAssistantText: (id, targetId) => deps.lastAssistantText(id, targetId),
    }
  }

  /** Resolve container settings and launch a challenge run (direct start:
   * scheduler start_run + queue drainer). Per-agent models come from the
   * orchestration settings (computed inside create()). */
  async function resolveAndCreate(input: {
    challengeId: string
    orchestration: string
    prompt?: string
    timeoutMs?: number | null
    source: "manual" | "scheduler"
    queueItemId?: string
  }): Promise<RunPublic> {
    const settings = getSettings()
    return deps.create({
      scopeType: "challenge",
      challengeId: input.challengeId,
      orchestration: input.orchestration,
      container: {
        image: get(settings, "container.image"),
        cpus: get(settings, "container.cpus"),
        memoryMb: get(settings, "container.memoryMb"),
        pidsLimit: get(settings, "container.pidsLimit"),
        tmpfsSize: get(settings, "container.tmpfsSize"),
        workspace: get(settings, "container.workspace"),
      },
      source: input.source,
      timeoutMs: input.timeoutMs ?? undefined,
      queueItemId: input.queueItemId,
      strategy: input.prompt,
    })
  }

  /** Set / extend / shorten a run's hard deadline. Persists the new deadline +
   * re-arms the timer for live (warm) runs; cold runs pick it up on restore.
   * Usable on closed runs (pre-sets the deadline for the next resume). */
  function setRunTimeout(runId: string, timeoutMs: number): RunPublic {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new RunActionError("invalid_state", "timeoutMs must be positive")
    }
    const deadlineAt = new Date(Date.now() + timeoutMs).toISOString()
    updateRun(runId, { timeoutMs, deadlineAt, updatedAt: now() })
    if (contexts.has(runId)) deps.armRunTimers(runId, deadlineAt)
    emitRun(runId)
    return deps.requireRun(runId)
  }

  /** Read a run for the scheduler: run + agents + the entry agent's latest
   * assistant text (reasoning/progress at a glance). */
  function readRun(runId: string): {
    run: RunPublic
    agents: AgentSummary[]
    entryAgentId: string | null
    lastAssistant: string | null
  } {
    const run = queries.get(runId)
    if (!run) throw new RunActionError("not_found", "Run not found")
    const agentRows = queries.listAgents(runId)
    const entry = agentRows.find((a) => a.isEntry)
    return {
      run,
      agents: agentRows,
      entryAgentId: entry?.id ?? null,
      lastAssistant: entry ? deps.lastAssistantText(runId, entry.id) : null,
    }
  }

  /** Fence snapshot augmented with active run details (challenge names). */
  function getStatusSnapshot(eventId: string): SchedulerStatusSnapshot {
    const snap = fenceSnapshot(db, getSettings(), eventId)
    const active = db
      .select({
        id: runs.id,
        challengeId: runs.challengeId,
        status: runs.status,
        orchestration: runs.orchestration,
      })
      .from(runs)
      .where(
        and(
          eq(runs.scopeType, "challenge"),
          inArray(runs.status, ["running", "idle"])
        )
      )
      .all()
    const activeRuns = active.map((row) => ({
      id: row.id,
      challengeId: row.challengeId,
      challengeName:
        db
          .select({ name: challenges.name })
          .from(challenges)
          .where(eq(challenges.id, row.challengeId ?? ""))
          .get()?.name ?? "",
      status: row.status,
      orchestration: row.orchestration,
    }))
    return { ...snap, activeRuns }
  }

  /** The event's scheduler (event-scoped) run, if any. */
  function getSchedulerRun(eventId: string): RunPublic | undefined {
    const row = db
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.scopeType, "event"), eq(runs.eventId, eventId)))
      .get()
    return row ? queries.get(row.id) : undefined
  }

  /** Read the event's scheduler policy (defaults if unset). `paused` gates
   * the event's run-lifecycle events (W3). */
  function getSchedulerConfig(eventId: string): {
    eventId: string
    modelId: string | null
    instruction: string
    maxConcurrentTargets: number
    paused: boolean
  } {
    const row = db
      .select()
      .from(schedulerConfig)
      .where(eq(schedulerConfig.eventId, eventId))
      .get()
    return {
      eventId,
      modelId: row?.modelId ?? null,
      instruction: row?.instruction ?? "",
      maxConcurrentTargets: row?.maxConcurrentTargets ?? 1,
      paused: row?.paused ?? false,
    }
  }

  /** Write the paused flag (upsert — also creates a default config row).
   * Writable with no scheduler run, so pause/resume can preset the next start. */
  function setSchedulerPaused(eventId: string, paused: boolean): void {
    const ts = now()
    const existing = db
      .select()
      .from(schedulerConfig)
      .where(eq(schedulerConfig.eventId, eventId))
      .get()
    if (existing) {
      db.update(schedulerConfig)
        .set({ paused, updatedAt: ts })
        .where(eq(schedulerConfig.eventId, eventId))
        .run()
    } else {
      db.insert(schedulerConfig)
        .values({
          eventId,
          modelId: null,
          instruction: "",
          maxConcurrentTargets: 1,
          paused,
          createdAt: ts,
          updatedAt: ts,
        })
        .run()
    }
  }

  /** Whether the event's scheduler is paused (the run-status emit gate). */
  function isSchedulerPaused(eventId: string): boolean {
    const row = db
      .select({ paused: schedulerConfig.paused })
      .from(schedulerConfig)
      .where(eq(schedulerConfig.eventId, eventId))
      .get()
    return row?.paused ?? false
  }

  /** Upsert the event's scheduler policy (creates with defaults if missing). */
  function upsertSchedulerConfig(patch: {
    eventId: string
    modelId?: string | null
    instruction?: string
    maxConcurrentTargets?: number
  }) {
    const ts = now()
    const existing = db
      .select()
      .from(schedulerConfig)
      .where(eq(schedulerConfig.eventId, patch.eventId))
      .get()
    if (existing) {
      const update: Partial<typeof schedulerConfig.$inferInsert> = {
        updatedAt: ts,
      }
      if (patch.modelId !== undefined) update.modelId = patch.modelId
      if (patch.instruction !== undefined)
        update.instruction = patch.instruction
      if (patch.maxConcurrentTargets !== undefined) {
        update.maxConcurrentTargets = patch.maxConcurrentTargets
      }
      db.update(schedulerConfig)
        .set(update)
        .where(eq(schedulerConfig.eventId, patch.eventId))
        .run()
    } else {
      db.insert(schedulerConfig)
        .values({
          eventId: patch.eventId,
          modelId: patch.modelId ?? null,
          instruction: patch.instruction ?? "",
          maxConcurrentTargets: patch.maxConcurrentTargets ?? 1,
          createdAt: ts,
          updatedAt: ts,
        })
        .run()
    }
    return getSchedulerConfig(patch.eventId)
  }

  /** Wake text sent on resume / cold-restore so the orchestrator re-syncs. */
  const SCHEDULER_RESUME_MESSAGE =
    "调度已恢复。请重新同步状态（get_status / list_runs / read_run）后再行动。"

  /** Disable the scheduler (W3): set paused=1 (event gate drops its
   * run-lifecycle notifications) + abort the current turn (container stays
   * warm). The flag is written even with no scheduler run — presets the next
   * start. */
  async function pauseScheduler(eventId: string): Promise<RunPublic | null> {
    setSchedulerPaused(eventId, true)
    const sched = getSchedulerRun(eventId)
    if (sched && sched.status !== "closed") {
      await deps.stop(sched.id)
      return deps.requireRun(sched.id)
    }
    return null
  }

  /** Re-enable the scheduler (W3): set paused=0 + tell the orchestrator to
   * re-sync before acting. No-op messaging when the run is absent/closed
   * (the flag is still written). */
  async function resumeScheduler(eventId: string): Promise<RunPublic | null> {
    setSchedulerPaused(eventId, false)
    const sched = getSchedulerRun(eventId)
    if (sched && sched.status !== "closed") {
      await deps.sendMessage(sched.id, { text: SCHEDULER_RESUME_MESSAGE })
      return deps.requireRun(sched.id)
    }
    return null
  }

  /** Start (or restart) the event's scheduler run from its config. The
   * orchestrator's model is the per-event `scheduler_config.modelId` override
   * when set, else the global orchestration setting, else the global default —
   * resolved inside create() via the slot override.
   *
   * W3.2 (start = restore):
   *  - live run (running/idle): paused → resume (un-pause + wake); else error.
   *  - closed run: cold-restore — wake the entry agent (onResume →
   *    prepareAgent → restoreRunContext), rebuilding the container + wiring
   *    while keeping the session/memory. `reset: true` deletes the closed row
   *    (cascade agents/sessions) and creates fresh.
   *  - no run: fresh create (also clears paused). */
  async function startScheduler(
    eventId: string,
    opts: { reset?: boolean } = {}
  ): Promise<RunPublic> {
    const config = getSchedulerConfig(eventId)
    const existing = getSchedulerRun(eventId)
    if (
      existing &&
      (existing.status === "running" || existing.status === "idle")
    ) {
      if (config.paused) {
        await resumeScheduler(eventId)
        return deps.requireRun(existing.id)
      }
      throw new RunActionError(
        "invalid_state",
        "A scheduler run is already active for this event"
      )
    }
    if (existing && existing.status === "closed" && !opts.reset) {
      // Cold-restore keeps memory — wake the orchestrator (onResume →
      // prepareAgent → restoreRunContext: container + wiring rebuilt, session
      // kept). Same mechanism as messaging a closed run.
      setSchedulerPaused(eventId, false)
      await deps.sendMessage(existing.id, { text: SCHEDULER_RESUME_MESSAGE })
      return deps.requireRun(existing.id)
    }
    // Fresh create (reset=true on a closed run, or no run at all) also clears
    // any paused flag so the new run starts live.
    setSchedulerPaused(eventId, false)
    const settings = getSettings()
    return deps.create({
      scopeType: "event",
      eventId,
      instruction: config.instruction,
      orchestration: "scheduler",
      slotModelOverrides: config.modelId
        ? { orchestrator: config.modelId }
        : undefined,
      container: {
        image: get(settings, "container.image"),
        cpus: get(settings, "container.cpus"),
        memoryMb: get(settings, "container.memoryMb"),
        pidsLimit: get(settings, "container.pidsLimit"),
        tmpfsSize: get(settings, "container.tmpfsSize"),
        workspace: get(settings, "container.workspace"),
      },
      source: "manual",
    })
  }

  /** Notify the event's scheduler orchestrator that a queued launch failed
   * (avoid a pending death-loop). No-op if no live scheduler run. */
  function notifySchedulerOfFailure(
    eventId: string,
    item: { id: string; challengeId: string; orchestration: string },
    error: string
  ): void {
    const sched = getSchedulerRun(eventId)
    if (!sched || sched.status === "closed") return
    const text =
      `Queue item ${item.id} (challenge ${item.challengeId}, ` +
      `${item.orchestration}) failed to launch: ${error}. ` +
      `Marked failed — remove_queue to clear or enqueue_run to retry.`
    void deps.sendMessage(sched.id, { text }).catch(() => undefined)
  }

  return {
    buildSchedulerToolContext,
    resolveAndCreate,
    setRunTimeout,
    readRun,
    getStatusSnapshot,
    getSchedulerRun,
    getSchedulerConfig,
    upsertSchedulerConfig,
    startScheduler,
    pauseScheduler,
    resumeScheduler,
    isSchedulerPaused,
    notifySchedulerOfFailure,
  }
}
