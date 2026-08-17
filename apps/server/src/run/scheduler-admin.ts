import type { RunPublic, SolverSpec } from "@aegisx/shared"
import { get, modelAddress, type FlatSettings } from "@aegisx/shared"
import type { MessageListItem } from "@aegisx/shared/agent"
import type { ProviderConnection } from "@aegisx/shared/domain"
import { and, eq, inArray } from "drizzle-orm"

import type { Database } from "../db"
import { challenges, runs, schedulerConfig } from "../db/schema"
import type { createCatalogReader } from "../events/catalog"
import { RunActionError } from "./errors"
import { fenceSnapshot } from "./fence"
import type { ModelResolver } from "./model-resolver"
import type { RunQueries } from "./queries"
import type { QueueService } from "./queue"
import type { CreateRunInput, RunContext } from "./run-factory"
import type {
  RunSchedulerToolContext,
  RunReadResult,
  RunSummary,
  SchedulerStatusSnapshot,
} from "./scheduler-tools"

export type SchedulerAdminDeps = {
  db: Database
  queries: RunQueries
  catalog: ReturnType<typeof createCatalogReader>
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
  /** Dynamic solver expansion (run-factory's addAgent). */
  addAgent(
    runId: string,
    spec: {
      model?: string
      prompt: string
      promptMode?: "strategy" | "override"
    }
  ): Promise<RunPublic>
  stop(runId: string): Promise<RunPublic>
  sendMessage(
    runId: string,
    input: { text: string; deliverAs?: "steer" | "followUp" }
  ): Promise<RunPublic>
  /** Per-agent send (POST /api/agents/:agentId/message path). */
  sendAgentMessage(
    agentId: string,
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
    providers,
    modelResolver,
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
      enqueue: (input) => {
        // Fail fast at enqueue time: an unresolvable model ref would
        // otherwise surface only at (auto-)launch, as a failed queue item.
        assertModelsResolvable(input.model, input.solvers)
        return deps.queue()!.enqueue({
          ...input,
          eventId,
          source: "scheduler",
        })
      },
      listQueue: () => deps.queue()!.list(eventId),
      removeQueue: (itemId) => deps.queue()!.remove(itemId),
      clearQueue: () => deps.queue()!.clear(eventId),
      reorderQueue: (itemIds) => deps.queue()!.reorder(eventId, itemIds),
      startRun: async (input) => {
        assertModelsResolvable(input.model, input.solvers)
        const run = await resolveAndCreate({
          ...input,
          source: "scheduler",
        })
        return runSummary(run)
      },
      stopRun: async (id) => runSummary(await deps.stop(id)),
      messageRun: async (id, text, deliverAs) =>
        runSummary(await deps.sendMessage(id, { text, deliverAs })),
      closeRun: async (id) => runSummary(await deps.closeRun(id)),
      readRun: (id, opts) => readRun(id, opts),
      listRuns: (filter) =>
        queries.listRuns({ eventId, ...filter }).map(runSummary),
      setRunTimeout: (id, timeoutMs) =>
        runSummary(setRunTimeout(id, timeoutMs)),
      getStatus: () => getStatusSnapshot(eventId),
      listChallenges: () => catalog.listChallengesForEvent(eventId),
      getChallenge: (id) => catalog.getChallenge(id),
      listAgents: (id) => queries.listAgents(id),
      lastAssistantText: (id, targetId) => deps.lastAssistantText(id, targetId),
      addAgent: async (id, input) => runSummary(await deps.addAgent(id, input)),
      messageAgent: async (agentId, text, deliverAs) =>
        runSummary(await deps.sendAgentMessage(agentId, { text, deliverAs })),
    }
  }

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

  /** Character budget for read_run's recent-messages body. */
  const READ_RUN_CHAR_BUDGET = 20_000
  /** read_run's default message count. */
  const READ_RUN_DEFAULT_LAST_N = 10

  /** Read a run for the scheduler, parameterized to agent level:
   * status header (agent/run status numbers, deadline remaining, last
   * message time) + the target agent's last-n renderable message lines.
   * Defaults to the entry agent; `lastAssistant` is the fallback when the
   * agent has no renderable messages yet. */
  function readRun(
    runId: string,
    opts: { agentId?: string; lastN?: number } = {}
  ): RunReadResult {
    const run = queries.get(runId)
    if (!run) throw new RunActionError("not_found", "Run not found")
    const row = queries.getRow(runId)
    const agentRows = queries.listAgents(runId)
    const target = opts.agentId
      ? agentRows.find((a) => a.id === opts.agentId)
      : agentRows.find((a) => a.isEntry)
    if (!target) throw new RunActionError("not_found", "Agent not found")
    const lastN =
      opts.lastN && opts.lastN > 0 ? opts.lastN : READ_RUN_DEFAULT_LAST_N
    // Newest → oldest, capped by lastN lines + the total char budget; the
    // lines are returned oldest-first.
    const list = queries.listMessages(runId, { agentId: target.id })
    const messages: string[] = []
    let budget = READ_RUN_CHAR_BUDGET
    let lastMessageAt: string | null = null
    for (let index = list.items.length - 1; index >= 0; index -= 1) {
      const item = list.items[index]!
      if (item.entry.type === "message" && !lastMessageAt) {
        lastMessageAt = item.entry.timestamp
      }
      if (messages.length >= lastN || budget <= 0) continue
      const line = messageLine(item)
      if (!line) continue
      const capped = line.slice(0, budget)
      messages.unshift(capped)
      budget -= capped.length
    }
    return {
      run,
      agents: agentRows,
      agent: target,
      elapsedMs: Date.now() - Date.parse(run.createdAt),
      deadlineRemainingMs: row?.deadlineAt
        ? Date.parse(row.deadlineAt) - Date.now()
        : null,
      lastMessageAt,
      messages,
      lastAssistant: deps.lastAssistantText(runId, target.id),
    }
  }

  /** One read_run line for a session entry: assistant → text body (or its
   * tool calls), user → text body, toolResult → a one-line tool summary.
   * Non-message entries (compaction / branch summaries) and empty bodies
   * render null (they do not count toward lastN). */
  function messageLine(item: MessageListItem): string | null {
    const entry = item.entry
    if (entry.type !== "message") return null
    const message = entry.message
    if (message.role === "assistant") {
      const body = message.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n")
        .trim()
      if (body) return `[assistant] ${body}`
      const tools = message.content.flatMap((part) =>
        part.type === "toolCall" ? [part.name] : []
      )
      return tools.length
        ? `[assistant] (tool calls: ${tools.join(", ")})`
        : null
    }
    if (message.role === "user") {
      const body =
        typeof message.content === "string"
          ? message.content.trim()
          : message.content
              .flatMap((part) => (part.type === "text" ? [part.text] : []))
              .join("\n")
              .trim()
      return body ? `[user] ${body}` : null
    }
    if (message.role === "toolResult") {
      const body = message.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n")
        .trim()
      const head = body.split("\n").find((line) => line.trim()) ?? ""
      return `[tool ${message.toolName}] ${
        head ? head.slice(0, 200) : "(no output)"
      }${message.isError ? " (error)" : ""}`
    }
    return null
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
    buildSchedulerToolContext,
    resolveAndCreate,
    assertModelsResolvable,
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
  }
}
