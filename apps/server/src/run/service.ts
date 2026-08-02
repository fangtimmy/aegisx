import { mkdirSync, rmSync } from "node:fs"
import { join, relative } from "node:path"
import type { Model } from "@earendil-works/pi-ai"
import {
  createBashToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent"
import { and, eq, gt } from "drizzle-orm"
import type {
  EnvironmentConfig,
  MessageList,
  ModelConfig,
  PromptTemplateContext,
  RunPublic,
} from "../../../shared"
import { get } from "../../../shared"
import type { Message } from "../../../shared/message"
import type { ProviderConnection } from "../../../shared/provider"
import type { TargetState } from "../../../shared/target"
import type { ThinkingLevel } from "../../../shared/thinking"
import type { createDatabase } from "../db"
import { agents, challenges, runEvents, runs } from "../db/schema"
import type { ConfigStore } from "../infrastructure/config-store"
import { getChallengeRemote } from "../platforms/challenge-state"
import type { createPlatformService } from "../platforms/service"
import { getProviderConnections } from "../providers/public"
import {
  renderInitialPrompt,
  renderSystemPrompt,
  resolvePromptTemplates,
} from "../settings/prompt-templates"
import { createRunAgentSession, type RunAgentSession } from "./agent-session"
import type { ContainerManager } from "./container-manager"
import { createContainerBashOperations } from "./container-tools"
import { RunActionError, RunStartError } from "./errors"
import { rowToMessage } from "./events"
import { createLiveBus, type LiveBus } from "./live"
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
import { createDockerExecBackend } from "./workspace/backend"
import { createWorkspaceTools } from "./workspace/tools"

type Database = ReturnType<typeof createDatabase>["db"]
type PlatformService = ReturnType<typeof createPlatformService>

const RUNS_SUBDIR = "runs"
/** v4 Phase 3: cap concurrent child agents per run (code constant for now). */
const MAX_CHILDREN_PER_RUN = 1

export type RunServiceOptions = {
  db: Database
  dataDir: string
  containerManager: ContainerManager
  platformService: PlatformService
  configStore: ConfigStore
  getSettings(): import("../../../shared").FlatSettings
}

type PendingOutcome = { mode: "finish"; summary: string } | { mode: "close" }

type RunContext = {
  containerName: string
  workspaceHostPath: string
  sessionsDir: string
  modelRuntime: RunModelRuntime
  sdkModel: Model<any>
  thinkingLevel: ThinkingLevel
  /** Raw child system-prompt template (rendered per child with its name/task). */
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
}

export type SendMessageInput = {
  text: string
  /** Only meaningful while the agent is streaming (steer/followUp). Ignored when starting a new turn. */
  deliverAs?: "steer" | "followUp"
}

export type RunService = ReturnType<typeof createRunService>

export function createRunService(options: RunServiceOptions) {
  const { db, dataDir, containerManager, platformService, configStore } =
    options
  const queries = createRunQueries({ db, dataDir })
  const bus: LiveBus = createLiveBus()

  const sessions = new Map<string, RunAgentSession>() // main agent per run
  const childSessions = new Map<string, RunAgentSession>() // by child agent id
  const contexts = new Map<string, RunContext>() // per-run reusable handles
  const locks = new Map<string, Promise<unknown>>()
  const pending = new Map<string, PendingOutcome>()
  /** Monotonic per-run turn counter; stale turn settles no-op (generation guard). */
  const turnGeneration = new Map<string, number>()
  const forceKillTimers = new Map<string, NodeJS.Timeout>()
  let closed = false
  const now = () => new Date().toISOString()

  function withLock<T>(runId: string, op: () => T | Promise<T>): Promise<T> {
    if (closed) {
      return Promise.reject(
        new RunActionError("invalid_state", "Run service is closed")
      )
    }
    const previous = locks.get(runId) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(op)
    locks.set(runId, next)
    return next.finally(() => {
      if (locks.get(runId) === next) locks.delete(runId)
    }) as Promise<T>
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

  function updateRun(runId: string, patch: Record<string, unknown>) {
    db.update(runs).set(patch).where(eq(runs.id, runId)).run()
  }

  function updateAgent(agentId: string, patch: Record<string, unknown>) {
    db.update(agents).set(patch).where(eq(agents.id, agentId)).run()
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

  function clearForceKill(runId: string) {
    const timer = forceKillTimers.get(runId)
    if (timer) {
      clearTimeout(timer)
      forceKillTimers.delete(runId)
    }
  }

  /** SIGTERM now; force SIGKILL after a grace period if still alive. */
  function terminateContainer(runId: string, name: string) {
    clearForceKill(runId)
    void containerManager
      .kill(name, "SIGTERM")
      .catch(() => undefined)
      .then(() =>
        containerManager
          .isRunning(name)
          .then((running) =>
            running
              ? containerManager.kill(name, "SIGKILL").catch(() => undefined)
              : undefined
          )
      )
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
    }, 10_000)
    forceKillTimers.set(runId, timer)
  }

  /**
   * Drive one prompt() turn to completion, then settle. The run is marked
   * running for the turn; on resolve it goes idle (container kept) unless
   * finish_run / a manual close requested resource release (→ closed).
   */
  function driveRun(runId: string, text: string) {
    const agentSession = sessions.get(runId)
    if (!agentSession) return
    const gen = (turnGeneration.get(runId) ?? 0) + 1
    turnGeneration.set(runId, gen)
    const ts = now()
    updateRun(runId, { status: "running", error: null, updatedAt: ts })
    const mainAgent = queries.mainAgent(runId)
    if (mainAgent) {
      updateAgent(mainAgent.id, {
        status: "running",
        error: null,
        updatedAt: ts,
      })
    }
    emitRun(runId)
    emitAgents(runId)
    void agentSession.session
      .prompt(text)
      .catch((error) => {
        console.error("Run prompt failed", {
          runId,
          error: error instanceof Error ? error.message : String(error),
        })
        return error instanceof Error ? error.message : String(error)
      })
      .then((error) =>
        settleTurn(runId, typeof error === "string" ? error : null, gen)
      )
  }

  /**
   * Turn resolved — the single settle point. A stale turn (a newer turn already
   * started) no-ops via the generation guard. Otherwise: finish/close → free
   * resources (closed); anything else → idle (container kept).
   */
  function settleTurn(runId: string, runError: string | null, gen: number) {
    void withLock(runId, () => {
      if (turnGeneration.get(runId) !== gen) return
      const row = queries.getRow(runId)
      if (!row || row.status !== "running") return
      const outcome = pending.get(runId)
      pending.delete(runId)
      if (outcome?.mode === "finish") {
        freeRun(runId, { summary: outcome.summary, finished: true })
      } else if (outcome?.mode === "close") {
        freeRun(runId)
      } else {
        idleRun(runId, runError)
      }
    })
  }

  /** Turn ended without a finish/close: go idle, keep the container warm. */
  function idleRun(runId: string, runError: string | null) {
    const ts = now()
    updateRun(runId, { status: "idle", error: runError, updatedAt: ts })
    const mainAgent = queries.mainAgent(runId)
    if (mainAgent) {
      updateAgent(mainAgent.id, {
        status: "idle",
        error: runError,
        updatedAt: ts,
      })
    }
    emitRun(runId)
    emitAgents(runId)
  }

  /**
   * Release a run's live resources (container + in-process session). The jsonl
   * + workspace are kept so the run can be cold-restored by messaging it. Run
   * becomes closed. `finished` stamps completedAt (finish_run / force finish).
   */
  function freeRun(
    runId: string,
    opts: { summary?: string; finished?: boolean } = {}
  ) {
    const ts = now()
    const patch: Record<string, unknown> = {
      status: "closed",
      updatedAt: ts,
    }
    if (opts.summary !== undefined) patch.summary = opts.summary
    if (opts.finished) patch.completedAt = ts
    updateRun(runId, patch)
    const mainAgent = queries.mainAgent(runId)
    if (mainAgent) updateAgent(mainAgent.id, { status: "idle", updatedAt: ts })
    clearForceKill(runId)
    terminateContainer(runId, containerName(runId))
    abortChildSessions(runId)
    const agentSession = sessions.get(runId)
    if (agentSession) {
      void agentSession.dispose()
      sessions.delete(runId)
    }
    contexts.delete(runId)
    turnGeneration.delete(runId)
    pending.delete(runId)
    emitRun(runId)
    emitAgents(runId)
  }

  function providers(): ProviderConnection[] {
    return getProviderConnections(configStore)
  }

  /** Resolve SDK agent-loop settings (compaction/retry) from AegisX settings. */
  function agentSettings() {
    const s = options.getSettings()
    return {
      compaction: { enabled: get(s, "agent.compactionEnabled") },
      retry: {
        enabled: get(s, "agent.retryEnabled"),
        maxRetries: get(s, "agent.retryMaxRetries"),
      },
    }
  }

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
    return withLock(runId, async () => {
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
      const mainSystemPrompt = renderSystemPrompt(
        templates.mainSystemPromptTemplate,
        promptContext
      )
      const initialPrompt = renderInitialPrompt(
        templates.initialPromptTemplate,
        promptContext
      )

      // Host-side model runtime (isolated models.json per run).
      const modelRuntime = await createRunModelRuntime({
        runtimeDir: rtAbs,
        providers: providers(),
      })
      const sdkModel = resolveRunModel(
        modelRuntime,
        input.provider,
        input.modelId
      )
      if (!sdkModel) {
        throw new RunStartError("Could not resolve the selected model")
      }

      const caps: ToolCapabilities = {
        canSubmitFlag: promptContext.capabilities.canSubmitFlag,
        canManageTarget: promptContext.capabilities.canManageTarget,
        canSpawnAgent: true,
      }

      // Tool-box container (sleep infinity) + bash forwarded via docker exec.
      try {
        await containerManager.create({
          name,
          image: env.image,
          workingDir: input.container.workspace,
          binds: [`${wsAbs}:${input.container.workspace}`],
          limits: {
            cpus: env.cpus,
            memoryMb: env.memoryMb,
            pidsLimit: env.pidsLimit,
          },
          tmpfsSize: input.container.tmpfsSize,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new RunActionError("launch_failed", message)
      }

      const ts = now()
      db.insert(runs)
        .values({
          id: runId,
          challengeId: challenge.id,
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
          createdAt: ts,
          startedAt: ts,
          updatedAt: ts,
        })
        .run()

      const mainAgentId = crypto.randomUUID()
      const ctx: RunToolContext = {
        runId,
        challengeId: challenge.id,
        agentId: mainAgentId,
        submitFlag: (flag) =>
          platformService
            .submitFlag(runId, challenge.id, flag)
            .then((r) => r ?? null),
        targetAction: (action) =>
          platformService.targetAction(challenge.id, action),
        requestFinish: (summary) =>
          pending.set(runId, { mode: "finish", summary }),
        spawnChild: (childInput) => spawnChild(runId, mainAgentId, childInput),
        hasAcceptedFlag: () => Promise.resolve(queries.hasAcceptedFlag(runId)),
        getAgent: (agentId) =>
          queries.listAgents(runId).find((a) => a.id === agentId),
        lastAssistantText: (agentId) => lastAssistantText(runId, agentId),
      }
      const nativeTools = createMainTools(ctx, caps)
      const bashDef = createBashToolDefinition(wsAbs, {
        operations: createContainerBashOperations(name, containerManager),
      })
      const workspaceTools = createWorkspaceTools(
        createDockerExecBackend(name, containerManager)
      )
      const customTools = [
        bashDef,
        ...workspaceTools,
        ...nativeTools,
      ] as ToolDefinition[]
      const toolNames = [
        "read",
        "bash",
        "edit",
        "write",
        "grep",
        "find",
        "ls",
        ...nativeTools.map((tool) => tool.name),
      ]

      let agentSession: RunAgentSession
      try {
        agentSession = await createRunAgentSession({
          runId,
          agentId: mainAgentId,
          workspaceHostPath: wsAbs,
          sessionsDir: sessAbs,
          modelRuntime,
          model: sdkModel,
          thinkingLevel: input.thinkingLevel,
          agentSettings: agentSettings(),
          systemPrompt: mainSystemPrompt,
          toolNames,
          customTools,
          db,
          bus,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        clearForceKill(runId)
        terminateContainer(runId, name)
        updateRun(runId, {
          status: "closed",
          error: `Failed to start agent: ${message}`,
          updatedAt: now(),
        })
        throw new RunActionError("launch_failed", message)
      }

      db.insert(agents)
        .values({
          id: mainAgentId,
          runId,
          role: "main",
          parentAgentId: null,
          status: "running",
          sessionFile: agentSession.sessionFile ?? null,
          name: null,
          task: null,
          createdAt: ts,
          startedAt: ts,
          updatedAt: ts,
        })
        .run()

      contexts.set(runId, {
        containerName: name,
        workspaceHostPath: wsAbs,
        sessionsDir: sessAbs,
        modelRuntime,
        sdkModel,
        thinkingLevel: input.thinkingLevel,
        childTemplate: templates.childSystemPromptTemplate,
        promptContext,
        caps,
        challengeId: challenge.id,
      })
      sessions.set(runId, agentSession)
      emitRun(runId)
      emitAgents(runId)

      // Fire the bootstrap prompt; the run settles (idle/closed) on resolution.
      driveRun(runId, initialPrompt)
      return requireRun(runId)
    })
  }

  /** Esc: abort the current turn. It settles to idle; the container is kept. */
  function stop(runId: string): Promise<RunPublic> {
    return withLock(runId, async () => {
      const run = requireRun(runId)
      if (run.status !== "running") {
        throw new RunActionError("invalid_state", "Run is not running")
      }
      const agentSession = sessions.get(runId)
      if (agentSession)
        await agentSession.session.abort().catch(() => undefined)
      return requireRun(runId)
    })
  }

  /** Force-finish (HTTP /finish): mark done + release resources. */
  function finish(runId: string, summary: string): Promise<RunPublic> {
    return withLock(runId, async () => {
      const run = requireRun(runId)
      if (run.status === "closed") {
        throw new RunActionError("invalid_state", "Run is already closed")
      }
      pending.set(runId, { mode: "finish", summary })
      const agentSession = sessions.get(runId)
      if (agentSession?.session.isStreaming) {
        await agentSession.session.abort().catch(() => undefined)
      } else {
        freeRun(runId, { summary, finished: true })
        pending.delete(runId)
      }
      return requireRun(runId)
    })
  }

  /**
   * Ensure a run has a live session + warm container. No-op if already warm;
   * cold-restores a closed run from its jsonl (SessionManager.open) with a
   * fresh container. Does not drive a turn — the caller prompts afterwards.
   */
  async function ensureWarm(runId: string): Promise<void> {
    if (sessions.has(runId)) return
    const row = queries.getRow(runId)
    if (!row) throw new RunActionError("not_found", "Run not found")
    const mainAgent = queries.mainAgent(runId)
    if (!mainAgent?.sessionFile) {
      throw new RunActionError("invalid_state", "Run has no session to restore")
    }
    const settings = options.getSettings()
    const wsAbs = workspaceAbs(runId)
    const sessAbs = sessionsAbs(runId)
    const rtAbs = runtimeAbs(runId)
    mkdirSync(rtAbs, { recursive: true })

    const modelRuntime = await createRunModelRuntime({
      runtimeDir: rtAbs,
      providers: providers(),
    })
    // Resolve the model from the snapshot stored on the run row.
    const provider = providers().find((p) => p.label === row.providerLabel)
    const sdkModel = provider
      ? resolveRunModel(modelRuntime, provider, row.modelId)
      : undefined
    if (!sdkModel) {
      throw new RunStartError("Could not resolve the run's model for restore")
    }

    try {
      await containerManager.create({
        name: row.containerName,
        image: row.image,
        workingDir: settings["container.workspace"],
        binds: [`${wsAbs}:${settings["container.workspace"]}`],
        limits: {
          cpus: row.cpus,
          memoryMb: row.memoryMb,
          pidsLimit: row.pidsLimit,
        },
        tmpfsSize: settings["container.tmpfsSize"],
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new RunActionError("launch_failed", message)
    }

    const bashDef = createBashToolDefinition(wsAbs, {
      operations: createContainerBashOperations(
        row.containerName,
        containerManager
      ),
    })
    // Re-render prompts for the restored run (attachments + capabilities).
    const challenge = db
      .select()
      .from(challenges)
      .where(eq(challenges.id, row.challengeId))
      .get()
    if (!challenge) throw new RunActionError("not_found", "Challenge not found")
    const remote = getChallengeRemote(db, row.challengeId)
    const templates = resolvePromptTemplates(settings)
    const promptContext = buildPromptContext(
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
    const caps: ToolCapabilities = {
      canSubmitFlag: promptContext.capabilities.canSubmitFlag,
      canManageTarget: promptContext.capabilities.canManageTarget,
      canSpawnAgent: true,
    }
    const toolCtx: RunToolContext = {
      runId,
      challengeId: row.challengeId,
      agentId: mainAgent.id,
      submitFlag: (flag) =>
        platformService
          .submitFlag(runId, row.challengeId, flag)
          .then((r) => r ?? null),
      targetAction: (action) =>
        platformService.targetAction(row.challengeId, action),
      requestFinish: (summary) =>
        pending.set(runId, { mode: "finish", summary }),
      spawnChild: (childInput) => spawnChild(runId, mainAgent.id, childInput),
      hasAcceptedFlag: () => Promise.resolve(queries.hasAcceptedFlag(runId)),
      getAgent: (agentId) =>
        queries.listAgents(runId).find((a) => a.id === agentId),
      lastAssistantText: (agentId) => lastAssistantText(runId, agentId),
    }
    const nativeTools = createMainTools(toolCtx, caps)
    const workspaceTools = createWorkspaceTools(
      createDockerExecBackend(row.containerName, containerManager)
    )
    const customTools = [
      bashDef,
      ...workspaceTools,
      ...nativeTools,
    ] as ToolDefinition[]
    const toolNames = [
      "read",
      "bash",
      "edit",
      "write",
      "grep",
      "find",
      "ls",
      ...nativeTools.map((tool) => tool.name),
    ]

    let agentSession: RunAgentSession
    try {
      agentSession = await createRunAgentSession({
        runId,
        agentId: mainAgent.id,
        workspaceHostPath: wsAbs,
        sessionsDir: sessAbs,
        sessionFile: mainAgent.sessionFile,
        modelRuntime,
        model: sdkModel,
        thinkingLevel: row.thinkingLevel as ThinkingLevel,
        agentSettings: agentSettings(),
        systemPrompt: renderSystemPrompt(
          templates.mainSystemPromptTemplate,
          promptContext
        ),
        toolNames,
        customTools,
        db,
        bus,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      clearForceKill(runId)
      terminateContainer(runId, row.containerName)
      throw new RunActionError("launch_failed", message)
    }

    contexts.set(runId, {
      containerName: row.containerName,
      workspaceHostPath: wsAbs,
      sessionsDir: sessAbs,
      modelRuntime,
      sdkModel,
      thinkingLevel: row.thinkingLevel as ThinkingLevel,
      childTemplate: templates.childSystemPromptTemplate,
      promptContext,
      caps,
      challengeId: row.challengeId,
    })
    sessions.set(runId, agentSession)
  }

  /**
   * Unified message entry. Streaming → steer/followUp (queue into the current
   * turn). Idle/closed → drive a new turn (cold-restoring a closed run first).
   */
  function sendMessage(
    runId: string,
    input: SendMessageInput
  ): Promise<RunPublic> {
    return withLock(runId, async () => {
      const run = requireRun(runId)
      if (run.status === "closed") await ensureWarm(runId)
      const agentSession = sessions.get(runId)
      if (!agentSession)
        throw new RunActionError("invalid_state", "Run has no active session")
      if (agentSession.session.isStreaming) {
        if (input.deliverAs === "followUp") {
          await agentSession.session.followUp(input.text)
        } else {
          await agentSession.session.steer(input.text)
        }
        return requireRun(runId)
      }
      pending.delete(runId)
      driveRun(runId, input.text)
      return requireRun(runId)
    })
  }

  /**
   * Manually release a run's container + session (→ closed). Keeps jsonl so the
   * run can be cold-restored by messaging it. A streaming turn is aborted first
   * and freed when it settles.
   */
  function closeRun(runId: string): Promise<RunPublic> {
    return withLock(runId, async () => {
      const run = requireRun(runId)
      if (run.status === "closed") {
        throw new RunActionError("invalid_state", "Run is already closed")
      }
      const agentSession = sessions.get(runId)
      if (agentSession?.session.isStreaming) {
        pending.set(runId, { mode: "close" })
        await agentSession.session.abort().catch(() => undefined)
      } else {
        freeRun(runId)
      }
      return requireRun(runId)
    })
  }

  async function deleteRun(runId: string) {
    await withLock(runId, async () => {
      const row = queries.getRow(runId)
      if (!row) throw new RunActionError("not_found", "Run not found")
      const agentSession = sessions.get(runId)
      if (agentSession?.session.isStreaming) {
        await agentSession.session.abort().catch(() => undefined)
      }
      clearForceKill(runId)
      await containerManager.remove(row.containerName).catch(() => undefined)
      abortChildSessions(runId)
      if (agentSession) {
        void agentSession.dispose()
        sessions.delete(runId)
      }
      contexts.delete(runId)
      turnGeneration.delete(runId)
      pending.delete(runId)
      rmSync(runDir(runId), { recursive: true, force: true })
      db.delete(runs).where(eq(runs.id, runId)).run()
    })
  }

  function listMessages(
    runId: string,
    opts: { after?: number; agentId?: string }
  ): MessageList {
    const after = opts.after ?? 0
    const conditions = [
      eq(runEvents.runId, runId),
      gt(runEvents.seq, after),
    ] as const
    const rows = opts.agentId
      ? db
          .select()
          .from(runEvents)
          .where(and(...conditions, eq(runEvents.agentId, opts.agentId)))
          .orderBy(runEvents.seq)
          .all()
      : db
          .select()
          .from(runEvents)
          .where(and(...conditions))
          .orderBy(runEvents.seq)
          .all()
    const items = rows
      .map(rowToMessage)
      .filter((message): message is Message => message !== null)
    return {
      items,
      nextAfter: items.length > 0 ? items[items.length - 1].seq : after,
    }
  }

  function mainSessionFor(runId: string) {
    return sessions.get(runId)
  }

  /**
   * Start a background child agent for spawn_agent. Resolves immediately with
   * the new agent; the child runs to completion in the background and its
   * result is delivered to the parent (steer while streaming, else a new turn).
   */
  async function spawnChild(
    runId: string,
    parentAgentId: string,
    input: { name: string; task: string }
  ): Promise<{ agentId: string; name: string; status: string }> {
    const ctx = contexts.get(runId)
    if (!ctx) throw new RunActionError("invalid_state", "Run context missing")
    const activeChildren = queries
      .listAgents(runId)
      .filter((a) => a.role === "child" && a.status === "running").length
    if (activeChildren >= MAX_CHILDREN_PER_RUN) {
      throw new RunActionError(
        "invalid_state",
        `A child agent is already running for this run (limit ${MAX_CHILDREN_PER_RUN}). Wait for it to finish before spawning another.`
      )
    }

    const childAgentId = crypto.randomUUID()
    const childName = input.name.trim() || "Child agent"
    const ts = now()
    db.insert(agents)
      .values({
        id: childAgentId,
        runId,
        role: "child",
        parentAgentId,
        status: "running",
        sessionFile: null,
        name: childName,
        task: input.task,
        createdAt: ts,
        startedAt: ts,
        updatedAt: ts,
      })
      .run()
    emitAgents(runId)

    const childSystemPrompt = renderSystemPrompt(ctx.childTemplate, {
      ...ctx.promptContext,
      agent: {
        role: "child",
        isMain: false,
        name: childName,
        task: input.task,
      },
    })
    const bashDef = createBashToolDefinition(ctx.workspaceHostPath, {
      operations: createContainerBashOperations(
        ctx.containerName,
        containerManager
      ),
    })
    const workspaceTools = createWorkspaceTools(
      createDockerExecBackend(ctx.containerName, containerManager)
    )
    // Children: coding tools only (no finish/flag/target/spawn).
    const toolNames = ["read", "bash", "edit", "write", "grep", "find", "ls"]

    let childSession: RunAgentSession
    try {
      childSession = await createRunAgentSession({
        runId,
        agentId: childAgentId,
        workspaceHostPath: ctx.workspaceHostPath,
        sessionsDir: ctx.sessionsDir,
        modelRuntime: ctx.modelRuntime,
        model: ctx.sdkModel,
        thinkingLevel: ctx.thinkingLevel,
        agentSettings: agentSettings(),
        systemPrompt: childSystemPrompt,
        toolNames,
        customTools: [bashDef, ...workspaceTools] as ToolDefinition[],
        db,
        bus,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      updateAgent(childAgentId, {
        status: "failed",
        error: message,
        completedAt: now(),
        updatedAt: now(),
      })
      emitAgents(runId)
      throw new RunActionError("launch_failed", message)
    }
    childSessions.set(childAgentId, childSession)
    updateAgent(childAgentId, { sessionFile: childSession.sessionFile ?? null })
    emitAgents(runId)

    // Run to completion in the background; deliver the result to the parent.
    void runChildInBackground(
      runId,
      parentAgentId,
      childAgentId,
      childName,
      input.task,
      childSession
    )

    return { agentId: childAgentId, name: childName, status: "running" }
  }

  /** Drive a child agent to completion, then deliver its result to the parent. */
  async function runChildInBackground(
    runId: string,
    parentAgentId: string,
    childAgentId: string,
    childName: string,
    task: string,
    childSession: RunAgentSession
  ): Promise<void> {
    let runError: string | null = null
    try {
      await childSession.session.prompt(task)
    } catch (error) {
      runError = error instanceof Error ? error.message : String(error)
    }
    const settled = now()
    const summary =
      childSession.session.getLastAssistantText() ??
      (runError ? `Child failed: ${runError}` : "Child completed.")
    const status = runError ? "failed" : "completed"
    updateAgent(childAgentId, {
      status,
      completedAt: settled,
      updatedAt: settled,
      ...(runError ? { error: runError } : {}),
    })
    void childSession.dispose()
    childSessions.delete(childAgentId)
    emitAgents(runId)
    deliverChildResult(
      runId,
      parentAgentId,
      childAgentId,
      childName,
      status,
      summary,
      runError
    )
  }

  /**
   * Deliver a finished child's result to its parent agent. While the parent is
   * streaming, steer into the current turn; when idle, drive a fresh turn
   * (steer is queue-only and never starts a loop on its own).
   */
  function deliverChildResult(
    runId: string,
    parentAgentId: string,
    childAgentId: string,
    childName: string,
    status: string,
    summary: string,
    error: string | null
  ): void {
    const mainSession = sessions.get(runId)
    if (!mainSession) return // run closed/gone
    const text = [
      `Background agent ${childName} (${childAgentId}) ${status}.`,
      "",
      "Final output:",
      summary,
      ...(error ? ["", `Error: ${error}`] : []),
    ].join("\n")
    if (mainSession.session.isStreaming) {
      void mainSession.session.steer(text).catch(() => undefined)
    } else {
      driveRun(runId, text)
    }
  }

  /** Latest assistant text for an agent (inspect_agent). */
  function lastAssistantText(runId: string, agentId: string): string | null {
    const list = listMessages(runId, { agentId })
    for (let index = list.items.length - 1; index >= 0; index -= 1) {
      const message = list.items[index]
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

  /** Abort + dispose any in-flight child sessions belonging to a run. */
  function abortChildSessions(runId: string): void {
    for (const child of queries.listAgents(runId)) {
      if (child.role !== "child") continue
      const session = childSessions.get(child.id)
      if (!session) continue
      void session.session.abort().catch(() => undefined)
      void session.dispose()
      childSessions.delete(child.id)
    }
  }

  async function recoverOnBoot() {
    const rows = db.select().from(runs).all()
    for (const row of rows) {
      if (row.status === "closed") continue
      // running/idle held live resources that are gone after a crash. Reclaim
      // any orphan container; the jsonl stays so the run is cold-restorable.
      await containerManager.remove(row.containerName).catch(() => undefined)
      const ts = now()
      updateRun(row.id, { status: "closed", updatedAt: ts })
      const mainAgent = queries.mainAgent(row.id)
      if (mainAgent)
        updateAgent(mainAgent.id, { status: "idle", updatedAt: ts })
    }
  }

  async function close() {
    closed = true
    await Promise.allSettled([...locks.values()])
    locks.clear()
    for (const timer of forceKillTimers.values()) clearTimeout(timer)
    forceKillTimers.clear()
    for (const agentSession of sessions.values()) await agentSession.dispose()
    for (const childSession of childSessions.values())
      await childSession.dispose()
    sessions.clear()
    childSessions.clear()
    pending.clear()
    turnGeneration.clear()
    bus.close()
  }

  return {
    create,
    stop,
    finish,
    sendMessage,
    closeRun,
    delete: deleteRun,
    refresh: queries.get,
    recoverOnBoot,
    close,
    listMessages,
    mainSessionFor,
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
