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

type PendingOutcome = { mode: "finish"; summary: string } | { mode: "stop" }

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

export type SteerInput = {
  text: string
  deliverAs: "steer" | "followUp"
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
   * Drive one prompt() to completion, then finalize the run. The agent loop
   * resolves on natural end, after a tool requests finish (terminate), or after
   * an abort (stop). Finalize is the single completion point.
   */
  function driveRun(runId: string, text: string) {
    const agentSession = sessions.get(runId)
    if (!agentSession) return
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
        finalize(runId, typeof error === "string" ? error : null)
      )
  }

  function finalize(runId: string, runError: string | null) {
    void withLock(runId, () => {
      const row = queries.getRow(runId)
      if (!row || row.status !== "running") return
      const outcome = pending.get(runId)
      pending.delete(runId)
      const ts = now()
      let status: string
      let summary: string | null = row.summary
      let error: string | null = null
      if (outcome?.mode === "finish") {
        status = "completed"
        if (outcome.summary) summary = outcome.summary
      } else if (outcome?.mode === "stop") {
        status = "stopped"
      } else if (runError) {
        status = "failed"
        error = runError
      } else {
        // Agent went idle without an explicit finish — treat as completed.
        status = "completed"
      }
      updateRun(runId, {
        status,
        summary,
        error,
        completedAt: ts,
        updatedAt: ts,
      })
      // Mark the main agent row.
      const mainAgent = queries.mainAgent(runId)
      if (mainAgent) {
        updateAgent(mainAgent.id, {
          status:
            status === "completed"
              ? "completed"
              : status === "stopped"
                ? "stopped"
                : "failed",
          completedAt: ts,
          updatedAt: ts,
          error,
        })
      }
      clearForceKill(runId)
      terminateContainer(runId, containerName(runId))
      const agentSession = sessions.get(runId)
      if (agentSession) {
        void agentSession.dispose()
        sessions.delete(runId)
      }
      contexts.delete(runId)
      emitRun(runId)
      emitAgents(runId)
    })
  }

  function providers(): ProviderConnection[] {
    return getProviderConnections(configStore)
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
        submitFlag: (flag) =>
          platformService
            .submitFlag(runId, challenge.id, flag)
            .then((r) => r ?? null),
        targetAction: (action) =>
          platformService.targetAction(challenge.id, action),
        requestFinish: (summary) =>
          pending.set(runId, { mode: "finish", summary }),
        spawnChild: (childInput) => spawnChild(runId, mainAgentId, childInput),
      }
      const nativeTools = createMainTools(ctx, caps)
      const bashDef = createBashToolDefinition(wsAbs, {
        operations: createContainerBashOperations(name, containerManager),
      })
      const customTools = [bashDef, ...nativeTools] as ToolDefinition[]
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
          systemPrompt: mainSystemPrompt,
          toolNames,
          customTools,
          db,
          bus,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        terminateContainer(runId, name)
        updateRun(runId, {
          status: "failed",
          error: `Failed to start agent: ${message}`,
          completedAt: now(),
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

      // Fire the bootstrap prompt; finalize on resolution.
      driveRun(runId, initialPrompt)
      return requireRun(runId)
    })
  }

  function stop(runId: string) {
    return withLock(runId, async () => {
      const run = requireRun(runId)
      if (run.status !== "running") {
        throw new RunActionError("invalid_state", "Run is not running")
      }
      pending.set(runId, { mode: "stop" })
      const agentSession = sessions.get(runId)
      if (agentSession) void agentSession.session.abort().catch(() => undefined)
      return requireRun(runId)
    })
  }

  function finish(runId: string, summary: string) {
    return withLock(runId, async () => {
      const run = requireRun(runId)
      if (run.status !== "running") {
        throw new RunActionError("invalid_state", "Run is not running")
      }
      pending.set(runId, { mode: "finish", summary })
      const agentSession = sessions.get(runId)
      if (agentSession) void agentSession.session.abort().catch(() => undefined)
      return requireRun(runId)
    })
  }

  function steer(runId: string, input: SteerInput): Promise<RunPublic> {
    return withLock(runId, async () => {
      const run = requireRun(runId)
      if (run.status !== "running") {
        throw new RunActionError("invalid_state", "Run is not running")
      }
      const agentSession = sessions.get(runId)
      if (!agentSession)
        throw new RunActionError("invalid_state", "Run has no active session")
      if (input.deliverAs === "steer") {
        await agentSession.session.steer(input.text)
      } else {
        await agentSession.session.followUp(input.text)
      }
      return requireRun(runId)
    })
  }

  function resume(runId: string) {
    return withLock(runId, async () => {
      const row = queries.getRow(runId)
      if (!row) throw new RunActionError("not_found", "Run not found")
      if (row.status === "running") {
        throw new RunActionError("invalid_state", "Run is already running")
      }
      const mainAgent = queries.mainAgent(runId)
      if (!mainAgent?.sessionFile) {
        throw new RunActionError(
          "invalid_state",
          "Run has no session to resume"
        )
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
        throw new RunStartError("Could not resolve the run's model for resume")
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
      // Re-render prompts for the resumed run (attachments + capabilities).
      const challenge = db
        .select()
        .from(challenges)
        .where(eq(challenges.id, row.challengeId))
        .get()
      if (!challenge)
        throw new RunActionError("not_found", "Challenge not found")
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
        submitFlag: (flag) =>
          platformService
            .submitFlag(runId, row.challengeId, flag)
            .then((r) => r ?? null),
        targetAction: (action) =>
          platformService.targetAction(row.challengeId, action),
        requestFinish: (summary) =>
          pending.set(runId, { mode: "finish", summary }),
        spawnChild: (childInput) => spawnChild(runId, mainAgent.id, childInput),
      }
      const nativeTools = createMainTools(toolCtx, caps)
      const customTools = [bashDef, ...nativeTools] as ToolDefinition[]
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
      const ts = now()
      updateRun(runId, {
        status: "running",
        startedAt: ts,
        completedAt: null,
        error: null,
        updatedAt: ts,
      })
      updateAgent(mainAgent.id, {
        status: "running",
        startedAt: ts,
        completedAt: null,
        error: null,
        updatedAt: ts,
      })
      emitRun(runId)
      emitAgents(runId)
      // Continue the same session (empty nudge to pick up where it left off).
      driveRun(runId, "Continue from where you left off.")
      return requireRun(runId)
    })
  }

  async function deleteRun(runId: string) {
    await withLock(runId, async () => {
      const row = queries.getRow(runId)
      if (!row) throw new RunActionError("not_found", "Run not found")
      if (row.status === "running") {
        throw new RunActionError(
          "invalid_state",
          "Stop the run before deleting it"
        )
      }
      await containerManager.remove(row.containerName)
      const agentSession = sessions.get(runId)
      if (agentSession) {
        void agentSession.dispose()
        sessions.delete(runId)
      }
      contexts.delete(runId)
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

  /** Create + run a child agent for spawn_agent. Blocks the calling tool. */
  async function spawnChild(
    runId: string,
    parentAgentId: string,
    input: { task: string; name?: string }
  ): Promise<{
    summary: string
    agentId: string
    status: string
    messageCount: number
    error?: string
  }> {
    const ctx = contexts.get(runId)
    if (!ctx) throw new RunActionError("invalid_state", "Run context missing")
    const activeChildren = queries
      .listAgents(runId)
      .filter((a) => a.role === "child" && a.status === "running").length
    if (activeChildren >= MAX_CHILDREN_PER_RUN) {
      return {
        summary: `A child agent is already running for this run (limit ${MAX_CHILDREN_PER_RUN}). Wait for it to finish before spawning another.`,
        agentId: "",
        status: "rejected",
        messageCount: 0,
        error: "concurrency_limit",
      }
    }

    const childAgentId = crypto.randomUUID()
    const childName = input.name?.trim() || "Child agent"
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
        systemPrompt: childSystemPrompt,
        toolNames,
        customTools: [bashDef] as ToolDefinition[],
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
      return {
        summary: `Failed to start child agent: ${message}`,
        agentId: childAgentId,
        status: "failed",
        messageCount: 0,
        error: message,
      }
    }
    childSessions.set(childAgentId, childSession)
    updateAgent(childAgentId, { sessionFile: childSession.sessionFile ?? null })
    emitAgents(runId)

    let runError: string | null = null
    try {
      await childSession.session.prompt(input.task)
    } catch (error) {
      runError = error instanceof Error ? error.message : String(error)
    }

    const settled = now()
    const summary =
      (await childSession.session.getLastAssistantText()) ??
      (runError ? `Child failed: ${runError}` : "Child completed.")
    const status = runError ? "failed" : "completed"
    const messageCount = queries.messageCount(runId, childAgentId)
    updateAgent(childAgentId, {
      status,
      completedAt: settled,
      updatedAt: settled,
      ...(runError ? { error: runError } : {}),
    })
    void childSession.dispose()
    childSessions.delete(childAgentId)
    emitAgents(runId)
    return {
      summary,
      agentId: childAgentId,
      status,
      messageCount,
      ...(runError ? { error: runError } : {}),
    }
  }

  async function recoverOnBoot() {
    const rows = db.select().from(runs).all()
    for (const row of rows) {
      if (row.status !== "running") continue
      const running = await containerManager.isRunning(row.containerName)
      // Never auto-call the model on recovery (single-user, explicit resume).
      if (running)
        await containerManager
          .kill(row.containerName, "SIGKILL")
          .catch(() => undefined)
      const ts = now()
      updateRun(row.id, {
        status: "stopped",
        completedAt: ts,
        updatedAt: ts,
      })
      const mainAgent = queries.mainAgent(row.id)
      if (mainAgent) {
        updateAgent(mainAgent.id, {
          status: "stopped",
          completedAt: ts,
          updatedAt: ts,
        })
      }
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
    bus.close()
  }

  return {
    create,
    stop,
    finish,
    resume,
    steer,
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
