import type { RunPublic, SolverSpec } from "@aegisx/shared"
import { get, modelAddress, type FlatSettings } from "@aegisx/shared"
import type { ProviderConnection } from "@aegisx/shared/domain"
import type { SchedulerStatusSnapshot } from "@aegisx/shared/scheduler"
import { and, eq, inArray } from "drizzle-orm"

import type { Database } from "../db"
import { challenges, runs, schedulerConfig } from "../db/schema"
import { RunActionError } from "./errors"
import { fenceSnapshot } from "./fence"
import type { ModelResolver } from "./model-resolver"
import type { RunQueries } from "./queries"
import type { CreateRunInput, RunContext } from "./run-factory"

export type SchedulerAdminDeps = {
  db: Database
  queries: RunQueries
  getSettings(): FlatSettings
  now(): string
  /** Enabled provider connections (the unresolvable-ref error's list). */
  providers(): ProviderConnection[]
  /** Model-ref resolution (the unresolvable-ref check). */
  modelResolver: ModelResolver
  /** Reusable per-run handles (to re-arm timers for live runs). */
  contexts: Map<string, RunContext>
  updateRun(runId: string, patch: Partial<typeof runs.$inferInsert>): void
  emitRun(runId: string): void
  requireRun(runId: string): RunPublic
  armRunTimers(runId: string, deadlineAt: string | null): void
  /** Fresh-run launch (run-factory's create). */
  create(input: CreateRunInput): Promise<RunPublic>
  /** Run-level stop (abort every streaming agent, container stays warm). */
  stop(runId: string): Promise<RunPublic>
  /** Run-level message (posts into the entry agent's DM + awaited delivery). */
  sendMessage(
    runId: string,
    input: { text: string; deliverAs?: "steer" | "followUp" }
  ): Promise<RunPublic>
}

export type SchedulerAdmin = ReturnType<typeof createSchedulerAdmin>

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
    getSettings,
    now,
    providers,
    modelResolver,
    contexts,
    updateRun,
    emitRun,
  } = deps

  /** All model refs addressable right now (enabled providers × enabled
   * models) — the unresolvable-ref error text. Derived from providers(); refs
   * are shown without the optional :effort suffix. */
  function availableModelRefs(): string[] {
    const refs: string[] = []
    for (const provider of providers()) {
      if (!provider.enabled || !provider.apiKey) continue
      for (const model of provider.models) {
        if (model.enabled) refs.push(modelAddress(provider, model))
      }
    }
    return refs
  }

  /** Reject an unresolvable model ref (enqueue/start) with an error listing
   * every currently-available ref so the model can correct itself. */
  function assertModelsResolvable(
    model: string | undefined,
    solvers: SolverSpec[] | undefined
  ): void {
    const refs = [
      ...(model ? [model] : []),
      ...(solvers ?? []).flatMap((spec) => (spec.model ? [spec.model] : [])),
    ]
    for (const ref of refs) {
      if (modelResolver.resolveModelTarget(ref)) continue
      throw new RunActionError(
        "invalid_state",
        `Model "${ref}" is not available. Available models: ${
          availableModelRefs().join(", ") || "(none)"
        }`
      )
    }
  }

  /** Map the v9 launch specs onto `CreateRunInput.solvers`: explicit
   * per-solver specs win; else N copies of the shared `model`; undefined when
   * everything is defaulted (create treats empty as one default solver). */
  function solverSpecsOf(input: {
    model?: string
    solverCount?: number
    solvers?: SolverSpec[]
  }): SolverSpec[] | undefined {
    if (input.solvers?.length) return input.solvers
    const count =
      input.solverCount && input.solverCount > 0 ? input.solverCount : 1
    if (count === 1 && !input.model) return undefined
    return Array.from({ length: count }, () =>
      input.model ? { model: input.model } : {}
    )
  }

  /** Resolve container settings and launch a challenge run (direct start:
   * scheduler start_run + queue drainer). v9 launch specs:
   * `solvers` wins; else `solverCount` × `model`; else the create defaults. */
  async function resolveAndCreate(input: {
    challengeId: string
    strategy?: string
    model?: string
    solverCount?: number
    solvers?: SolverSpec[]
    timeoutMs?: number | null
    source: "manual" | "scheduler"
    queueItemId?: string
  }): Promise<RunPublic> {
    const settings = getSettings()
    const solvers = solverSpecsOf(input)
    return deps.create({
      scopeType: "challenge",
      challengeId: input.challengeId,
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
      strategy: input.strategy,
      ...(solvers ? { solvers } : {}),
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

  /** Fence snapshot augmented with active run details (challenge names). */
  function getStatusSnapshot(eventId: string): SchedulerStatusSnapshot {
    const snap = fenceSnapshot(db, getSettings(), eventId)
    const active = db
      .select({
        id: runs.id,
        challengeId: runs.challengeId,
        status: runs.status,
      })
      .from(runs)
      .where(
        and(
          eq(runs.scopeType, "challenge"),
          inArray(runs.status, ["running", "idle"])
        )
      )
      .all()
    // One prefetch for all challenge names instead of a SELECT per run.
    const challengeIds = [
      ...new Set(
        active
          .map((row) => row.challengeId)
          .filter((id): id is string => id !== null)
      ),
    ]
    const names = new Map<string, string>()
    if (challengeIds.length > 0) {
      const rows = db
        .select({ id: challenges.id, name: challenges.name })
        .from(challenges)
        .where(inArray(challenges.id, challengeIds))
        .all()
      for (const row of rows) names.set(row.id, row.name)
    }
    const activeRuns = active.map((row) => ({
      id: row.id,
      challengeId: row.challengeId,
      challengeName: row.challengeId ? (names.get(row.challengeId) ?? "") : "",
      status: row.status,
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
   * when set, else the global default — resolved inside create().
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
    // any paused flag so the new run starts live. The orchestrator's model
    // resolves inside create(): scheduler_config.modelId → global default.
    setSchedulerPaused(eventId, false)
    const settings = getSettings()
    return deps.create({
      scopeType: "event",
      eventId,
      instruction: config.instruction,
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

  return {
    resolveAndCreate,
    assertModelsResolvable,
    setRunTimeout,
    getStatusSnapshot,
    getSchedulerRun,
    getSchedulerConfig,
    upsertSchedulerConfig,
    startScheduler,
    pauseScheduler,
    resumeScheduler,
    isSchedulerPaused,
  }
}
