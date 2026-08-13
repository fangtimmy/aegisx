import type { Database as Sqlite } from "bun:sqlite"
import { mkdirSync, rmSync } from "node:fs"
import { join, relative } from "node:path"

import type {
  EnvironmentConfig,
  ModelConfig,
  PromptTemplateContext,
  RunPublic,
  SwitchModelInput,
} from "@aegisx/shared"
import { get } from "@aegisx/shared"
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
import type { createDatabase } from "../db"
import { agents, challenges, runs } from "../db/schema"
import type { ConfigStore } from "../infrastructure/config-store"
import { getChallengeRemote } from "../platforms/challenge-state"
import type { createPlatformService } from "../platforms/service"
import { getProviderConnections } from "../providers/public"
import {
  renderInitialPrompt,
  renderSystemPrompt,
  resolvePromptTemplates,
} from "../settings/prompt-templates"
import { createChildAgentRuntime } from "./child-agents"
import type { ContainerManager } from "./container/container-manager"
import { createToolboxContainer } from "./container/container-manager"
import { RunActionError, RunStartError } from "./errors"
import {
  createRunModelRuntime,
  type RunModelRuntime,
  resolveRunModel,
} from "./model-runtime"
import { buildPromptContext, copyAttachments } from "./prompt"
import { createRunQueries } from "./queries"
import {
  createMainTools,
  type RunToolContext,
  type ToolCapabilities,
} from "./tools"

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
  sdkModel: Model<Api>
  /** Run default model config (spawn children snapshot this). */
  model: ModelConfig
  thinkingLevel: ThinkingLevel
  childTemplate: string
  promptContext: PromptTemplateContext
  caps: ToolCapabilities
  challengeId: string
}

export type CreateRunInput = {
  challengeId: string
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
  const queries = createRunQueries({ db, dataDir })
  const bus: LiveBus = createLiveBus()

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
   * logged by the lifecycle core) sends the agent to `failed`. */
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
    emitRun(runId)
    emitAgents(runId)
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
      if (runId) await ensureAgentWarm(runId, agentId)
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
   * release live resources outside the lock. Keeps the DB session + agent rows
   * so the run is cold-restorable. */
  function teardownRun(
    runId: string,
    opts: { summary?: string; finished?: boolean } = {}
  ) {
    const ts = now()
    const patch: Partial<typeof runs.$inferInsert> = {
      status: "closed",
      updatedAt: ts,
    }
    if (opts.summary !== undefined) patch.summary = opts.summary
    if (opts.finished) patch.completedAt = ts
    updateRun(runId, patch)
    // Any still-running agent lands on `idle` (its live session is gone).
    for (const agent of queries.listAgents(runId)) {
      if (agent.status === "running") {
        updateAgent(agent.id, { status: "idle", updatedAt: ts })
      }
    }
    clearRunTimers(runId)
    terminateContainer(runId, containerName(runId))
    childRuntime.abortAll(runId)
    const entry = entryAgent(runId)
    if (entry) {
      const session = lifecycle.get(entry.id)
      if (session) {
        void session.dispose()
        lifecycle.delete(entry.id)
      }
    }
    contexts.delete(runId)
    emitRun(runId)
    emitAgents(runId)
  }

  // --- timeout (spec §8.3: deadline → abort → grace → idle|closed) ---------

  function clearRunTimers(runId: string): void {
    const t = timeoutTimers.get(runId)
    if (t?.deadline) clearTimeout(t.deadline)
    if (t?.grace) clearTimeout(t.grace)
    timeoutTimers.delete(runId)
  }

  function streamingAgentIds(runId: string): string[] {
    const ids: string[] = []
    const entry = entryAgent(runId)
    if (entry && lifecycle.get(entry.id)?.session.isStreaming)
      ids.push(entry.id)
    for (const agent of queries.listAgents(runId)) {
      if (
        agent.parentAgentId &&
        childSessions.get(agent.id)?.session.isStreaming
      ) {
        ids.push(agent.id)
      }
    }
    return ids
  }

  /** Arm a run's hard-deadline timer. At expiry every streaming agent is
   * aborted; if all settle within the grace the run stays `idle` (warm), else
   * the container is SIGKILLed and the run goes `closed`. Idempotent. */
  function armRunTimers(runId: string, deadlineAt: string | null): void {
    clearRunTimers(runId)
    if (!deadlineAt) return
    const delay = Math.max(new Date(deadlineAt).getTime() - Date.now(), 0)
    const entry: { deadline?: NodeJS.Timeout; grace?: NodeJS.Timeout } = {}
    entry.deadline = setTimeout(() => {
      for (const agentId of streamingAgentIds(runId)) {
        void lifecycle.abort(agentId).catch(() => undefined)
        const child = childSessions.get(agentId)
        if (child) void child.session.abort().catch(() => undefined)
      }
      updateRun(runId, { lastTimeoutAt: now() })
      entry.grace = setTimeout(() => {
        // Still streaming after grace → SIGKILL the container → closed.
        if (streamingAgentIds(runId).length > 0) {
          teardownRun(runId)
        }
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

  function resolveCaps(promptContext: PromptTemplateContext): ToolCapabilities {
    return {
      canSubmitFlag: promptContext.capabilities.canSubmitFlag,
      canManageTarget: promptContext.capabilities.canManageTarget,
      canSpawnAgent: true,
    }
  }

  /** Real tool names granted to the entry agent (snapshotted on the row). File
   * tools are always on and not listed. */
  function entryToolNames(caps: ToolCapabilities): string[] {
    const names = ["finish_run"]
    if (caps.canSubmitFlag) names.push("submit_flag")
    if (caps.canManageTarget) {
      names.push("get_target", "start_target", "extend_target", "stop_target")
    }
    if (caps.canSpawnAgent) names.push("spawn_agent", "inspect_agent")
    return names
  }

  function buildEntryToolContext(
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
      getAgent: (id) => queries.listAgents(runId).find((a) => a.id === id),
      lastAssistantText: (id) => lastAssistantText(runId, id),
    }
  }

  /** Hand a finished child's result text to its parent: steer into the current
   * turn if streaming, otherwise drive a fresh turn. */
  const deliverToParent = (runId: string, text: string): void => {
    const entry = entryAgent(runId)
    if (!entry) return
    const session = lifecycle.get(entry.id)
    if (!session) return
    if (session.session.isStreaming) {
      void session.session.steer(text).catch(() => undefined)
    } else {
      lifecycle.drive(entry.id, text)
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

  async function create(input: CreateRunInput): Promise<RunPublic> {
    const challenge = db
      .select()
      .from(challenges)
      .where(eq(challenges.id, input.challengeId))
      .get()
    if (!challenge) throw new RunActionError("not_found", "Challenge not found")
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

    const remote = getChallengeRemote(db, input.challengeId)
    const challengeAttachments = copyAttachments(
      db,
      dataDir,
      input.challengeId,
      wsAbs
    )

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

    const promptContext = buildPromptContext(
      {
        runId,
        challenge,
        remote,
        challengeAttachments,
        environment: env,
        model: modelConfig,
      },
      db,
      input.container.workspace
    )
    const templates = resolvePromptTemplates(options.getSettings())
    const systemPrompt = renderSystemPrompt(
      templates.mainSystemPromptTemplate,
      promptContext
    )
    const initialPrompt = renderInitialPrompt(
      templates.initialPromptTemplate,
      promptContext
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

    const caps = resolveCaps(promptContext)
    const toolNames = entryToolNames(caps)

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
        scopeType: "challenge",
        eventId: challenge.eventId,
        challengeId: challenge.id,
        orchestration: "classic",
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

    const agentId = crypto.randomUUID()
    db.insert(agents)
      .values({
        id: agentId,
        runId,
        slot: "solver",
        role: "solver",
        parentAgentId: null,
        isEntry: true,
        provider: modelConfig.provider,
        providerLabel: modelConfig.providerLabel ?? null,
        modelId: modelConfig.modelId,
        modelLabel: modelConfig.modelLabel ?? null,
        thinkingLevel: modelConfig.thinkingLevel,
        systemPrompt,
        tools: JSON.stringify(toolNames),
        status: "running",
        sessionFile: null,
        name: "Solver",
        task: null,
        createdAt: ts,
        startedAt: ts,
        updatedAt: ts,
      })
      .run()

    const toolCtx = buildEntryToolContext(runId, challenge.id, agentId)
    const nativeTools = createMainTools(toolCtx, caps)
    let agentSession: HostAgentSession
    try {
      agentSession = await createHost({
        owner: { agentId, runId },
        channel: runId,
        agentId,
        cwd: input.container.workspace,
        containerName: name,
        containerManager,
        modelRuntime,
        model: sdkModel,
        thinkingLevel: input.thinkingLevel,
        agentSettings: agentSettings(),
        systemPrompt,
        extraTools: nativeTools,
        extraToolNames: toolNames,
        onUsageMaybeChanged: () => emitRun(runId),
        db,
        bus,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      updateAgent(agentId, {
        status: "failed",
        error: message,
        completedAt: now(),
        updatedAt: now(),
      })
      clearForceKill(runId)
      terminateContainer(runId, name)
      updateRun(runId, {
        status: "closed",
        error: `Failed to start agent: ${message}`,
        updatedAt: now(),
      })
      throw new RunActionError("launch_failed", message)
    }

    updateAgent(agentId, { sessionFile: agentSession.sessionId ?? null })
    contexts.set(runId, {
      containerName: name,
      workspaceHostPath: wsAbs,
      containerWorkspace: input.container.workspace,
      sessionsDir: sessAbs,
      modelRuntime,
      sdkModel,
      model: modelConfig,
      thinkingLevel: input.thinkingLevel,
      childTemplate: templates.childSystemPromptTemplate,
      promptContext,
      caps,
      challengeId: challenge.id,
    })
    lifecycle.set(agentId, agentSession)
    emitRun(runId)
    emitAgents(runId)

    armRunTimers(runId, deadlineAtIso)
    lifecycle.drive(agentId, initialPrompt)
    return requireRun(runId)
  }

  /** Esc: abort the entry agent's current turn (settles to idle; warm container). */
  /** Esc: abort the entry agent's current turn (it settles to idle; the
   * container stays warm). lifecycle.abort serializes on the entry agent's
   * lock, so no outer lock is needed. */
  async function stop(runId: string): Promise<RunPublic> {
    const entry = entryAgent(runId)
    if (entry) await lifecycle.abort(entry.id)
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

  /** Force-finish (HTTP /finish): atomically claim finishing; if the entry is
   * streaming, its settle tears the run down, otherwise tear down now. No outer
   * lock — markFinishing is atomic SQL and lifecycle.abort locks the agent. */
  async function finish(runId: string, summary: string): Promise<RunPublic> {
    const run = requireRun(runId)
    if (run.status === "closed") {
      throw new RunActionError("invalid_state", "Run is already closed")
    }
    const entry = entryAgent(runId)
    if (!entry) throw new RunActionError("not_found", "Run has no entry agent")
    const session = lifecycle.get(entry.id)
    if (session?.session.isStreaming) {
      if (markFinishing(runId)) {
        pendingFinish.set(entry.id, { summary, runId })
      }
      await lifecycle.abort(entry.id)
    } else {
      teardownRun(runId, { summary, finished: true })
    }
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
    // Serialize against the entry agent's turns (direct session.abort below —
    // not lifecycle.abort — to avoid re-entering the same lock).
    const entry = entryAgent(runId)
    await withLock(entry?.id ?? runId, async () => {
      const row = queries.getRow(runId)
      if (!row) throw new RunActionError("not_found", "Run not found")
      const session = entry && lifecycle.get(entry.id)
      if (session?.session.isStreaming) {
        await session.session.abort().catch(() => undefined)
      }
      clearForceKill(runId)
      clearRunTimers(runId)
      await containerManager.remove(row.containerName).catch(() => undefined)
      childRuntime.abortAll(runId)
      if (session) {
        void session.dispose()
        lifecycle.delete(entry!.id)
      }
      contexts.delete(runId)
      pendingFinish.delete(entry?.id ?? "")
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

  /** Cold-restore one agent of a closed run: rebuild its container + live
   * session from the agent row's snapshot (system prompt / tools / model). The
   * entry agent is restored for run-level sends; spawn children re-open lazily
   * when their parent drives them. */
  async function ensureAgentWarm(
    runId: string,
    agentId: string
  ): Promise<void> {
    if (lifecycle.has(agentId)) return
    const row = queries.getRow(runId)
    if (!row) throw new RunActionError("not_found", "Run not found")
    const agentRow = db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .get()
    if (!agentRow) throw new RunActionError("not_found", "Agent not found")
    if (!agentRow.sessionFile) {
      throw new RunActionError(
        "invalid_state",
        "Agent has no session to restore"
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
    // Resolve the model from the agent's snapshot (per-agent; survives switches).
    const provider = providers().find((p) => p.label === agentRow.providerLabel)
    const sdkModel = provider
      ? resolveRunModel(modelRuntime, provider, agentRow.modelId)
      : undefined
    if (!sdkModel) {
      throw new RunStartError("Could not resolve the agent's model for restore")
    }

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

    const toolCtx = buildEntryToolContext(runId, row.challengeId ?? "", agentId)
    // Re-derive capabilities from the snapshot's tool list.
    const snapshotTools = safeParseTools(agentRow.tools)
    const caps: ToolCapabilities = {
      canSubmitFlag: snapshotTools.includes("submit_flag"),
      canManageTarget: snapshotTools.some((t) => t.endsWith("_target")),
      canSpawnAgent: snapshotTools.includes("spawn_agent"),
    }
    const nativeTools = createMainTools(toolCtx, caps)

    let agentSession: HostAgentSession
    try {
      agentSession = await createHost({
        owner: { agentId, runId },
        channel: runId,
        agentId,
        cwd: settings["container.workspace"],
        containerName: row.containerName,
        containerManager,
        modelRuntime,
        model: sdkModel,
        thinkingLevel: agentRow.thinkingLevel as ThinkingLevel,
        agentSettings: agentSettings(),
        // Cold-restore reuses the snapshot verbatim (no re-render, no default
        // fallback) — per-agent prompt/model edits survive.
        systemPrompt: agentRow.systemPrompt,
        extraTools: nativeTools,
        extraToolNames: snapshotTools,
        resumeFrom: {
          sessionId: agentRow.sessionFile,
          isJsonl: agentRow.sessionFile.endsWith(".jsonl"),
          sessionsDir: sessionsAbs(runId),
        },
        onUsageMaybeChanged: () => emitRun(runId),
        db,
        bus,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      clearForceKill(runId)
      terminateContainer(runId, row.containerName)
      throw new RunActionError("launch_failed", message)
    }

    // Rebuild the run context (spawn children reuse the runtime/container).
    // runService owns challenge-scope runs only (P1a); a challenge row is
    // always present for cold-restore.
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
    const remote = row.challengeId
      ? getChallengeRemote(db, row.challengeId)
      : undefined
    const templates = resolvePromptTemplates(settings)
    contexts.set(runId, {
      containerName: row.containerName,
      workspaceHostPath: wsAbs,
      containerWorkspace: settings["container.workspace"],
      sessionsDir: sessionsAbs(runId),
      modelRuntime,
      sdkModel,
      model: {
        provider: agentRow.providerLabel ?? agentRow.provider,
        providerLabel: agentRow.providerLabel ?? undefined,
        modelId: agentRow.modelId,
        modelLabel: agentRow.modelLabel ?? undefined,
        thinkingLevel: agentRow.thinkingLevel as ThinkingLevel,
      },
      thinkingLevel: agentRow.thinkingLevel as ThinkingLevel,
      childTemplate: templates.childSystemPromptTemplate,
      promptContext: buildPromptContext(
        {
          runId,
          challenge,
          remote,
          challengeAttachments: [],
          environment: {
            type: "container",
            image: row.image,
            cpus: row.cpus,
            memoryMb: row.memoryMb,
            pidsLimit: row.pidsLimit,
          },
          model: {
            provider: agentRow.providerLabel ?? agentRow.provider,
            providerLabel: agentRow.providerLabel ?? undefined,
            modelId: agentRow.modelId,
            modelLabel: agentRow.modelLabel ?? undefined,
            thinkingLevel: agentRow.thinkingLevel as ThinkingLevel,
          },
        },
        db,
        settings["container.workspace"]
      ),
      caps,
      challengeId: row.challengeId ?? "",
    })
    lifecycle.set(agentId, agentSession)
    armRunTimers(runId, row.deadlineAt)
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
    bus.close()
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
