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
      initialPromptOverride: input.prompt,
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

  /** Read the event's scheduler policy (defaults if unset). */
  function getSchedulerConfig(eventId: string): {
    eventId: string
    modelId: string | null
    instruction: string
    maxConcurrentTargets: number
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
    }
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

  /** Start (or replace) the event's scheduler run from its config. The
   * orchestrator's model is the per-event `scheduler_config.modelId` override
   * when set, else the global orchestration setting, else the global default —
   * resolved inside create() via the slot override. A fresh start replaces any
   * previous closed scheduler run (newSession semantics handled by create). */
  async function startScheduler(eventId: string): Promise<RunPublic> {
    const config = getSchedulerConfig(eventId)
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
    notifySchedulerOfFailure,
  }
}
