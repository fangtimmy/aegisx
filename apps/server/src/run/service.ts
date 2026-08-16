import type { Database as Sqlite } from "bun:sqlite"
import { rmSync } from "node:fs"
import { join } from "node:path"

import type { RunPublic, SwitchModelInput } from "@aegisx/shared"
import { formatModelRef, get } from "@aegisx/shared"
import type { ProviderConnection } from "@aegisx/shared/domain"
import { and, eq, inArray, ne, sql } from "drizzle-orm"

import { applyModelSwitch, type SwitchTarget } from "../agents/agent-ops"
import { createAgentHost } from "../agents/host"
import type { AgentLoopSettings } from "../agents/host-session"
import { chainLock, createSessionLifecycle } from "../agents/lifecycle"
import { createLiveBus, type LiveBus } from "../agents/live"
import type { Database } from "../db"
import { agents, runs } from "../db/schema"
import { createCatalogReader } from "../events/catalog"
import type { ConfigStore } from "../infrastructure/config-store"
import { EventScopeEmitter } from "../orchestration/event-scope"
import {
  DEFAULT_MAIN_SYSTEM_PROMPT_TEMPLATE,
  DEFAULT_ORCHESTRATOR_SYSTEM_PROMPT_TEMPLATE,
  LEGACY_MAIN_SYSTEM_PROMPT_TEMPLATE_V9,
  LEGACY_ORCHESTRATOR_SYSTEM_PROMPT_TEMPLATE_V9,
} from "../orchestration/prompt-defaults"
import {
  migrateLegacyPromptSettings,
  seedBuiltinTemplates,
  upgradeBuiltinTemplate,
} from "../orchestration/prompt-templates"
import {
  getChallengeRemote,
  isTargetCapable,
} from "../platforms/challenge-state"
import type { createPlatformService } from "../platforms/service"
import { getProviderConnections } from "../providers/public"
import { createAgentSessionOps } from "./agent-session-ops"
import type { ContainerManager } from "./container/container-manager"
import { createRunDeadlines, type RunDeadlines } from "./deadlines"
import { RunActionError } from "./errors"
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

  /** Model-ref resolution (default ref, run display fields), factored out of
   * the service (model-resolver.ts). */
  const modelResolver = createModelResolver({
    getSettings,
    providers,
    getAliases: () => configStore.getAliases(),
  })
  const queries = createRunQueries({
    db,
    dataDir,
    resolveModelDisplay: modelResolver.resolveModelDisplay,
  })
  const catalog = createCatalogReader(db, platformService)
  const bus: LiveBus = createLiveBus()

  // Seed the four built-in prompt templates (idempotent) so the service is
  // self-sufficient — any agent created here renders. Then carry pre-v8
  // FlatSettings prompt edits into the table: the prompt_templates table is
  // the single render source.
  seedBuiltinTemplates(db)
  migrateLegacyPromptSettings(db, configStore.getLegacyPromptTemplates())
  // One-time refresh of built-in rows still carrying the pre-v9 default
  // bodies: mainSystem lost the spawn section and gained the co-solver
  // section; orchestratorSystem lost the orchestration catalog and gained the
  // v9 tool surface. upgradeBuiltinTemplate only touches rows that exactly
  // equal the legacy body — user edits survive untouched.
  upgradeBuiltinTemplate(
    db,
    "mainSystem",
    LEGACY_MAIN_SYSTEM_PROMPT_TEMPLATE_V9,
    DEFAULT_MAIN_SYSTEM_PROMPT_TEMPLATE
  )
  upgradeBuiltinTemplate(
    db,
    "orchestratorSystem",
    LEGACY_ORCHESTRATOR_SYSTEM_PROMPT_TEMPLATE_V9,
    DEFAULT_ORCHESTRATOR_SYSTEM_PROMPT_TEMPLATE
  )
  // Idempotent guard for the WP2→WP3a window: re-delete any plugin-owned
  // template rows that might have been re-seeded in between.
  db.run(sql`DELETE FROM prompt_templates WHERE plugin != 'builtin'`)

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
  /** Per-event run-lifecycle emitters, owned by the event's scheduler run. */
  const eventScopes = new Map<string, EventScopeEmitter>()
  /** Scheduler task queue + drainer. Assigned after construction (it calls back
   * into the launch callback); read via closures (teardownRun, routes). */
  let queue: QueueService | undefined
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
   * Lock order: every fence critical section (create / restoreRunContext)
   * runs OUTSIDE any agent lock — no fence section ever acquires an agent
   * lock, so the order is acyclic (no deadlock). The former onTurnGate fence
   * hook is gone (W4): waking a warm idle run adds no container and no target
   * slot (its challenge is already counted), so fresh turns are never
   * capacity-rejected. The fence lives only at the two container-creating
   * points: create() and restoreRunContext(). */
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
    eventScopes,
    // W3: a paused scheduler's run-lifecycle events are dropped before they
    // reach the orchestrator (late-bound schedulerAdmin, read at call time).
    isSchedulerPaused: (eventId) => schedulerAdmin.isSchedulerPaused(eventId),
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
    // No onTurnGate (W4): waking a warm idle run adds no container and no
    // target slot — its challenge is already counted by the fence — so fresh
    // turns are never capacity-rejected. Fence enforcement lives only at the
    // two container-creating points (create / restoreRunContext);
    // agentTurnStart's status recompute below still maintains run status.
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

  // Per-run hard-deadline timers (deadlines.ts). Created before teardown (its
  // clearRunTimers is injected there); teardown is injected back via the let.
  const deadlines: RunDeadlines = createRunDeadlines({
    queries,
    lifecycle,
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
    contexts,
    queue: () => queue,
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
    stopTargetIfOrphaned,
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
      // W4.3: deleting the last live run on a target-capable challenge
      // orphans its platform target — stop it before the row is gone.
      stopTargetIfOrphaned(runId, row.challengeId)
      for (const agent of agents) {
        const session = lifecycle.get(agent.id)
        if (session?.session.isStreaming) {
          await session.session.abort().catch(() => undefined)
        }
      }
      teardown.clearForceKill(runId)
      deadlines.clearRunTimers(runId)
      await containerManager.remove(row.containerName).catch(() => undefined)
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

  /** W4.3: stop the challenge's platform target when a teardown orphans it —
   * the challenge is target-capable and no OTHER live (running/idle) run is
   * still attacking it. Fire-and-forget; errors swallowed. Only sanctioned
   * teardowns call this (close/finish/timeout via teardownRun, plus
   * deleteRun). */
  function stopTargetIfOrphaned(
    runId: string,
    challengeId: string | null
  ): void {
    if (!challengeId) return
    if (!isTargetCapable(getChallengeRemote(db, challengeId))) return
    const other = db
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(
          eq(runs.challengeId, challengeId),
          inArray(runs.status, ["running", "idle"]),
          ne(runs.id, runId)
        )
      )
      .get()
    if (other) return
    void platformService
      .targetAction(challengeId, "stop")
      .catch(() => undefined)
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
    pendingFinish.clear()
    finishFlagWarned.clear()
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
    providers,
    modelResolver,
    queries,
    bus,
    contexts,
    eventScopes,
    pendingFinish,
    finishFlagWarned,
    lifecycle,
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
    pauseScheduler: schedulerAdmin.pauseScheduler,
    resumeScheduler: schedulerAdmin.resumeScheduler,
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
