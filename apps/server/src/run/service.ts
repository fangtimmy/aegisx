import type { Database as Sqlite } from "bun:sqlite"
import { mkdirSync, rmSync } from "node:fs"
import { join, relative } from "node:path"

import type {
  EnvironmentConfig,
  ModelConfig,
  RunPublic,
  SwitchModelInput,
} from "@aegisx/shared"
import { get } from "@aegisx/shared"
import type { ProviderConnection } from "@aegisx/shared/provider"
import type { ThinkingLevel } from "@aegisx/shared/thinking"
import type { Api, Model } from "@earendil-works/pi-ai"
import { and, eq, inArray, sql } from "drizzle-orm"
import type { TSchema } from "typebox"
import { Value } from "typebox/value"

import { applyModelSwitch, type SwitchTarget } from "../agents/agent-ops"
import { createAgentHost } from "../agents/host"
import type {
  AgentLoopSettings,
  HostAgentSession,
} from "../agents/host-session"
import { chainLock, createSessionLifecycle } from "../agents/lifecycle"
import { createLiveBus, type LiveBus } from "../agents/live"
import type { createDatabase } from "../db"
import { agents, challenges, events, runs } from "../db/schema"
import type { ConfigStore } from "../infrastructure/config-store"
import {
  loadTemplateMap,
  renderTemplate,
} from "../orchestration/prompt-templates-store"
import { bootOrchestration, requirePlugin } from "../orchestration/registry"
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
  ModelSnapshot,
  OrchestrationPlugin,
  PromptContext,
} from "../orchestration/types"
import { getChallengeRemote } from "../platforms/challenge-state"
import type { createPlatformService } from "../platforms/service"
import { getProviderConnections } from "../providers/public"
import { createChildAgentRuntime } from "./child-agents"
import type { ContainerManager } from "./container/container-manager"
import { createToolboxContainer } from "./container/container-manager"
import { RunActionError, RunStartError } from "./errors"
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
import { createMainTools, type RunToolContext } from "./tools"

type Database = ReturnType<typeof createDatabase>["db"]
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
  /** Run default model config (spawn children snapshot this). */
  model: ModelConfig
  thinkingLevel: ThinkingLevel
  childTemplate: string
  promptContext: PromptContext
  challengeId: string
}

export type CreateRunInput = {
  /** Orchestration plugin id (challenge runs default to 'classic'). */
  orchestration?: string
  /** Plugin input snapshot, validated against the plugin's params schema. */
  params?: Record<string, unknown>
  provider: ProviderConnection
  /** ProviderModel.id */
  modelId: string
  thinkingLevel: ThinkingLevel
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
  const queries = createRunQueries({ db, dataDir })
  const bus: LiveBus = createLiveBus()

  // Register built-in plugins + seed default prompt templates (idempotent) so
  // the service is self-sufficient — any RunHandle built here can render.
  bootOrchestration(db)

  /** Per-agent promise-chaining locks (the only concurrency mechanism; spec §4.5). */
  const locks = new Map<string, Promise<unknown>>()
  /** Finish winner per agent: the agent whose atomic finishing UPDATE hit. */
  const pendingFinish = new Map<string, { summary: string; runId: string }>()
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
  /** Live spawn-child sessions, keyed by child agent id. */
  const childSessions = new Map<string, HostAgentSession>()
  let closed = false
  const now = () => new Date().toISOString()

  function withLock<T>(agentId: string, op: () => T | Promise<T>): Promise<T> {
    if (closed) {
      return Promise.reject(
        new RunActionError("invalid_state", "Run service is closed")
      )
    }
    return chainLock(locks, agentId, op)
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
   * UPDATE hit (rows-affected = 1); that agent tears the run down (spec §4.4). */
  function markFinishing(runId: string): boolean {
    const res = sqlite.run(
      `UPDATE runs SET finishing = 1 WHERE id = ? AND finishing = 0`,
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
      emitRunEvent(runId, { type: "run.idle", runId })
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
    emitRun(runId)
    emitAgents(runId)
    if (opts.finished) emitRunEvent(runId, { type: "run.finished", runId })
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
      }, TIMEOUT_GRACE_MS)
    }, delay)
    timeoutTimers.set(runId, entry)
  }

  // --- providers / settings / tools ---------------------------------------

  function providers(): ProviderConnection[] {
    return getProviderConnections(configStore)
  }

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

  /** Validate plugin params against its declared typebox schema (spec §3.2). */
  function validatePluginParams(
    schema: TSchema,
    params: unknown
  ): Record<string, unknown> {
    if (!Value.Check(schema, params)) {
      const details = Value.Errors(schema, params)
        .map((error) => `${error.instancePath || "/"}: ${error.keyword}`)
        .join("; ")
      throw new RunActionError(
        "invalid_state",
        `Invalid plugin params: ${details}`
      )
    }
    return params as Record<string, unknown>
  }

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
    const params = validatePluginParams(plugin.params, input.params ?? {})

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

    const model = input.provider.models.find((m) => m.id === input.modelId)
    if (!model?.enabled || !input.provider.enabled) {
      throw new RunActionError("invalid_state", "Model is unavailable")
    }
    if (!input.provider.apiKey) {
      throw new RunActionError("invalid_state", "Provider API key is required")
    }

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
    const modelConfig: ModelConfig = {
      provider: input.provider.label,
      providerLabel: input.provider.label,
      modelId: model.modelId,
      modelLabel: model.label,
      thinkingLevel: input.thinkingLevel,
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
      input.provider,
      input.modelId
    )
    if (!sdkModel)
      throw new RunStartError("Could not resolve the selected model")

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
      throw new RunActionError(
        "launch_failed",
        error instanceof Error ? error.message : String(error)
      )
    }

    const ts = now()
    db.insert(runs)
      .values({
        id: runId,
        scopeType: input.scopeType,
        eventId:
          input.scopeType === "challenge" ? challenge!.eventId : event!.id,
        challengeId: challenge?.id ?? null,
        orchestration: plugin.id,
        params: JSON.stringify(params),
        status: "running",
        provider: modelConfig.provider,
        providerLabel: modelConfig.providerLabel ?? null,
        modelId: modelConfig.modelId,
        modelLabel: modelConfig.modelLabel ?? null,
        thinkingLevel: modelConfig.thinkingLevel,
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
        createdAt: ts,
        startedAt: ts,
        updatedAt: ts,
      })
      .run()

    // prompt_templates is the render source (spec §3.6); the plugin owns the
    // agent layout via setup(). The run row + container exist before setup
    // runs (spec §4.2); agents are declared by the plugin's setup.
    const templateMap = loadTemplateMap(db, plugin.id)
    const initialPrompt = renderTemplate(templateMap, "initial", promptContext)

    // Run-level live context: prepareAgent (prime) + spawn children reuse it.
    // The child prompt comes from the plugin's spawn template (plugin → builtin
    // resolution; default childSystem).
    contexts.set(runId, {
      containerName: name,
      workspaceHostPath: wsAbs,
      containerWorkspace: input.container.workspace,
      sessionsDir: sessAbs,
      modelRuntime,
      sdkModel,
      model: modelConfig,
      thinkingLevel: input.thinkingLevel,
      childTemplate:
        templateMap.get(plugin.spawn?.systemPrompt ?? "childSystem") ?? "",
      promptContext,
      challengeId: challenge?.id ?? "",
    })

    const emitter = new RunEmitter()
    emitters.set(runId, emitter)
    const defaultModel: ModelSnapshot = {
      provider: modelConfig.provider,
      providerLabel: modelConfig.providerLabel ?? null,
      modelId: modelConfig.modelId,
      modelLabel: modelConfig.modelLabel ?? null,
      thinkingLevel: modelConfig.thinkingLevel,
    }

    const host = buildHandleHost({
      runId,
      scope: input.scopeType,
      params,
      ctx: promptContext,
      initialPrompt,
      templateMap,
      emitter,
      defaultModel,
    })
    const handle = createRunHandle(host)
    try {
      await runSetup(
        plugin,
        handle,
        input.scopeType === "event" ? eventHandleFor(event!.id) : undefined
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      teardownRun(runId)
      updateRun(runId, {
        error: `Plugin setup failed: ${message}`,
        updatedAt: now(),
      })
      throw new RunActionError("launch_failed", message)
    }

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
  function switchModel(
    runId: string,
    input: SwitchModelInput
  ): Promise<RunPublic> {
    const entry = entryAgent(runId)
    if (!entry) throw new RunActionError("not_found", "Run has no entry agent")
    return withLock(entry.id, async () => {
      const session = lifecycle.get(entry.id)
      if (!session) {
        throw new RunActionError(
          "invalid_state",
          "Run has no live session; start or reopen it first"
        )
      }
      const agentRow = db
        .select({ modelId: agents.modelId })
        .from(agents)
        .where(eq(agents.id, entry.id))
        .get()
      let target: SwitchTarget
      let thinkingLevel: ThinkingLevel
      try {
        ;({ target, thinkingLevel } = await applyModelSwitch(
          session,
          providers(),
          input,
          (t) => agentRow?.modelId === t.model.modelId
        ))
      } catch (error) {
        throw new RunActionError(
          "invalid_state",
          error instanceof Error ? error.message : String(error)
        )
      }
      updateAgent(entry.id, {
        provider: target.provider.label,
        providerLabel: target.provider.label,
        modelId: target.model.modelId,
        modelLabel: target.model.label,
        thinkingLevel,
        updatedAt: now(),
      })
      emitAgents(runId)
      return requireRun(runId)
    })
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

  /** Run a plugin's setup with scope narrowing (spec §3.1 discriminated union):
   * challenge scope → setup(run); event scope → setup(run, event) with an
   * EventHandle wired to the event's run-lifecycle emitter. */
  async function runSetup(
    plugin: OrchestrationPlugin,
    handle: ReturnType<typeof createRunHandle>,
    eventHandle?: EventHandle
  ): Promise<void> {
    if (plugin.scope === "challenge") {
      await plugin.setup(handle)
      return
    }
    if (!eventHandle) {
      throw new Error(
        `Event-scope plugin '${plugin.id}' requires an EventHandle`
      )
    }
    await plugin.setup(handle, eventHandle)
  }

  /** Build the {@link RunHandleHost} callback bundle the plugin-facing handle
   * delegates through. All callbacks are per-agentId (spec §4.5a): no run-level
   * lock leaks. Shared by create() (fresh) and restoreRunContext() (cold). */
  function buildHandleHost(opts: {
    runId: string
    scope: "challenge" | "event"
    params: unknown
    ctx: PromptContext
    initialPrompt: string
    templateMap: Map<string, string>
    emitter: RunEmitter
    defaultModel: ModelSnapshot
  }): RunHandleHost {
    return {
      runId: opts.runId,
      scope: opts.scope,
      params: opts.params,
      ctx: opts.ctx,
      initialPrompt: opts.initialPrompt,
      templateMap: opts.templateMap,
      emitter: opts.emitter,
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
            provider: input.model.provider,
            providerLabel: input.model.providerLabel,
            modelId: input.model.modelId,
            modelLabel: input.model.modelLabel,
            thinkingLevel: input.model.thinkingLevel,
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
      resolveAgentModel(model) {
        if (model === "default") return opts.defaultModel
        const provider = providers().find((p) => p.label === model.provider)
        const pm = provider?.models.find(
          (m) => m.modelId === model.modelId || m.id === model.modelId
        )
        return {
          provider: provider?.label ?? model.provider,
          providerLabel: provider?.label ?? model.provider,
          modelId: pm?.modelId ?? model.modelId,
          modelLabel: pm?.label ?? null,
          thinkingLevel: model.thinking,
        }
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
    // Scheduler (event-scoped) runs are never cold-restored: either fresh
    // (start) or closed (spec §4.2).
    if (row.scopeType === "event") {
      throw new RunActionError(
        "invalid_state",
        "Scheduler runs are never cold-restored; start a fresh one"
      )
    }
    const settings = options.getSettings()
    const wsAbs = workspaceAbs(runId)
    const rtAbs = runtimeAbs(runId)
    mkdirSync(rtAbs, { recursive: true })

    const modelRuntime = await createRunModelRuntime({
      runtimeDir: rtAbs,
      providers: providers(),
    })
    const runProvider = providers().find(
      (p) => p.label === (row.providerLabel ?? row.provider)
    )
    // Run-level sdkModel is used only by spawn children (classic spawn uses the
    // run default). Best-effort: a dummy run row modelId (e.g. in tests) must
    // not fail the whole restore — prepareAgent resolves each agent's model
    // from its own snapshot.
    const sdkModel = runProvider
      ? resolveRunModel(modelRuntime, runProvider, row.modelId)
      : undefined

    try {
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
    } catch (error) {
      throw new RunActionError(
        "launch_failed",
        error instanceof Error ? error.message : String(error)
      )
    }

    // runService owns challenge-scope runs; a challenge row is always present
    // for cold-restore (event-scoped runs are rejected above).
    const challenge = row.challengeId
      ? db
          .select()
          .from(challenges)
          .where(eq(challenges.id, row.challengeId))
          .get()
      : undefined
    if (!challenge) {
      throw new RunActionError("not_found", "Challenge not found for restore")
    }
    const promptContext = buildPromptContext(
      {
        runId,
        challenge,
        remote: getChallengeRemote(db, challenge.id),
        challengeAttachments: [],
        environment: {
          type: "container",
          image: row.image,
          cpus: row.cpus,
          memoryMb: row.memoryMb,
          pidsLimit: row.pidsLimit,
        },
        model: {
          provider: row.providerLabel ?? row.provider,
          providerLabel: row.providerLabel ?? undefined,
          modelId: row.modelId,
          modelLabel: row.modelLabel ?? undefined,
          thinkingLevel: row.thinkingLevel as ThinkingLevel,
        },
      },
      db,
      settings["container.workspace"]
    )

    const plugin = requirePlugin(row.orchestration)
    const templateMap = loadTemplateMap(db, plugin.id)
    const initialPrompt = renderTemplate(templateMap, "initial", promptContext)

    contexts.set(runId, {
      containerName: row.containerName,
      workspaceHostPath: wsAbs,
      containerWorkspace: settings["container.workspace"],
      sessionsDir: sessionsAbs(runId),
      modelRuntime,
      sdkModel,
      model: {
        provider: row.providerLabel ?? row.provider,
        providerLabel: row.providerLabel ?? undefined,
        modelId: row.modelId,
        modelLabel: row.modelLabel ?? undefined,
        thinkingLevel: row.thinkingLevel as ThinkingLevel,
      },
      thinkingLevel: row.thinkingLevel as ThinkingLevel,
      childTemplate:
        templateMap.get(plugin.spawn?.systemPrompt ?? "childSystem") ?? "",
      promptContext,
      challengeId: row.challengeId ?? "",
    })

    const emitter = new RunEmitter()
    emitters.set(runId, emitter)
    const defaultModel: ModelSnapshot = {
      provider: row.provider,
      providerLabel: row.providerLabel,
      modelId: row.modelId,
      modelLabel: row.modelLabel,
      thinkingLevel: row.thinkingLevel as ThinkingLevel,
    }

    const host = buildHandleHost({
      runId,
      scope: row.scopeType === "event" ? "event" : "challenge",
      params: JSON.parse(row.params || "{}"),
      ctx: promptContext,
      initialPrompt,
      templateMap,
      emitter,
      defaultModel,
    })
    const handle = createRunHandle(host)
    await runSetup(plugin, handle)
    // primeSpecs ignored on restore (spec §4.2).
    armRunTimers(runId, row.deadlineAt)
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
    // Fresh create sets it before prepareAgent; cold-restore builds it here.
    if (!contexts.has(runId)) {
      await restoreRunContext(runId, row)
    }
    const ctx = contexts.get(runId)!

    // Resolve this agent's model from its own snapshot (per-agent; survives
    // switches). Cold-restore reuses the snapshot verbatim — no re-render.
    const provider = providers().find((p) => p.label === agentRow.providerLabel)
    const sdkModel = provider
      ? resolveRunModel(ctx.modelRuntime, provider, agentRow.modelId)
      : undefined
    if (!sdkModel) {
      throw new RunStartError("Could not resolve the agent's model for restore")
    }

    const snapshotTools = safeParseTools(agentRow.tools)
    const toolCtx = buildAgentToolContext(runId, ctx.challengeId, agentId)
    const nativeTools = createMainTools(toolCtx, snapshotTools)

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
        thinkingLevel: agentRow.thinkingLevel as ThinkingLevel,
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

    updateAgent(agentId, { sessionFile: agentSession.sessionId ?? null })
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
      updateRun(row.id, { status: "closed", updatedAt: ts })
      for (const agent of queries.listAgents(row.id)) {
        updateAgent(agent.id, { status: "idle", updatedAt: ts })
      }
    }
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
    await lifecycle.closeAll()
    for (const childSession of childSessions.values())
      await childSession.dispose()
    childSessions.clear()
    pendingFinish.clear()
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

  return {
    create,
    stop,
    switchModel,
    finish,
    sendMessage,
    setQueue,
    closeRun,
    delete: deleteRun,
    refresh: queries.get,
    recoverOnBoot,
    close,
    listMessages: queries.listMessages,
    get: queries.get,
    detail: queries.detail,
    listForEvent: queries.listForEvent,
    listAgents: queries.listAgents,
    workspacePath: queries.workspacePath,
    runDirPath: queries.runDirPath,
    bus,
    notifyFlagAccepted,
    submitFlag: platformService.submitFlag,
    targetAction: platformService.targetAction,
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
