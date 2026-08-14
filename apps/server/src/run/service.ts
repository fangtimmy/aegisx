import type { Database as Sqlite } from "bun:sqlite"
import { mkdirSync, rmSync } from "node:fs"
import { join, relative } from "node:path"

import type {
  EnvironmentConfig,
  ModelRef,
  RunPublic,
  SwitchModelInput,
} from "@aegisx/shared"
import { formatModelRef, get } from "@aegisx/shared"
import type { AgentSummary } from "@aegisx/shared/agent"
import type { ProviderConnection } from "@aegisx/shared/provider"
import type { ThinkingLevel } from "@aegisx/shared/thinking"
import type { Api, Model } from "@earendil-works/pi-ai"
import { and, eq, inArray, sql } from "drizzle-orm"

import { applyModelSwitch, type SwitchTarget } from "../agents/agent-ops"
import { createAgentHost } from "../agents/host"
import type {
  AgentLoopSettings,
  HostAgentSession,
} from "../agents/host-session"
import { chainLock, createSessionLifecycle } from "../agents/lifecycle"
import { createLiveBus, type LiveBus } from "../agents/live"
import type { Database } from "../db"
import {
  agents,
  challengeFlags,
  challenges,
  events,
  runs,
  schedulerConfig,
} from "../db/schema"
import { createCatalogReader } from "../events/catalog"
import type { ConfigStore } from "../infrastructure/config-store"
import {
  loadTemplateMap,
  migrateLegacyPromptSettings,
  renderTemplate,
} from "../orchestration/prompt-templates-store"
import {
  bootOrchestration,
  challengeOrchestrationCatalog,
  requirePlugin,
} from "../orchestration/registry"
import {
  createRunHandle,
  EventScopeEmitter,
  type FreshAgentInput,
  RunEmitter,
  type RunHandleHost,
} from "../orchestration/run-handle"
import type {
  EventHandle,
  EventScopePayload,
  OrchestrationPlugin,
  PromptContext,
} from "../orchestration/types"
import { getChallengeRemote } from "../platforms/challenge-state"
import type { createPlatformService } from "../platforms/service"
import { getProviderConnections } from "../providers/public"
import { createAgentSessionOps } from "./agent-session-ops"
import { createChildAgentRuntime } from "./child-agents"
import type { ContainerManager } from "./container/container-manager"
import { createToolboxContainer } from "./container/container-manager"
import { RunActionError, RunStartError } from "./errors"
import { checkLaunchFence, fenceSnapshot } from "./fence"
import { createModelResolver } from "./model-resolver"
import {
  createRunModelRuntime,
  type RunModelRuntime,
  resolveRunModel,
} from "./model-runtime"
import {
  buildEventPromptContext,
  buildPromptContext,
  copyAttachments,
} from "./prompt"
import { createRunQueries } from "./queries"
import { createQueueService, type QueueService } from "./queue"
import {
  createSchedulerTools,
  type RunSchedulerToolContext,
} from "./scheduler-tools"
import { createMainTools, type RunToolContext } from "./tools"

type PlatformService = ReturnType<typeof createPlatformService>

const RUNS_SUBDIR = "runs"
/** Cap concurrent spawn children per run (code constant; spec §4.5e). */
const MAX_CHILDREN_PER_RUN = 1
/** Grace between deadline-abort and a forced SIGKILL (spec §8.3). */
const TIMEOUT_GRACE_MS = 30_000
/** Grace between SIGTERM and a forced SIGKILL on container teardown. */
const FORCE_KILL_GRACE_MS = 10_000

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
  /** Test seam: grace between deadline-abort and a forced SIGKILL (spec §8.3). */
  timeoutGraceMs?: number
}

/** Reusable per-run handles for spawn children (model runtime, container, the
 * child prompt template). Declared agents carry their own snapshot. */
export type RunContext = {
  containerName: string
  workspaceHostPath: string
  containerWorkspace: string
  sessionsDir: string
  modelRuntime: RunModelRuntime
  sdkModel: Model<Api> | undefined
  /** Run default model ref (the entry agent's concrete ref) — spawn children
   * resolve + snapshot it at spawn time. */
  defaultModelRef: ModelRef
  thinkingLevel: ThinkingLevel
  childTemplate: string
  promptContext: PromptContext
  challengeId: string
}

export type CreateRunInput = {
  /** Orchestration plugin id (challenge runs default to 'classic'). */
  orchestration?: string
  /** Per-slot model overrides (highest precedence), keyed by slot id. Used by
   * the scheduler to apply a per-event model override on top of the global
   * orchestration setting. */
  slotModelOverrides?: Record<string, ModelRef>
  container: {
    image: string
    cpus: number
    memoryMb: number
    pidsLimit: number
    tmpfsSize: string
    workspace: string
  }
  /** Who started this run. Defaults to 'manual'. */
  source?: "manual" | "scheduler"
  /** Per-run hard deadline (ms). Defaults to scheduler.defaultRunTimeoutMs. */
  timeoutMs?: number
  /** Back-filled when the scheduler drainer launches this run from the queue;
   * stamped on the run row to guard the run→queue done transition. */
  queueItemId?: string
  /** Overrides the rendered `initial` template as the run's first prompt. Set
   * by the queue (queue.prompt) or the scheduler's start_run; omitted → render
   * the default `initial` template. */
  initialPromptOverride?: string
} & (
  | { scopeType: "challenge"; challengeId: string }
  | { scopeType: "event"; eventId: string; instruction: string }
)

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

  function providers(): ProviderConnection[] {
    return getProviderConnections(configStore)
  }

  /** Model-ref resolution (default ref, slot models, run display fields),
   * factored out of the service (model-resolver.ts). */
  const modelResolver = createModelResolver({
    getSettings: () => options.getSettings(),
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
  // carry pre-v8 FlatSettings prompt edits into the table (spec §3.6): the
  // prompt_templates table is the single render source.
  bootOrchestration(db)
  migrateLegacyPromptSettings(db, configStore.getLegacyPromptTemplates())

  /** Per-agent promise-chaining locks (the only concurrency mechanism; spec §4.5). */
  const locks = new Map<string, Promise<unknown>>()
  /** Global fence lock: serializes fence check + slot reservation across all
   *  launches (drainer / direct start / cold-restore) so the concurrency caps
   *  hold under interleaving (spec §8.2). One key — local single-user. */
  const fenceLocks = new Map<string, Promise<unknown>>()
  /** Finish winner per agent: the agent whose atomic finishing UPDATE hit. */
  const pendingFinish = new Map<string, { summary: string; runId: string }>()
  /** Runs finish_run already warned about a missing flag (once per run). */
  const finishFlagWarned = new Set<string>()
  const forceKillTimers = new Map<string, NodeJS.Timeout>()
  /** Per-run hard-deadline timers. */
  const timeoutTimers = new Map<
    string,
    { deadline?: NodeJS.Timeout; grace?: NodeJS.Timeout }
  >()
  /** Reusable per-run handles (entry snapshot lives on the agent row). */
  const contexts = new Map<string, RunContext>()
  /** Per-run plugin event emitters (spec §3.5); close clears, setup rebuilds. */
  const emitters = new Map<string, RunEmitter>()
  /** Per-event run-lifecycle emitters (spec §3.5 EventHandle), owned by the
   * event's scheduler run. Created lazily at scheduler setup; cleared on its
   * close (a fresh scheduler run rebuilds a fresh emitter). */
  const eventScopes = new Map<string, EventScopeEmitter>()
  /** Scheduler task queue + drainer. Assigned after construction (it calls back
   * into {@link launchQueued}); read via closures (teardownRun, routes). */
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

  /** Global fence critical section (spec §8.2). Serializes the fence check +
   * slot reservation so concurrent launches can't overshoot the caps. Holds
   * only the quick DB op (row insert / status flip); container builds and
   * setup run outside.
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

  function emitRun(runId: string) {
    const run = queries.get(runId)
    if (run) bus.emit(runId, { type: "run.updated", run })
  }

  function emitAgents(runId: string) {
    for (const agent of queries.listAgents(runId)) {
      bus.emit(runId, { type: "agent.updated", agent })
    }
  }

  /** Dispatch a run lifecycle event to its event's scheduler (spec §3.5). Only
   * challenge-scoped runs emit — the scheduler observes its child runs, never
   * itself (an event-scoped run's own turns don't re-notify it). */
  function emitRunEvent(runId: string, payload: EventScopePayload): void {
    const run = queries.getRow(runId)
    if (run?.scopeType !== "challenge") return
    eventScopes.get(run.eventId)?.emit(payload)
  }

  // --- run status: SQL-derived (spec §4.5b) --------------------------------

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
   * UPDATE hit (rows-affected = 1); that agent tears the run down (spec §4.4).
   * Guarded on status: a closed run (already torn down) can never be claimed
   * again — a late finish_run must not double-teardown. */
  function markFinishing(runId: string): boolean {
    const res = sqlite.run(
      `UPDATE runs SET finishing = 1 WHERE id = ? AND finishing = 0 AND status IN ('running', 'idle')`,
      [runId]
    )
    return res.changes > 0
  }

  /** Mark an agent's turn starting and rederive the run status (spec §4.5b). */
  function agentTurnStart(agentId: string, runId: string): void {
    const ts = now()
    updateAgent(agentId, { status: "running", error: null, updatedAt: ts })
    recomputeRunStatus(runId)
    emitRun(runId)
    emitAgents(runId)
  }

  /** Mark an agent's turn settled and rederive the run status. `error` (already
   * logged by the lifecycle core) sends the agent to `failed`. The last settle
   * flips the run to idle — notify the event's scheduler (spec §3.5). */
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

  // --- per-agent turn lifecycle (entry agent) ------------------------------

  const lifecycle = createSessionLifecycle({
    kind: "agent",
    withLock,
    onTurnStart(agentId) {
      const runId = runIdOf(agentId)
      if (runId) agentTurnStart(agentId, runId)
    },
    onTurnSettled(agentId, error) {
      const runId = runIdOf(agentId)
      if (!runId) return
      const pending = pendingFinish.get(agentId)
      if (pending && pending.runId === runId) {
        pendingFinish.delete(agentId)
        teardownRun(runId, { summary: pending.summary, finished: true })
        return
      }
      agentTurnSettled(agentId, runId, error)
    },
    onBeforeNewTurn(agentId) {
      pendingFinish.delete(agentId)
    },
    /** Fresh-turn gate (spec §8.2, fourth fence enforcement point): waking a
     * warm idle run starts a new compute round, so it must be admitted by the
     * fence like a fresh launch. Runs a quick fence check + status flip under
     * the GLOBAL fence while holding this agent's lock (agent → fence order,
     * see withFence). A capacity reject propagates out of send() as
     * RunActionError → HTTP 429 / tool result. steer/followUp (streaming
     * branch) and drive() (child result delivery / prime) skip this hook. */
    async onTurnGate(agentId) {
      const runId = runIdOf(agentId)
      if (!runId) return
      const row = queries.getRow(runId)
      if (!row || row.scopeType !== "challenge" || row.status !== "idle") {
        return
      }
      await withFence(async () => {
        const decision = checkLaunchFence(db, options.getSettings(), {
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
      if (runId) await prepareAgent(runId, agentId)
    },
  })

  // --- container teardown --------------------------------------------------

  function clearForceKill(runId: string) {
    const timer = forceKillTimers.get(runId)
    if (timer) {
      clearTimeout(timer)
      forceKillTimers.delete(runId)
    }
  }

  function terminateContainer(runId: string, name: string) {
    clearForceKill(runId)
    void containerManager.kill(name, "SIGTERM").catch(() => undefined)
    const timer = setTimeout(() => {
      forceKillTimers.delete(runId)
      void containerManager
        .isRunning(name)
        .then((running) =>
          running
            ? containerManager.kill(name, "SIGKILL").catch(() => undefined)
            : undefined
        )
        .catch(() => undefined)
    }, FORCE_KILL_GRACE_MS)
    forceKillTimers.set(runId, timer)
  }

  /** Sanctioned `closed` transition (spec §4.1/§4.5d): stamp the row, then
   * release live resources outside the lock. Aborts every still-streaming
   * agent (per-agent locks; in-flight docker exec is dropped by dispose),
   * disposes ALL live agent sessions (not just the entry), and keeps the DB
   * sessions + agent rows so the run is cold-restorable. */
  function teardownRun(
    runId: string,
    opts: { summary?: string; finished?: boolean } = {}
  ) {
    const ts = now()
    const agents = queries.listAgents(runId)
    // Best-effort abort of anything still streaming, so no turn keeps running
    // against a dying run (their settles become no-ops once sessions are gone).
    for (const agent of agents) {
      if (agent.status !== "running") continue
      void lifecycle
        .get(agent.id)
        ?.session.abort()
        .catch(() => undefined)
      void childSessions
        .get(agent.id)
        ?.session.abort()
        .catch(() => undefined)
    }
    const patch: Partial<typeof runs.$inferInsert> = {
      status: "closed",
      updatedAt: ts,
    }
    if (opts.summary !== undefined) patch.summary = opts.summary
    if (opts.finished) patch.completedAt = ts
    updateRun(runId, patch)
    // Any still-running agent lands on `idle` (its live session is gone).
    finishFlagWarned.delete(runId)
    for (const agent of agents) {
      if (agent.status === "running") {
        updateAgent(agent.id, { status: "idle", updatedAt: ts })
      }
    }
    clearRunTimers(runId)
    terminateContainer(runId, containerName(runId))
    childRuntime.abortAll(runId)
    emitters.get(runId)?.close()
    emitters.delete(runId)
    // A closed scheduler run stops receiving child-run events; the emitter is
    // dropped and rebuilt fresh by the next scheduler start (spec §4.2).
    const row = queries.getRow(runId)
    if (row?.scopeType === "event") {
      eventScopes.get(row.eventId)?.close()
      eventScopes.delete(row.eventId)
    }
    // Dispose every live agent session, then drop the run-level context.
    for (const agent of agents) {
      const session = lifecycle.get(agent.id)
      if (session) {
        void session.dispose()
        lifecycle.delete(agent.id)
      }
    }
    contexts.delete(runId)
    // Closed run: drop its replay snapshots (channel lastRun + every agent's
    // context/queue/activity/running-tools) so long-lived memory stays flat.
    // A cold-restored run rebuilds them from the first post-resume events.
    bus.forget(
      runId,
      agents.map((agent) => agent.id)
    )
    emitRun(runId)
    emitAgents(runId)
    if (opts.finished) emitRunEvent(runId, { type: "run.finished", runId })
    // A queue-sourced run closing/finishing transitions its item to done
    // (guarded by id + runId, spec §8.1); freeing a slot re-drains the queue.
    queue?.markDone(row?.queueItemId, runId)
    queue?.scheduleDrain()
  }

  // --- timeout (spec §8.3: deadline → abort → grace → idle|closed) ---------

  function clearRunTimers(runId: string): void {
    const t = timeoutTimers.get(runId)
    if (t?.deadline) clearTimeout(t.deadline)
    if (t?.grace) clearTimeout(t.grace)
    timeoutTimers.delete(runId)
  }

  /** Every agent (declared + spawn children) with an in-flight turn. */
  function streamingAgentIds(runId: string): string[] {
    const ids: string[] = []
    for (const agent of queries.listAgents(runId)) {
      if (lifecycle.get(agent.id)?.session.isStreaming) ids.push(agent.id)
      else if (childSessions.get(agent.id)?.session.isStreaming) {
        ids.push(agent.id)
      }
    }
    return ids
  }

  /** Arm a run's hard-deadline timer. At expiry every streaming agent is
   * aborted; if all settle within the grace the run stays `idle` (warm), else
   * the container is SIGKILLed and the run goes `closed`. The outcome is
   * reported to the event's scheduler (`run.timedOut`). Idempotent. */
  function armRunTimers(runId: string, deadlineAt: string | null): void {
    clearRunTimers(runId)
    if (!deadlineAt) return
    const delay = Math.max(new Date(deadlineAt).getTime() - Date.now(), 0)
    const entry: { deadline?: NodeJS.Timeout; grace?: NodeJS.Timeout } = {}
    entry.deadline = setTimeout(() => {
      for (const agentId of streamingAgentIds(runId)) {
        const child = childSessions.get(agentId)
        if (child) void child.session.abort().catch(() => undefined)
        else void lifecycle.abort(agentId).catch(() => undefined)
      }
      updateRun(runId, { lastTimeoutAt: now() })
      entry.grace = setTimeout(() => {
        // Still streaming after grace → SIGKILL the container → closed.
        const stillStreaming = streamingAgentIds(runId).length > 0
        if (stillStreaming) teardownRun(runId)
        emitRunEvent(runId, {
          type: "run.timedOut",
          runId,
          outcome: stillStreaming ? "closed" : "idle",
        })
      }, options.timeoutGraceMs ?? TIMEOUT_GRACE_MS)
    }, delay)
    timeoutTimers.set(runId, entry)
  }

  // --- providers / settings / tools ---------------------------------------

  function agentSettings(): AgentLoopSettings {
    const s = options.getSettings()
    return {
      compaction: { enabled: get(s, "agent.compactionEnabled") },
      retry: {
        enabled: get(s, "agent.retryEnabled"),
        maxRetries: get(s, "agent.retryMaxRetries"),
      },
    }
  }

  /** Build the per-agent native tool context (spec §5 tool wiring). Peer tools
   * resolve within this run only; message_agent refuses spawn children (they
   * run unattended to completion). */
  function buildAgentToolContext(
    runId: string,
    challengeId: string,
    agentId: string
  ): RunToolContext {
    return {
      runId,
      challengeId,
      agentId,
      submitFlag: (flag, verifyRemote = true) =>
        platformService
          .submitFlag(runId, challengeId, flag, verifyRemote)
          .then((r) => r ?? null),
      targetAction: (action) =>
        platformService.targetAction(challengeId, action),
      /** Atomic finish claim (spec §4.4). Only the agent whose UPDATE hits
       * schedules a teardown (at its turn settle). */
      requestFinish: (summary) => {
        if (markFinishing(runId)) {
          pendingFinish.set(agentId, { summary, runId })
        }
      },
      hasAcceptedFlag: () =>
        Boolean(
          db
            .select({ id: challengeFlags.id })
            .from(challengeFlags)
            .where(
              and(
                eq(challengeFlags.runId, runId),
                eq(challengeFlags.status, "accepted")
              )
            )
            .get()
        ),
      finishFlagWarned: () => finishFlagWarned.has(runId),
      markFinishFlagWarned: () => {
        finishFlagWarned.add(runId)
      },
      spawnChild: (childInput) =>
        childRuntime.spawn(runId, agentId, childInput),
      messageAgent: async (targetId, text) => {
        const target = queries.listAgents(runId).find((a) => a.id === targetId)
        if (!target) return { ok: false, error: "Agent not found in this run" }
        if (target.parentAgentId) {
          return {
            ok: false,
            error: "Child agents run unattended and cannot receive messages",
          }
        }
        await lifecycle.send(targetId, text)
        return { ok: true }
      },
      getAgent: (id) => queries.listAgents(runId).find((a) => a.id === id),
      listAgents: () => queries.listAgents(runId),
      lastAssistantText: (id) => lastAssistantText(runId, id),
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
    emitRun,
    emitAgents,
    deliverToParent,
    onChildTurnStart: (agentId, runId) => agentTurnStart(agentId, runId),
    onChildTurnSettled: (agentId, runId, error) =>
      agentTurnSettled(agentId, runId, error),
  })

  // --- create --------------------------------------------------------------

  /** The EventHandle for an event's scheduler run (spec §3.4/§3.5): subscribes
   * to the per-event run-lifecycle emitter (created lazily). */
  function eventHandleFor(eventId: string): EventHandle {
    let emitter = eventScopes.get(eventId)
    if (!emitter) {
      emitter = new EventScopeEmitter()
      eventScopes.set(eventId, emitter)
    }
    return {
      on: (event, cb) => emitter!.on(event, cb),
    }
  }

  async function create(input: CreateRunInput): Promise<RunPublic> {
    const plugin = requirePlugin(input.orchestration ?? "classic")
    if (plugin.scope !== input.scopeType) {
      throw new RunActionError(
        "invalid_state",
        `Plugin '${plugin.id}' is ${plugin.scope}-scoped, not ${input.scopeType}`
      )
    }

    const challenge =
      input.scopeType === "challenge"
        ? db
            .select()
            .from(challenges)
            .where(eq(challenges.id, input.challengeId))
            .get()
        : undefined
    if (input.scopeType === "challenge" && !challenge) {
      throw new RunActionError("not_found", "Challenge not found")
    }
    const event =
      input.scopeType === "event"
        ? db.select().from(events).where(eq(events.id, input.eventId)).get()
        : undefined
    if (input.scopeType === "event" && !event) {
      throw new RunActionError("not_found", "Event not found")
    }
    // Scheduler runs are never cold-restored and there is at most one per
    // event: a fresh start replaces any previous closed row (newSession
    // semantics, spec §4.2) but never steps on a live one.
    if (input.scopeType === "event") {
      const existing = db
        .select()
        .from(runs)
        .where(and(eq(runs.eventId, event!.id), eq(runs.scopeType, "event")))
        .get()
      if (existing) {
        if (existing.status === "closed") {
          await containerManager
            .remove(containerName(existing.id))
            .catch(() => undefined)
          db.delete(runs).where(eq(runs.id, existing.id)).run()
        } else {
          throw new RunActionError(
            "invalid_state",
            "A scheduler run is already active for this event"
          )
        }
      }
    }

    // The run default model = the entry agent's configured model (the
    // conversation target the UI shows / switches; spawn children fall back to
    // it). Resolved from the orchestration settings, falling back to the global
    // default; snapshotted as a CONCRETE ref (aliases resolved away, spec §4.3).
    const entrySlot =
      plugin.agents.find((agent) => agent.entry) ?? plugin.agents[0]
    if (!entrySlot) {
      throw new RunActionError(
        "invalid_state",
        `Plugin '${plugin.id}' declares no agents`
      )
    }
    const entryConfigured =
      input.slotModelOverrides?.[entrySlot.slot] ??
      configStore.getAgentModels()[plugin.id]?.[entrySlot.slot] ??
      modelResolver.defaultModelRef()
    const entryTarget = modelResolver.resolveModelTarget(entryConfigured)
    if (!entryTarget) {
      throw new RunActionError(
        "invalid_state",
        entryConfigured
          ? `Configured model "${entryConfigured}" is unavailable`
          : "No enabled default model is configured"
      )
    }
    if (!entryTarget.provider.apiKey) {
      throw new RunActionError("invalid_state", "Provider API key is required")
    }
    const entryModelRef = formatModelRef(
      entryTarget.provider,
      entryTarget.model,
      entryTarget.thinkingLevel
    )

    const runId = crypto.randomUUID()
    const runSource = input.source ?? "manual"
    const runTimeoutMs =
      input.timeoutMs ??
      get(options.getSettings(), "scheduler.defaultRunTimeoutMs")
    const deadlineAtIso = new Date(Date.now() + runTimeoutMs).toISOString()
    const name = containerName(runId)
    const wsAbs = workspaceAbs(runId)
    const sessAbs = sessionsAbs(runId)
    const rtAbs = runtimeAbs(runId)
    mkdirSync(wsAbs, { recursive: true })
    mkdirSync(sessAbs, { recursive: true })
    mkdirSync(rtAbs, { recursive: true })

    const env: EnvironmentConfig = {
      type: "container",
      image: input.container.image,
      cpus: input.container.cpus,
      memoryMb: input.container.memoryMb,
      pidsLimit: input.container.pidsLimit,
    }
    const modelConfig = {
      provider: entryTarget.provider.label,
      modelId: entryTarget.model.modelId,
      modelLabel: entryTarget.model.label,
      thinkingLevel: entryTarget.thinkingLevel,
    }

    const promptContext =
      input.scopeType === "challenge"
        ? buildPromptContext(
            {
              runId,
              challenge: challenge!,
              remote: getChallengeRemote(db, challenge!.id),
              challengeAttachments: copyAttachments(
                db,
                dataDir,
                challenge!.id,
                wsAbs
              ),
              environment: env,
              model: modelConfig,
            },
            db,
            input.container.workspace
          )
        : buildEventPromptContext(
            {
              runId,
              eventId: event!.id,
              instruction: input.instruction,
              environment: env,
              model: modelConfig,
              orchestrations: challengeOrchestrationCatalog(),
            },
            db,
            input.container.workspace
          )

    const modelRuntime = await createRunModelRuntime({
      runtimeDir: rtAbs,
      providers: providers(),
    })
    const sdkModel = resolveRunModel(
      modelRuntime,
      entryTarget.provider,
      entryTarget.model.id
    )
    if (!sdkModel)
      throw new RunStartError("Could not resolve the selected model")

    // Reserve the concurrency slot + persist the run row atomically under the
    // global fence (spec §8.2). Challenge-scope launches are checked against
    // the caps; scheduler (event-scope) runs neither count nor consume slots.
    const ts = now()
    await withFence(async () => {
      if (input.scopeType === "challenge") {
        const decision = checkLaunchFence(db, options.getSettings(), {
          scopeType: "challenge",
          eventId: challenge!.eventId,
          challengeId: challenge!.id,
        })
        if (!decision.ok) {
          throw new RunActionError("capacity", decision.message)
        }
      }
      db.insert(runs)
        .values({
          id: runId,
          scopeType: input.scopeType,
          eventId:
            input.scopeType === "challenge" ? challenge!.eventId : event!.id,
          challengeId: challenge?.id ?? null,
          orchestration: plugin.id,
          params: "{}",
          status: "running",
          model: entryModelRef,
          image: env.image,
          cpus: env.cpus,
          memoryMb: env.memoryMb,
          pidsLimit: env.pidsLimit,
          containerName: name,
          workspacePath: relative(dataDir, wsAbs),
          sessionDir: relative(dataDir, sessAbs),
          source: runSource,
          timeoutMs: runTimeoutMs,
          deadlineAt: deadlineAtIso,
          queueItemId: input.queueItemId ?? null,
          createdAt: ts,
          startedAt: ts,
          updatedAt: ts,
        })
        .run()
    })

    // Build the container outside the fence lock (slow I/O). On failure drop
    // the reserved row so the slot is freed, then surface a launch error.
    try {
      await createToolboxContainer(containerManager, {
        name,
        image: env.image,
        workspace: input.container.workspace,
        hostWorkspace: wsAbs,
        cpus: env.cpus,
        memoryMb: env.memoryMb,
        pidsLimit: env.pidsLimit,
        tmpfsSize: input.container.tmpfsSize,
        networkMode: get(options.getSettings(), "container.networkMode"),
      })
    } catch (error) {
      db.delete(runs).where(eq(runs.id, runId)).run()
      throw new RunActionError(
        "launch_failed",
        error instanceof Error ? error.message : String(error)
      )
    }

    // Run-level live context + plugin wiring: contexts.set + emitter + handle
    // + setup are the same code create and cold-restore run (spec §4.2) — see
    // buildRunContext. The run row + container exist before setup runs (spec
    // §4.2); agents are declared by the plugin's setup.
    const handle = await buildRunContext({
      runId,
      scope: input.scopeType,
      eventId: input.scopeType === "challenge" ? challenge!.eventId : event!.id,
      challengeId: challenge?.id ?? null,
      orchestration: plugin.id,
      containerName: name,
      containerWorkspace: input.container.workspace,
      wsAbs,
      modelRuntime,
      sdkModel,
      defaultModelRef: entryModelRef,
      thinkingLevel: entryTarget.thinkingLevel,
      promptContext,
      slotOverrides: input.slotModelOverrides,
      initialPromptOverride: input.initialPromptOverride,
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      teardownRun(runId)
      updateRun(runId, {
        error: `Plugin setup failed: ${message}`,
        updatedAt: now(),
      })
      throw new RunActionError("launch_failed", message)
    })

    // System auto-prime (spec §4.2): for a fresh run, prepare()+send(prime) each
    // prime agent. classic primes the solver with run.initialPrompt.
    try {
      for (const spec of handle.primeSpecs) {
        await prepareAgent(runId, spec.agentId)
        await lifecycle.send(spec.agentId, spec.prime)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      for (const spec of handle.primeSpecs) {
        updateAgent(spec.agentId, {
          status: "failed",
          error: message,
          completedAt: now(),
          updatedAt: now(),
        })
      }
      teardownRun(runId)
      updateRun(runId, {
        error: `Failed to start agent: ${message}`,
        updatedAt: now(),
      })
      throw new RunActionError("launch_failed", message)
    }

    emitRun(runId)
    emitAgents(runId)
    armRunTimers(runId, deadlineAtIso)
    emitRunEvent(runId, { type: "run.started", runId })
    return requireRun(runId)
  }

  /** Run-level stop: abort every streaming agent (declared + children). Each
   * settles to idle; the container stays warm. lifecycle.abort serializes per
   * agent, so no outer lock is needed. */
  async function stop(runId: string): Promise<RunPublic> {
    for (const agentId of streamingAgentIds(runId)) {
      await lifecycle.abort(agentId).catch(() => undefined)
    }
    return requireRun(runId)
  }

  /** Per-agent model switch on the entry agent (run-level UI = entry). Takes
   * effect next turn; persists the snapshot on the agent row. Serialized on the
   * entry agent's lock against its turns. */
  /** Per-agent model switch (spec §10: POST /api/agents/:agentId/model + the
   * run-level entry switch). Takes effect next turn; persists the snapshot on
   * the agent row. Serialized on the agent's lock against its turns. */
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
      emitAgents(runId)
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
    teardownRun(runId, { summary, finished: true })
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

  /** Per-agent send (spec §10: POST /api/agents/:agentId/message). The target
   * agent's run is resolved from the agent row; a closed (cold) run goes
   * through lifecycle.send → onResume → prepareAgent (fence → restore →
   * session), so this single path covers warm + cold targets. */
  async function sendAgentMessage(
    agentId: string,
    input: SendMessageInput
  ): Promise<RunPublic> {
    const runId = runIdOf(agentId)
    if (!runId) throw new RunActionError("not_found", "Agent not found")
    await lifecycle.send(agentId, input.text, input.deliverAs)
    return requireRun(runId)
  }

  /** Per-agent model switch (spec §10: POST /api/agents/:agentId/model).
   * Unlike the run-level switchModel (which always targets the entry agent),
   * this switches the named agent's own snapshot; takes effect next turn. */
  async function switchAgentModel(
    agentId: string,
    input: SwitchModelInput
  ): Promise<RunPublic> {
    return switchAgentModelById(agentId, input)
  }

  /** Per-agent stop (spec §10: POST /api/agents/:agentId/stop): abort the
   * agent's current turn; it settles to idle (the run stays warm). */
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
    prepareAgent,
    runIdOf,
    updateAgent,
    emitAgents,
    requireRun,
    now,
  })

  /** Release a run's container + sessions (→ closed). The closed transition is
   * an atomic sanctioned UPDATE (spec §4.5d); a concurrently settling turn is
   * a no-op once closed (the aggregate SQL guards on status). */
  async function closeRun(runId: string): Promise<RunPublic> {
    const run = requireRun(runId)
    if (run.status === "closed") {
      throw new RunActionError("invalid_state", "Run is already closed")
    }
    teardownRun(runId)
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
      clearForceKill(runId)
      clearRunTimers(runId)
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

  /** Latest assistant text for an agent (inspect_agent). */
  function lastAssistantText(runId: string, agentId: string): string | null {
    const list = queries.listMessages(runId, { agentId })
    for (let index = list.items.length - 1; index >= 0; index -= 1) {
      const item = list.items[index]
      if (item.entry.type !== "message") continue
      const message = item.entry.message
      if (message.role !== "assistant") continue
      const body = message.content
        .flatMap((part) =>
          typeof part === "string"
            ? [part]
            : part && part.type === "text"
              ? [part.text]
              : []
        )
        .join("\n")
        .trim()
      if (body) return body.slice(0, 50_000)
    }
    return null
  }

  /** Run a plugin's event wiring with scope narrowing (spec §3.1 discriminated
   * union): challenge scope → wire(run); event scope → wire(run, event) with an
   * EventHandle wired to the event's run-lifecycle emitter. Agent creation is
   * automatic (from the plugin's declared `agents`); this only fires the
   * plugin's optional triggers. */
  async function runSetup(
    plugin: OrchestrationPlugin,
    handle: ReturnType<typeof createRunHandle>,
    eventHandle?: EventHandle
  ): Promise<void> {
    if (plugin.scope === "challenge") {
      await plugin.wire?.(handle)
      return
    }
    if (!eventHandle) {
      throw new Error(
        `Event-scope plugin '${plugin.id}' requires an EventHandle`
      )
    }
    await plugin.wire?.(handle, eventHandle)
  }

  /** Shared create/restore tail (spec §4.2: create and cold-restore run the
   * same code): persist the run-level context (container refs, model, prompt
   * template + child template), build the plugin-facing handle and run its
   * wiring. Returns the handle so fresh creates can reach primeSpecs. The
   * differences (fence/slot reservation, the container build, priming, the
   * initialPrompt override) stay in the callers. */
  async function buildRunContext(opts: {
    runId: string
    scope: "challenge" | "event"
    eventId: string
    challengeId: string | null
    orchestration: string
    containerName: string
    containerWorkspace: string
    wsAbs: string
    modelRuntime: RunModelRuntime
    sdkModel: Model<Api> | undefined
    defaultModelRef: ModelRef
    thinkingLevel: ThinkingLevel
    promptContext: PromptContext
    slotOverrides?: Record<string, ModelRef>
    initialPromptOverride?: string
  }): Promise<ReturnType<typeof createRunHandle>> {
    const plugin = requirePlugin(opts.orchestration)
    const templateMap = loadTemplateMap(db, plugin.id)
    const initialPrompt =
      opts.initialPromptOverride ??
      renderTemplate(templateMap, "initial", opts.promptContext)

    // Run-level live context: prepareAgent (prime) + spawn children reuse it.
    // The child prompt comes from the plugin's spawn template (plugin → builtin
    // resolution; default childSystem).
    contexts.set(opts.runId, {
      containerName: opts.containerName,
      workspaceHostPath: opts.wsAbs,
      containerWorkspace: opts.containerWorkspace,
      sessionsDir: sessionsAbs(opts.runId),
      modelRuntime: opts.modelRuntime,
      sdkModel: opts.sdkModel,
      defaultModelRef: opts.defaultModelRef,
      thinkingLevel: opts.thinkingLevel,
      childTemplate:
        templateMap.get(plugin.spawn?.systemPrompt ?? "childSystem") ?? "",
      promptContext: opts.promptContext,
      challengeId: opts.challengeId ?? "",
    })

    const emitter = new RunEmitter()
    emitters.set(opts.runId, emitter)

    const host = buildHandleHost({
      runId: opts.runId,
      scope: opts.scope,
      plugin,
      ctx: opts.promptContext,
      initialPrompt,
      templateMap,
      emitter,
      slotOverrides: opts.slotOverrides,
    })
    const handle = createRunHandle(host)
    await runSetup(
      plugin,
      handle,
      opts.scope === "event" ? eventHandleFor(opts.eventId) : undefined
    )
    return handle
  }

  /** Build the {@link RunHandleHost} callback bundle the plugin-facing handle
   * delegates through. All callbacks are per-agentId (spec §4.5a): no run-level
   * lock leaks. Shared by create() (fresh) and restoreRunContext() (cold). */
  function buildHandleHost(opts: {
    runId: string
    scope: "challenge" | "event"
    plugin: OrchestrationPlugin
    ctx: PromptContext
    initialPrompt: string
    templateMap: Map<string, string>
    emitter: RunEmitter
    slotOverrides?: Record<string, ModelRef>
  }): RunHandleHost {
    const plugin = opts.plugin
    return {
      runId: opts.runId,
      scope: opts.scope,
      ctx: opts.ctx,
      initialPrompt: opts.initialPrompt,
      templateMap: opts.templateMap,
      emitter: opts.emitter,
      agents: plugin.agents,
      findAgentBySlot(slot) {
        return db
          .select()
          .from(agents)
          .where(and(eq(agents.runId, opts.runId), eq(agents.slot, slot)))
          .get()
      },
      createFreshAgent(input: FreshAgentInput) {
        const id = crypto.randomUUID()
        const ts = now()
        db.insert(agents)
          .values({
            id,
            runId: opts.runId,
            slot: input.slot,
            role: input.role,
            parentAgentId: input.parentAgentId ?? null,
            isEntry: input.isEntry,
            model: input.model,
            systemPrompt: input.systemPrompt,
            tools: JSON.stringify(input.tools),
            status: "idle",
            sessionFile: null,
            name: input.name,
            task: input.task ?? null,
            createdAt: ts,
            updatedAt: ts,
          })
          .run()
        return id
      },
      resolveSlotModel(slot) {
        const override = opts.slotOverrides?.[slot]
        return override
          ? modelResolver.resolveSlotModelFromRef(override)
          : modelResolver.resolveSlotModel(plugin.id, slot)
      },
      isAgentStreaming(agentId) {
        if (lifecycle.get(agentId)?.session.isStreaming) return true
        const child = childSessions.get(agentId)
        return !!child?.session.isStreaming
      },
      prepareAgent: (agentId) => prepareAgent(opts.runId, agentId),
      sendToAgent: (agentId, text, deliverAs) =>
        lifecycle.send(agentId, text, deliverAs),
      abortAgent: (agentId) => lifecycle.abort(agentId),
    }
  }

  /** Cold-restore a closed run's run-level context: rebuild the container +
   * model runtime + prompt context, then re-run the plugin's setup (spec §4.2 —
   * create and resume run the same code). createAgent reuses existing agent
   * rows (slot idempotent, snapshot priority) and on() re-wires triggers; prime
   * is ignored on restore. Does NOT create sessions — prepareAgent does, lazily
   * per agent. */
  async function restoreRunContext(
    runId: string,
    row: typeof runs.$inferSelect
  ): Promise<void> {
    // Scheduler (event-scoped) runs cold-restore like challenge runs: a
    // message to a closed run's agent rebuilds the container + session and
    // re-runs the plugin wiring. A manual `start` remains a fresh (newSession)
    // replacement — create() deletes the closed row first (spec §4.2).
    const settings = options.getSettings()

    // Cold-restoring a closed challenge run occupies a concurrency slot
    // (spec §8.2, third fence enforcement point); scheduler runs do not count
    // (same as create). Reserve atomically: check the fence (challenge only) +
    // flip the run row to running so concurrent launches count it. Any later
    // failure reverts to closed (releasing the slot) below.
    //
    // `finishing` is reset here too: a crash between finish_run's atomic claim
    // and its teardown leaves finishing=1 on a closed row (recoverOnBoot only
    // wrote closed). Restoring is a NEW lifecycle — the stale finish intent is
    // void, so the run must be claimable by finish_run again.
    await withFence(async () => {
      if (row.scopeType === "challenge") {
        const decision = checkLaunchFence(db, settings, {
          scopeType: "challenge",
          eventId: row.eventId,
          challengeId: row.challengeId,
        })
        if (!decision.ok) {
          throw new RunActionError("capacity", decision.message)
        }
      }
      updateRun(runId, {
        status: "running",
        finishing: false,
        updatedAt: now(),
      })
    })

    try {
      const wsAbs = workspaceAbs(runId)
      const rtAbs = runtimeAbs(runId)
      // A stale SIGKILL grace timer from the prior close must not fire against
      // the freshly rebuilt container (same name).
      clearForceKill(runId)
      mkdirSync(rtAbs, { recursive: true })

      const modelRuntime = await createRunModelRuntime({
        runtimeDir: rtAbs,
        providers: providers(),
      })
      // Resolve the run default model (stored as a ref string) for spawn
      // children + prompt context. Best-effort: an unresolvable stored ref must
      // not fail the whole restore — prepareAgent resolves each agent's model
      // from its own snapshot.
      const defaultTarget = modelResolver.resolveModelTarget(row.model)
      const sdkModel = defaultTarget
        ? resolveRunModel(
            modelRuntime,
            defaultTarget.provider,
            defaultTarget.model.id
          )
        : undefined

      await createToolboxContainer(containerManager, {
        name: row.containerName,
        image: row.image,
        workspace: settings["container.workspace"],
        hostWorkspace: wsAbs,
        cpus: row.cpus,
        memoryMb: row.memoryMb,
        pidsLimit: row.pidsLimit,
        tmpfsSize: settings["container.tmpfsSize"],
        networkMode: get(settings, "container.networkMode"),
      })

      const modelDisplay = modelResolver.resolveModelDisplay(row.model)
      const environment: EnvironmentConfig = {
        type: "container",
        image: row.image,
        cpus: row.cpus,
        memoryMb: row.memoryMb,
        pidsLimit: row.pidsLimit,
      }
      const model = {
        provider: modelDisplay.provider,
        modelId: modelDisplay.modelId,
        modelLabel: modelDisplay.modelName,
        thinkingLevel: modelDisplay.thinkingLevel,
      }
      // Scope-aware prompt context: challenge runs render the challenge block;
      // scheduler (event-scope) runs render the event + instruction block.
      let promptContext: PromptContext
      if (row.scopeType === "challenge") {
        const challenge = row.challengeId
          ? db
              .select()
              .from(challenges)
              .where(eq(challenges.id, row.challengeId))
              .get()
          : undefined
        if (!challenge) {
          throw new RunActionError(
            "not_found",
            "Challenge not found for restore"
          )
        }
        promptContext = buildPromptContext(
          {
            runId,
            challenge,
            remote: getChallengeRemote(db, challenge.id),
            challengeAttachments: [],
            environment,
            model,
          },
          db,
          settings["container.workspace"]
        )
      } else {
        promptContext = buildEventPromptContext(
          {
            runId,
            eventId: row.eventId,
            instruction: getSchedulerConfig(row.eventId).instruction,
            environment,
            model,
            orchestrations: challengeOrchestrationCatalog(),
          },
          db,
          settings["container.workspace"]
        )
      }

      // Run-level live context + plugin wiring — the same shared tail as
      // create() (spec §4.2); primeSpecs are ignored on restore.
      await buildRunContext({
        runId,
        scope: row.scopeType === "event" ? "event" : "challenge",
        eventId: row.eventId,
        challengeId: row.challengeId,
        orchestration: row.orchestration,
        containerName: row.containerName,
        containerWorkspace: settings["container.workspace"],
        wsAbs,
        modelRuntime,
        sdkModel,
        defaultModelRef: row.model,
        thinkingLevel: modelDisplay.thinkingLevel,
        promptContext,
      })
      armRunTimers(runId, row.deadlineAt)
      // The run is live again — notify the event's scheduler so it does not
      // keep deciding on the stale closed state (spec §3.5).
      emitRunEvent(runId, { type: "run.resumed", runId })
    } catch (error) {
      // Restore failed after reserving the slot: release it so the fence and
      // run state stay consistent, then surface the error.
      contexts.delete(runId)
      emitters.get(runId)?.close()
      emitters.delete(runId)
      updateRun(runId, { status: "closed", updatedAt: now() })
      if (error instanceof RunActionError) throw error
      throw new RunActionError(
        "launch_failed",
        error instanceof Error ? error.message : String(error)
      )
    }
  }
  /** Per-run cold-restore single-flight: concurrent prepareAgent calls for the
   * same closed run share ONE restore promise, so a second restore never tears
   * down the container the first just built (createToolboxContainer removes
   * the same-named container first). The winner's promise is awaited by all
   * callers; on failure every caller gets the error (restoreRunContext's catch
   * reverts the run to closed). */
  const restoring = new Map<string, Promise<void>>()

  function restoreRunContextOnce(
    runId: string,
    row: typeof runs.$inferSelect
  ): Promise<void> {
    const existing = restoring.get(runId)
    if (existing) return existing
    const promise = restoreRunContext(runId, row).finally(() => {
      if (restoring.get(runId) === promise) restoring.delete(runId)
    })
    restoring.set(runId, promise)
    return promise
  }

  /** Prepare one agent's environment: container online (via the run context,
   * built lazily on cold-restore) + this agent's session online. Unified for
   * fresh create (no sessionFile → new session) and cold-restore (sessionFile →
   * open from snapshot). Idempotent; sends nothing. */
  async function prepareAgent(runId: string, agentId: string): Promise<void> {
    if (lifecycle.has(agentId)) return
    const row = queries.getRow(runId)
    if (!row) throw new RunActionError("not_found", "Run not found")
    const agentRow = db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .get()
    if (!agentRow) throw new RunActionError("not_found", "Agent not found")

    // Ensure the run-level context (container + model runtime + setup) exists.
    // Fresh create sets it before prepareAgent; cold-restore builds it here —
    // single-flighted per run so concurrent wakes share one restore.
    if (!contexts.has(runId)) {
      await restoreRunContextOnce(runId, row)
    }
    const ctx = contexts.get(runId)!

    // Resolve this agent's model from its own snapshot ref (per-agent; survives
    // switches). Cold-restore reuses the snapshot verbatim — no re-render.
    const agentTarget = modelResolver.resolveModelTarget(agentRow.model)
    if (!agentTarget) {
      throw new RunStartError("Could not resolve the agent's model for restore")
    }
    const sdkModel = resolveRunModel(
      ctx.modelRuntime,
      agentTarget.provider,
      agentTarget.model.id
    )
    if (!sdkModel) {
      throw new RunStartError("Could not resolve the agent's model for restore")
    }

    const snapshotTools = safeParseTools(agentRow.tools)
    const toolCtx = buildAgentToolContext(runId, ctx.challengeId, agentId)
    const nativeTools = [
      ...createMainTools(toolCtx, snapshotTools),
      // Scheduler tools are granted only to the event-scope orchestrator;
      // challenge agents never carry their names (spec §6). Gating here skips
      // the scheduler-tool context (a DB lookup + closures) for every solver.
      ...(row.scopeType === "event"
        ? createSchedulerTools(
            buildSchedulerToolContext(runId, agentId),
            snapshotTools
          )
        : []),
    ]

    let agentSession: HostAgentSession
    try {
      agentSession = await createHost({
        owner: { agentId, runId },
        channel: runId,
        agentId,
        cwd: ctx.containerWorkspace,
        containerName: ctx.containerName,
        containerManager,
        modelRuntime: ctx.modelRuntime,
        model: sdkModel,
        thinkingLevel: agentTarget.thinkingLevel,
        agentSettings: agentSettings(),
        systemPrompt: agentRow.systemPrompt,
        extraTools: nativeTools,
        extraToolNames: snapshotTools,
        ...(agentRow.sessionFile
          ? {
              resumeFrom: {
                sessionId: agentRow.sessionFile,
                isJsonl: agentRow.sessionFile.endsWith(".jsonl"),
                sessionsDir: ctx.sessionsDir,
              },
            }
          : {}),
        onUsageMaybeChanged: () => emitRun(runId),
        db,
        bus,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      clearForceKill(runId)
      terminateContainer(runId, ctx.containerName)
      throw new RunActionError("launch_failed", message)
    }

    updateAgent(agentId, {
      sessionFile: agentSession.sessionId ?? null,
      toolDefinitions: snapshotActiveToolDefinitions(agentSession.session),
    })
    lifecycle.set(agentId, agentSession)
  }

  async function recoverOnBoot() {
    const rows = db.select().from(runs).all()
    for (const row of rows) {
      if (row.status === "closed") continue
      // running/idle held live resources that are gone after a crash. Reclaim
      // any orphan container; mark the run closed + its agents idle (spec §12).
      await containerManager.remove(row.containerName).catch(() => undefined)
      const ts = now()
      // Reset finishing on the closed transition: a crash may have left the
      // flag set between finish_run's atomic claim and its teardown — without
      // this the cold-restored run would stay permanently un-finishable (the
      // finish_run claim WHERE finishing=0 would never match again).
      updateRun(row.id, {
        status: "closed",
        finishing: false,
        updatedAt: ts,
      })
      for (const agent of queries.listAgents(row.id)) {
        updateAgent(agent.id, { status: "idle", updatedAt: ts })
      }
    }
    // Boot closed every live run; pending queue items may now find capacity —
    // kick a drain (debounced, fires after recoverOnBoot returns).
    queue?.scheduleDrain()
  }

  async function close() {
    closed = true
    await Promise.allSettled(locks.values())
    locks.clear()
    for (const timer of forceKillTimers.values()) clearTimeout(timer)
    forceKillTimers.clear()
    for (const t of timeoutTimers.values()) {
      if (t.deadline) clearTimeout(t.deadline)
      if (t.grace) clearTimeout(t.grace)
    }
    timeoutTimers.clear()
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
   * scheduler (spec §3.5 run.flagAccepted). Called by the app after the flag
   * write; `agentId` is unknown on the platform path, so it stays optional. */
  function notifyFlagAccepted(runId: string): void {
    emitRunEvent(runId, { type: "run.flagAccepted", runId })
  }

  // --- scheduler policy + run management (P3) -----------------------------

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
        queue!.enqueue({
          ...input,
          orchestration: input.orchestration ?? "classic",
          eventId,
          source: "scheduler",
        }),
      listQueue: () => queue!.list(eventId),
      removeQueue: (itemId) => queue!.remove(itemId),
      clearQueue: () => queue!.clear(eventId),
      reorderQueue: (itemIds) => queue!.reorder(eventId, itemIds),
      startRun: async (input) => {
        const run = await resolveAndCreate({
          ...input,
          orchestration: input.orchestration ?? "classic",
          source: "scheduler",
        })
        return runSummary(run)
      },
      stopRun: async (id) => runSummary(await stop(id)),
      messageRun: async (id, text, deliverAs) =>
        runSummary(await sendMessage(id, { text, deliverAs })),
      closeRun: async (id) => runSummary(await closeRun(id)),
      readRun: (id) => readRun(id),
      listRuns: (filter) =>
        queries.listRuns({ eventId, ...filter }).map(runSummary),
      setRunTimeout: (id, timeoutMs) =>
        runSummary(setRunTimeout(id, timeoutMs)),
      getStatus: () => getStatusSnapshot(eventId),
      listChallenges: () => catalog.listChallengesForEvent(eventId),
      getChallenge: (id) => catalog.getChallenge(id),
      listAgents: (id) => queries.listAgents(id),
      lastAssistantText: (id, targetId) => lastAssistantText(id, targetId),
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
    const settings = options.getSettings()
    return create({
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

  /** Set / extend / shorten a run's hard deadline (spec §8.3). Persists the new
   * deadline + re-arms the timer for live (warm) runs; cold runs pick it up on
   * restore. Usable on closed runs (pre-sets the deadline for the next resume). */
  function setRunTimeout(runId: string, timeoutMs: number): RunPublic {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new RunActionError("invalid_state", "timeoutMs must be positive")
    }
    const deadlineAt = new Date(Date.now() + timeoutMs).toISOString()
    updateRun(runId, { timeoutMs, deadlineAt, updatedAt: now() })
    if (contexts.has(runId)) armRunTimers(runId, deadlineAt)
    emitRun(runId)
    return requireRun(runId)
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
      lastAssistant: entry ? lastAssistantText(runId, entry.id) : null,
    }
  }

  /** Fence snapshot augmented with active run details (challenge names). */
  function getStatusSnapshot(eventId: string): {
    maxConcurrentRuns: number
    runningCount: number
    maxConcurrentTargets: number
    activeTargetChallenges: string[]
    activeRuns: Array<{
      id: string
      challengeId: string | null
      challengeName: string
      status: string
      orchestration: string
    }>
  } {
    const snap = fenceSnapshot(db, options.getSettings(), eventId)
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

  /** Start (or replace) the event's scheduler run from its config (spec §10
   * scheduler/start). The orchestrator's model is the per-event
   * `scheduler_config.modelId` override when set, else the global orchestration
   * setting (`agentModels.scheduler.orchestrator`), else the global default —
   * resolved inside create() via the slot override. A fresh start replaces any
   * previous closed scheduler run (newSession semantics handled by create). */
  async function startScheduler(eventId: string): Promise<RunPublic> {
    const config = getSchedulerConfig(eventId)
    const settings = options.getSettings()
    return create({
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
   * (spec §8.1: avoid a pending death-loop). No-op if no live scheduler run. */
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
    void sendMessage(sched.id, { text }).catch(() => undefined)
  }

  // Construct the queue service now that resolveAndCreate + the failure
  // notifier exist (function declarations are hoisted). The drainer's launch
  // callback builds the run from the queue item's snapshot.
  queue = createQueueService({
    db,
    // Reference through options (not destructured) so `this` survives.
    getSettings: () => options.getSettings(),
    isDisposed: () => closed,
    launch: async (item) => {
      const run = await resolveAndCreate({
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
      notifySchedulerOfFailure(eventId, item, error),
  })

  return {
    create,
    resolveAndCreate,
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
    setRunTimeout,
    closeRun,
    delete: deleteRun,
    readRun,
    getStatus: getStatusSnapshot,
    getSchedulerRun,
    getSchedulerConfig,
    upsertSchedulerConfig,
    startScheduler,
    queue: () => queue!,
    refresh: queries.get,
    recoverOnBoot,
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
    /** Test seam: the atomic finish claim (spec §4.4). Exposed so tests can
     * verify the closed-run guard directly; no route reaches it. */
    markFinishing,
  }
}

function safeParseTools(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((t): t is string => typeof t === "string")
      : []
  } catch {
    return []
  }
}

/** Snapshot the active tools' definitions (name/description/JSON-schema) for
 * the timeline 工具定义 panel. getAllTools returns every registered tool;
 * filtering by getActiveToolNames keeps the always-on file tools and drops
 * inactive/override duplicates. TypeBox parameters serialize to JSON Schema
 * (symbol-keyed metadata is dropped by JSON.stringify). Defensive: → "[]". */
function snapshotActiveToolDefinitions(
  session: HostAgentSession["session"]
): string {
  try {
    const active = new Set(session.getActiveToolNames())
    return JSON.stringify(
      session
        .getAllTools()
        .filter((tool) => active.has(tool.name))
        .map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          ...(tool.promptGuidelines
            ? { promptGuidelines: tool.promptGuidelines }
            : {}),
        }))
    )
  } catch {
    return "[]"
  }
}

/** Compact run summary for the scheduler's read-only tools (list_runs /
 * start_run / ...): enough to identify a run + its outcome without the full
 * flag/usage payload. */
function runSummary(run: RunPublic) {
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
