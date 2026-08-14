import type { Database as Sqlite } from "bun:sqlite"
import { rmSync } from "node:fs"
import { join } from "node:path"

import type { RunPublic, SwitchModelInput } from "@aegisx/shared"
import { formatModelRef, get } from "@aegisx/shared"
import type { ProviderConnection } from "@aegisx/shared/domain"
import { eq } from "drizzle-orm"

import { applyModelSwitch, type SwitchTarget } from "../agents/agent-ops"
import { createAgentHost } from "../agents/host"
import type {
  AgentLoopSettings,
  HostAgentSession,
} from "../agents/host-session"
import { chainLock, createSessionLifecycle } from "../agents/lifecycle"
import { createLiveBus, type LiveBus } from "../agents/live"
import type { Database } from "../db"
import { agents, runs } from "../db/schema"
import { createCatalogReader } from "../events/catalog"
import type { ConfigStore } from "../infrastructure/config-store"
import { migrateLegacyPromptSettings } from "../orchestration/prompt-templates"
import { bootOrchestration } from "../orchestration/registry"
import { EventScopeEmitter, RunEmitter } from "../orchestration/run-handle"
import type { createPlatformService } from "../platforms/service"
import { getProviderConnections } from "../providers/public"
import { createAgentSessionOps } from "./agent-session-ops"
import { createChildAgentRuntime } from "./child-agents"
import type { ContainerManager } from "./container/container-manager"
import { createRunDeadlines, type RunDeadlines } from "./deadlines"
import { RunActionError } from "./errors"
import { checkLaunchFence } from "./fence"
import { createModelResolver } from "./model-resolver"
import { createRunQueries } from "./queries"
import { createQueueService, type QueueService } from "./queue"
import { createRunFactory, type RunFactory } from "./run-factory"
import type { RunContext } from "./run-factory"
import { createRunStatus, type RunStatus } from "./run-status"
import { createSchedulerAdmin, type SchedulerAdmin } from "./scheduler-admin"
import { createRunTeardown, type RunTeardown } from "./teardown"

type PlatformService = ReturnType<typeof createPlatformService>

export type { CreateRunInput } from "./run-factory"

const RUNS_SUBDIR = "runs"
/** Cap concurrent spawn children per run. */
const MAX_CHILDREN_PER_RUN = 1

export type RunServiceOptions = {
  db: Database
  /** Raw sqlite handle (rows-affected for the atomic finishing UPDATE). */
  sqlite: Sqlite
  dataDir: string
  containerManager: ContainerManager
  platformService: PlatformService
  configStore: ConfigStore
  getSettings(): import("@aegisx/shared").FlatSettings
  /** Test seam: override the host-session creation (default = createAgentHost). */
  createHost?: typeof createAgentHost
  /** Test seam: grace between deadline-abort and a forced SIGKILL. */
  timeoutGraceMs?: number
}

export type SendMessageInput = {
  text: string
  /** Only meaningful while the agent is streaming (steer/followUp). */
  deliverAs?: "steer" | "followUp"
}

export type RunService = ReturnType<typeof createRunService>

export function createRunService(options: RunServiceOptions) {
  const {
    db,
    sqlite,
    dataDir,
    containerManager,
    platformService,
    configStore,
  } = options
  const createHost = options.createHost ?? createAgentHost
  const getSettings = () => options.getSettings()

  function providers(): ProviderConnection[] {
    return getProviderConnections(configStore)
  }

  /** Model-ref resolution (default ref, slot models, run display fields),
   * factored out of the service (model-resolver.ts). */
  const modelResolver = createModelResolver({
    getSettings,
    providers,
    getAliases: () => configStore.getAliases(),
    getAgentModels: () => configStore.getAgentModels(),
  })
  const queries = createRunQueries({
    db,
    dataDir,
    resolveModelDisplay: modelResolver.resolveModelDisplay,
  })
  const catalog = createCatalogReader(db, platformService)
  const bus: LiveBus = createLiveBus()

  // Register built-in plugins + seed default prompt templates (idempotent) so
  // the service is self-sufficient — any RunHandle built here can render. Then
  // carry pre-v8 FlatSettings prompt edits into the table: the prompt_templates
  // table is the single render source.
  bootOrchestration(db)
  migrateLegacyPromptSettings(db, configStore.getLegacyPromptTemplates())

  /** Per-agent promise-chaining locks (the only concurrency mechanism). */
  const locks = new Map<string, Promise<unknown>>()
  /** Global fence lock: serializes fence check + slot reservation across all
   * launches (drainer / direct start / cold-restore) so the concurrency caps
   * hold under interleaving. One key — local single-user. */
  const fenceLocks = new Map<string, Promise<unknown>>()
  /** Finish winner per agent: the agent whose atomic finishing UPDATE hit. */
  const pendingFinish = new Map<string, { summary: string; runId: string }>()
  /** Runs finish_run already warned about a missing flag (once per run). */
  const finishFlagWarned = new Set<string>()
  /** Reusable per-run handles (entry snapshot lives on the agent row). */
  const contexts = new Map<string, RunContext>()
  /** Per-run plugin event emitters; close clears, setup rebuilds. */
  const emitters = new Map<string, RunEmitter>()
  /** Per-event run-lifecycle emitters, owned by the event's scheduler run. */
  const eventScopes = new Map<string, EventScopeEmitter>()
  /** Scheduler task queue + drainer. Assigned after construction (it calls back
   * into the launch callback); read via closures (teardownRun, routes). */
  let queue: QueueService | undefined
  /** Live spawn-child sessions, keyed by child agent id. */
  const childSessions = new Map<string, HostAgentSession>()
  let closed = false
  /** Monotonic timestamp: never returns the same value twice, so agents/runs
   * declared within one millisecond still get a strictly-ordered `createdAt`
   * (deterministic ordering by createdAt alone). */
  let lastNowMs = 0
  const now = () => {
    let ms = Date.now()
    if (ms <= lastNowMs) ms = lastNowMs + 1
    lastNowMs = ms
    return new Date(ms).toISOString()
  }

  function withLock<T>(agentId: string, op: () => T | Promise<T>): Promise<T> {
    if (closed) {
      return Promise.reject(
        new RunActionError("invalid_state", "Run service is closed")
      )
    }
    return chainLock(locks, agentId, op)
  }

  /** Global fence critical section. Serializes the fence check + slot
   * reservation so concurrent launches can't overshoot the caps. Holds only the
   * quick DB op (row insert / status flip); container builds and setup run
   * outside.
   *
   * Lock order (agent → fence): every fence critical section runs either
   * outside any agent lock (create / restoreRunContext) or inside one (the
   * onTurnGate hook — send() holds the target agent's lock). No fence section
   * ever acquires an agent lock, so the order is acyclic (no deadlock). */
  async function withFence<T>(op: () => T | Promise<T>): Promise<T> {
    return chainLock(fenceLocks, "global-fence", op)
  }

  const runDir = (runId: string) => join(dataDir, RUNS_SUBDIR, runId)
  const workspaceAbs = (runId: string) => join(runDir(runId), "workspace")
  const sessionsAbs = (runId: string) => join(runDir(runId), "sessions")
  const runtimeAbs = (runId: string) => join(runDir(runId), "agent-runtime")
  const containerName = (runId: string) => `aegisx-run-${runId}`

  function requireRun(runId: string) {
    const run = queries.get(runId)
    if (!run) throw new RunActionError("not_found", "Run not found")
    return run
  }

  function updateRun(runId: string, patch: Partial<typeof runs.$inferInsert>) {
    db.update(runs).set(patch).where(eq(runs.id, runId)).run()
  }

  function updateAgent(
    agentId: string,
    patch: Partial<typeof agents.$inferInsert>
  ) {
    db.update(agents).set(patch).where(eq(agents.id, agentId)).run()
  }

  function runIdOf(agentId: string): string | undefined {
    return db
      .select({ runId: agents.runId })
      .from(agents)
      .where(eq(agents.id, agentId))
      .get()?.runId
  }

  /** The run's entry agent (default conversation target). */
  function entryAgent(runId: string) {
    return queries.listAgents(runId).find((a) => a.isEntry)
  }

  // Run status + live emits (run-status.ts): SQL-derived run status, the
  // atomic finish claim, and the bus / event-scope emit helpers.
  const status: RunStatus = createRunStatus({
    db,
    sqlite,
    queries,
    bus,
    emitters,
    eventScopes,
    now,
    updateAgent,
  })

  // Late-bound module refs: the factories below reference each other (and the
  // lifecycle hooks reference them). None of the closures run during
  // construction — they are all assigned before the service is usable.
  let runFactory!: RunFactory
  let schedulerAdmin!: SchedulerAdmin
  let teardown!: RunTeardown

  // --- per-agent turn lifecycle (entry agent) ------------------------------

  const lifecycle = createSessionLifecycle({
    kind: "agent",
    withLock,
    onTurnStart(agentId) {
      const runId = runIdOf(agentId)
      if (runId) status.agentTurnStart(agentId, runId)
    },
    onTurnSettled(agentId, error) {
      const runId = runIdOf(agentId)
      if (!runId) return
      const pending = pendingFinish.get(agentId)
      if (pending && pending.runId === runId) {
        pendingFinish.delete(agentId)
        teardown.teardownRun(runId, {
          summary: pending.summary,
          finished: true,
        })
        return
      }
      status.agentTurnSettled(agentId, runId, error)
    },
    onBeforeNewTurn(agentId) {
      pendingFinish.delete(agentId)
    },
    /** Fresh-turn gate (fourth fence enforcement point): waking a warm idle
     * run starts a new compute round, so it must be admitted by the fence like
     * a fresh launch. Runs a quick fence check + status flip under the GLOBAL
     * fence while holding this agent's lock (agent → fence order, see
     * withFence). A capacity reject propagates out of send() as RunActionError
     * → HTTP 429 / tool result. steer/followUp (streaming branch) and drive()
     * (child result delivery / prime) skip this hook. */
    async onTurnGate(agentId) {
      const runId = runIdOf(agentId)
      if (!runId) return
      const row = queries.getRow(runId)
      if (!row || row.scopeType !== "challenge" || row.status !== "idle") {
        return
      }
      await withFence(async () => {
        const decision = checkLaunchFence(db, getSettings(), {
          scopeType: "challenge",
          eventId: row.eventId,
          challengeId: row.challengeId,
        })
        if (!decision.ok) throw new RunActionError("capacity", decision.message)
        // Atomic placeholder: same reservation semantics as create / restore.
        // If the gate throws, the run stays idle (no slot consumed). The
        // subsequent agentTurnStart's recompute maintains it as running.
        updateRun(runId, { status: "running", updatedAt: now() })
      })
    },
    async onResume(agentId) {
      const runId = runIdOf(agentId)
      if (runId) await runFactory.prepareAgent(runId, agentId)
    },
  })

  // --- providers / settings / tools ---------------------------------------

  function agentSettings(): AgentLoopSettings {
    const s = getSettings()
    return {
      compaction: { enabled: get(s, "agent.compactionEnabled") },
      retry: {
        enabled: get(s, "agent.retryEnabled"),
        maxRetries: get(s, "agent.retryMaxRetries"),
      },
    }
  }

  /** Hand a finished child's result text to its parent: steer into the current
   * turn if streaming, otherwise drive a fresh turn. */
  const deliverToParent = (
    runId: string,
    parentAgentId: string,
    text: string
  ): void => {
    const session = lifecycle.get(parentAgentId)
    if (!session) return
    if (session.session.isStreaming) {
      void session.session.steer(text).catch(() => undefined)
    } else {
      lifecycle.drive(parentAgentId, text)
    }
  }

  const childRuntime = createChildAgentRuntime({
    db,
    bus,
    containerManager,
    contexts,
    childSessions,
    maxChildrenPerRun: MAX_CHILDREN_PER_RUN,
    agentSettings,
    createHost: options.createHost,
    listAgents: queries.listAgents,
    updateAgent,
    emitRun: status.emitRun,
    emitAgents: status.emitAgents,
    deliverToParent,
    onChildTurnStart: (agentId, runId) => status.agentTurnStart(agentId, runId),
    onChildTurnSettled: (agentId, runId, error) =>
      status.agentTurnSettled(agentId, runId, error),
  })

  // Per-run hard-deadline timers (deadlines.ts). Created before teardown (its
  // clearRunTimers is injected there); teardown is injected back via the let.
  const deadlines: RunDeadlines = createRunDeadlines({
    queries,
    lifecycle,
    childSessions,
    updateRun,
    now,
    teardownRun: (runId) => teardown.teardownRun(runId),
    emitRunEvent: status.emitRunEvent,
    timeoutGraceMs: options.timeoutGraceMs,
  })

  // Container force-kill + sanctioned `closed` teardown (teardown.ts).
  teardown = createRunTeardown({
    containerManager,
    queries,
    bus,
    lifecycle,
    childSessions,
    contexts,
    childRuntime,
    queue: () => queue,
    emitters,
    eventScopes,
    finishFlagWarned,
    now,
    updateRun,
    updateAgent,
    containerName,
    clearRunTimers: deadlines.clearRunTimers,
    emitRun: status.emitRun,
    emitAgents: status.emitAgents,
    emitRunEvent: status.emitRunEvent,
  })

  // --- multi-session + flat backtrack (v12) --------------------------------
  // Sessions are per-agent conversation threads: exactly one is active
  // (agents.sessionFile), /new creates a fresh one, activate switches the
  // pointer (old sessions stay in the DB), backtrack truncates the active one
  // flat (no pi tree-branching — the abandoned tail is physically deleted).
  // All ops require an idle agent (a running turn is rejected, matching
  // /compact) and are rejected for spawn children (they run unattended).
  // Implemented in agent-session-ops.ts (injected deps; shared db/locks).
  const sessionOps = createAgentSessionOps({
    db,
    lifecycle,
    contexts,
    withLock,
    prepareAgent: (runId, agentId) => runFactory.prepareAgent(runId, agentId),
    runIdOf,
    updateAgent,
    emitAgents: status.emitAgents,
    requireRun,
    now,
  })

  // --- run facade (routes-facing) -----------------------------------------

  /** Run-level stop: abort every streaming agent (declared + children). Each
   * settles to idle; the container stays warm. lifecycle.abort serializes per
   * agent, so no outer lock is needed. */
  async function stop(runId: string): Promise<RunPublic> {
    for (const agentId of deadlines.streamingAgentIds(runId)) {
      await lifecycle.abort(agentId).catch(() => undefined)
    }
    return requireRun(runId)
  }

  /** Per-agent model switch (POST /api/agents/:agentId/model + the run-level
   * entry switch). Takes effect next turn; persists the snapshot on the agent
   * row. Serialized on the agent's lock against its turns. */
  function switchAgentModelById(
    agentId: string,
    input: SwitchModelInput
  ): Promise<RunPublic> {
    return withLock(agentId, async () => {
      const runId = runIdOf(agentId)
      if (!runId) throw new RunActionError("not_found", "Agent not found")
      const session = lifecycle.get(agentId)
      if (!session) {
        throw new RunActionError(
          "invalid_state",
          "Agent has no live session; start or reopen its run first"
        )
      }
      const agentRow = db
        .select({ model: agents.model })
        .from(agents)
        .where(eq(agents.id, agentId))
        .get()
      let target: SwitchTarget
      try {
        target = (
          await applyModelSwitch(
            session,
            providers(),
            configStore.getAliases(),
            input.model,
            agentRow?.model ?? null
          )
        ).target
      } catch (error) {
        throw new RunActionError(
          "invalid_state",
          error instanceof Error ? error.message : String(error)
        )
      }
      updateAgent(agentId, {
        model: formatModelRef(
          target.provider,
          target.model,
          target.thinkingLevel
        ),
        updatedAt: now(),
      })
      status.emitAgents(runId)
      return requireRun(runId)
    })
  }

  /** Run-level model switch (POST /api/runs/:runId/switch-model): the UI
   * switches the entry agent's model — delegate to the per-agent path. */
  function switchModel(
    runId: string,
    input: SwitchModelInput
  ): Promise<RunPublic> {
    const entry = entryAgent(runId)
    if (!entry) throw new RunActionError("not_found", "Run has no entry agent")
    return switchAgentModelById(entry.id, input)
  }

  /** Force-finish (HTTP /finish): the sanctioned closed transition — teardown
   * aborts every streaming agent and disposes all sessions. Idempotent; the
   * finish_run tool path (atomic finishing claim + settle-driven teardown)
   * is separate and already handles the multi-agent race. */
  async function finish(runId: string, summary: string): Promise<RunPublic> {
    const run = requireRun(runId)
    if (run.status === "closed") {
      throw new RunActionError("invalid_state", "Run is already closed")
    }
    teardown.teardownRun(runId, { summary, finished: true })
    return requireRun(runId)
  }

  async function sendMessage(
    runId: string,
    input: SendMessageInput
  ): Promise<RunPublic> {
    const entry = entryAgent(runId)
    if (!entry) throw new RunActionError("not_found", "Run has no entry agent")
    await lifecycle.send(entry.id, input.text, input.deliverAs)
    return requireRun(runId)
  }

  /** Per-agent send (POST /api/agents/:agentId/message). The target agent's run
   * is resolved from the agent row; a closed (cold) run goes through
   * lifecycle.send → onResume → prepareAgent (fence → restore → session), so
   * this single path covers warm + cold targets. */
  async function sendAgentMessage(
    agentId: string,
    input: SendMessageInput
  ): Promise<RunPublic> {
    const runId = runIdOf(agentId)
    if (!runId) throw new RunActionError("not_found", "Agent not found")
    await lifecycle.send(agentId, input.text, input.deliverAs)
    return requireRun(runId)
  }

  /** Per-agent model switch (POST /api/agents/:agentId/model). Unlike the
   * run-level switchModel (which always targets the entry agent), this switches
   * the named agent's own snapshot; takes effect next turn. */
  async function switchAgentModel(
    agentId: string,
    input: SwitchModelInput
  ): Promise<RunPublic> {
    return switchAgentModelById(agentId, input)
  }

  /** Per-agent stop (POST /api/agents/:agentId/stop): abort the agent's current
   * turn; it settles to idle (the run stays warm). */
  async function stopAgent(agentId: string): Promise<RunPublic> {
    const runId = runIdOf(agentId)
    if (!runId) throw new RunActionError("not_found", "Agent not found")
    await lifecycle.abort(agentId).catch(() => undefined)
    return requireRun(runId)
  }

  /** Manually compact an agent's context (pi SDK `session.compact()`). The
   * session must be live (prepared) and idle — compaction runs a model turn,
   * so it can't overlap a running turn. Summarizes the history in place; the
   * SSE pipeline emits a context snapshot so the UI updates. */
  async function compactAgent(agentId: string): Promise<RunPublic> {
    const runId = runIdOf(agentId)
    if (!runId) throw new RunActionError("not_found", "Agent not found")
    await withLock(agentId, async () => {
      const session = lifecycle.get(agentId)
      if (!session) {
        throw new RunActionError(
          "invalid_state",
          "Agent session is not active — send a message first"
        )
      }
      if (session.session.isStreaming) {
        throw new RunActionError(
          "invalid_state",
          "Cannot compact while a turn is running — stop it first"
        )
      }
      await session.session.compact()
    })
    return requireRun(runId)
  }

  /** Replace the entry agent's steer/followUp queue. Serialized on the entry
   * agent's lock against its turns; uses the SDK queue API directly. */
  function setQueue(
    runId: string,
    input: { steering: string[]; followUp: string[] }
  ): Promise<void> {
    const entry = entryAgent(runId)
    if (!entry) return Promise.resolve()
    return withLock(entry.id, async () => {
      const session = lifecycle.get(entry.id)
      if (!session) return
      session.session.clearQueue()
      for (const text of input.steering) {
        const trimmed = text.trim()
        if (trimmed) await session.session.steer(trimmed)
      }
      for (const text of input.followUp) {
        const trimmed = text.trim()
        if (trimmed) await session.session.followUp(trimmed)
      }
    })
  }

  /** Release a run's container + sessions (→ closed). The closed transition is
   * an atomic sanctioned UPDATE; a concurrently settling turn is a no-op once
   * closed (the aggregate SQL guards on status). */
  async function closeRun(runId: string): Promise<RunPublic> {
    const run = requireRun(runId)
    if (run.status === "closed") {
      throw new RunActionError("invalid_state", "Run is already closed")
    }
    teardown.teardownRun(runId)
    return requireRun(runId)
  }

  async function deleteRun(runId: string) {
    // Serialize against one agent's turns (direct session.abort below — not
    // lifecycle.abort — to avoid re-entering the same lock). Disposes every
    // live session, not just the entry's.
    const agents = queries.listAgents(runId)
    const lockKey = agents[0]?.id ?? runId
    await withLock(lockKey, async () => {
      const row = queries.getRow(runId)
      if (!row) throw new RunActionError("not_found", "Run not found")
      for (const agent of agents) {
        const session = lifecycle.get(agent.id)
        if (session?.session.isStreaming) {
          await session.session.abort().catch(() => undefined)
        }
      }
      teardown.clearForceKill(runId)
      deadlines.clearRunTimers(runId)
      await containerManager.remove(row.containerName).catch(() => undefined)
      childRuntime.abortAll(runId)
      for (const agent of agents) {
        const session = lifecycle.get(agent.id)
        if (session) {
          void session.dispose()
          lifecycle.delete(agent.id)
        }
        pendingFinish.delete(agent.id)
      }
      contexts.delete(runId)
      rmSync(runDir(runId), { recursive: true, force: true })
      db.delete(runs).where(eq(runs.id, runId)).run()
    })
  }

  async function close() {
    closed = true
    await Promise.allSettled(locks.values())
    locks.clear()
    for (const timer of teardown.forceKillTimers.values()) clearTimeout(timer)
    teardown.forceKillTimers.clear()
    for (const t of deadlines.timeoutTimers.values()) {
      if (t.deadline) clearTimeout(t.deadline)
      if (t.grace) clearTimeout(t.grace)
    }
    deadlines.timeoutTimers.clear()
    queue?.cancelDrain()
    await lifecycle.closeAll()
    for (const childSession of childSessions.values())
      await childSession.dispose()
    childSessions.clear()
    pendingFinish.clear()
    finishFlagWarned.clear()
    for (const emitter of emitters.values()) emitter.close()
    emitters.clear()
    for (const emitter of eventScopes.values()) emitter.close()
    eventScopes.clear()
    bus.close()
  }

  /** Platform-side hook: a flag was accepted for this run — notify the event's
   * scheduler (run.flagAccepted). Called by the app after the flag write;
   * `agentId` is unknown on the platform path, so it stays optional. */
  function notifyFlagAccepted(runId: string): void {
    status.emitRunEvent(runId, { type: "run.flagAccepted", runId })
  }

  // Fresh-create + cold-restore orchestration (run-factory.ts); scheduler
  // policy + run management (scheduler-admin.ts). The two reference each other
  // (prepareAgent → scheduler tools, scheduler start → create), resolved via
  // the lets above.
  runFactory = createRunFactory({
    db,
    dataDir,
    containerManager,
    platformService,
    configStore,
    providers,
    modelResolver,
    queries,
    bus,
    contexts,
    emitters,
    eventScopes,
    childSessions,
    pendingFinish,
    finishFlagWarned,
    lifecycle,
    childRuntime,
    withFence,
    getSettings,
    now,
    updateRun,
    updateAgent,
    requireRun,
    containerName,
    workspaceAbs,
    sessionsAbs,
    runtimeAbs,
    markFinishing: status.markFinishing,
    teardownRun: (runId, opts) => teardown.teardownRun(runId, opts),
    clearForceKill: (runId) => teardown.clearForceKill(runId),
    terminateContainer: (runId, name) =>
      teardown.terminateContainer(runId, name),
    armRunTimers: (runId, deadlineAt) =>
      deadlines.armRunTimers(runId, deadlineAt),
    emitRun: status.emitRun,
    emitAgents: status.emitAgents,
    emitRunEvent: status.emitRunEvent,
    agentSettings,
    createHost,
    buildSchedulerToolContext: (runId, agentId) =>
      schedulerAdmin.buildSchedulerToolContext(runId, agentId),
    getSchedulerConfig: (eventId) => schedulerAdmin.getSchedulerConfig(eventId),
    queue: () => queue,
  })

  schedulerAdmin = createSchedulerAdmin({
    db,
    queries,
    catalog,
    getSettings,
    now,
    contexts,
    updateRun,
    emitRun: status.emitRun,
    requireRun,
    armRunTimers: (runId, deadlineAt) =>
      deadlines.armRunTimers(runId, deadlineAt),
    create: (input) => runFactory.create(input),
    stop,
    sendMessage,
    closeRun,
    lastAssistantText: (runId, agentId) =>
      runFactory.lastAssistantText(runId, agentId),
    queue: () => queue,
  })

  // Construct the queue service now that resolveAndCreate + the failure
  // notifier exist. The drainer's launch callback builds the run from the
  // queue item's snapshot.
  queue = createQueueService({
    db,
    getSettings,
    isDisposed: () => closed,
    launch: async (item) => {
      const run = await schedulerAdmin.resolveAndCreate({
        challengeId: item.challengeId,
        orchestration: item.orchestration,
        prompt: item.prompt,
        timeoutMs: item.timeoutMs,
        source: item.source as "manual" | "scheduler",
        queueItemId: item.id,
      })
      return run.id
    },
    onLaunchFailed: (eventId, item, error) =>
      schedulerAdmin.notifySchedulerOfFailure(eventId, item, error),
  })

  return {
    create: runFactory.create,
    resolveAndCreate: schedulerAdmin.resolveAndCreate,
    stop,
    switchModel,
    finish,
    sendMessage,
    sendAgentMessage,
    switchAgentModel,
    stopAgent,
    compactAgent,
    setQueue,
    listAgentSessions: sessionOps.listAgentSessions,
    createAgentSession: sessionOps.createAgentSession,
    activateAgentSession: sessionOps.activateAgentSession,
    backtrackAgent: sessionOps.backtrackAgent,
    setRunTimeout: schedulerAdmin.setRunTimeout,
    closeRun,
    delete: deleteRun,
    readRun: schedulerAdmin.readRun,
    getStatus: schedulerAdmin.getStatusSnapshot,
    getSchedulerRun: schedulerAdmin.getSchedulerRun,
    getSchedulerConfig: schedulerAdmin.getSchedulerConfig,
    upsertSchedulerConfig: schedulerAdmin.upsertSchedulerConfig,
    startScheduler: schedulerAdmin.startScheduler,
    queue: () => queue!,
    refresh: queries.get,
    recoverOnBoot: runFactory.recoverOnBoot,
    close,
    listMessages: queries.listMessages,
    listRuns: queries.listRuns,
    get: queries.get,
    detail: queries.detail,
    listForEvent: queries.listForEvent,
    usageForEvent: queries.usageForEvent,
    listAgents: queries.listAgents,
    workspacePath: queries.workspacePath,
    runDirPath: queries.runDirPath,
    bus,
    notifyFlagAccepted,
    submitFlag: platformService.submitFlag,
    targetAction: platformService.targetAction,
    /** Test seam: the atomic finish claim. Exposed so tests can verify the
     * closed-run guard directly; no route reaches it. */
    markFinishing: status.markFinishing,
  }
}
