import { mkdirSync, rmSync } from "node:fs"
import { join, relative } from "node:path"
import { clampThinkingLevel } from "@earendil-works/pi-ai"
import { eq } from "drizzle-orm"
import type {
  AgentPublic,
  AgentStatus,
  AgentSummary,
  RunPublic,
  RunStatus,
} from "../../../shared"
import { sumUsage } from "../agents/usage"
import type { createDatabase } from "../db"
import {
  agentInbox,
  challenges,
  runAgents,
  runEvents,
  runs,
} from "../db/schema"
import type { SettingsPublic } from "../infrastructure/config-store"
import { containerName, removeContainer } from "../infrastructure/container"
import { getChallengeRemote } from "../platforms/challenge-state"
import type { TargetState } from "../platforms/core"
import type { ModelService } from "../providers/models"
import {
  type PromptTemplates,
  renderInitialPrompt,
} from "../settings/prompt-templates"
import {
  type EnvironmentConfig,
  type ModelConfig,
  parseEnvironment,
  parseModelConfig,
  parseRuntimeSnapshot,
} from "./config"
import { createContainerPool } from "./container-pool"
import { RunActionError, RunStartError } from "./errors"
import { createRunEventBus, type RunEventBus } from "./events"
import { createRunInspector } from "./inspector"
import { createSettledHandlers } from "./lifecycle"
import { createPromptContextBuilder } from "./prompt-context"
import { recoverInterruptedRuns } from "./recovery"
import { createRunRepository } from "./repository"
import { createRunHandleRegistry } from "./run-handle"
import { createSessionAttacher, createSessionRegistry } from "./session"
import { createRunStateStore } from "./state-store"
import { createRunTools } from "./tools"

type Database = ReturnType<typeof createDatabase>["db"]
type Options = {
  db: Database
  dataDir: string
  maxConcurrency: number
  modelService: ModelService
  getSettings(): SettingsPublic
  getPromptTemplates(): PromptTemplates
  getApiKeys?: (provider: string) => Iterable<string>
  submitFlag?(
    runId: string,
    challengeId: string,
    flag?: string,
    signal?: AbortSignal
  ): Promise<unknown>
  canFinishRun?(runId: string, challengeId: string): boolean
  targetAction?(
    challengeId: string,
    action: "get" | "start" | "extend" | "stop",
    signal?: AbortSignal
  ): Promise<TargetState>
}

const terminalRunStatuses: RunStatus[] = ["completed", "failed", "stopped"]
const terminalAgentStatuses: AgentStatus[] = ["completed", "failed", "stopped"]
const defaultResumeMessage =
  "Continue solving the challenge from the current state."

export function createRunManager(options: Options) {
  const { db, dataDir } = options
  let maxConcurrency = options.maxConcurrency
  let closed = false

  const sessions = createSessionRegistry()
  const handles = createRunHandleRegistry({ isClosed: () => closed })
  const withRunLock = handles.withLock

  for (const id of recoverInterruptedRuns(db))
    removeContainer(containerName(id))

  const containers = createContainerPool({
    dataDir,
    onFailure: (runId) => {
      void sessions.abortRun(runId)
    },
  })

  const {
    buildPromptContext,
    promptContextForAgent,
    attachmentFiles,
    copyAttachments,
  } = createPromptContextBuilder({
    db,
    dataDir,
    getContainerWorkspace: () => options.getSettings().containerWorkspace,
  })
  const prompts = {
    buildPromptContext,
    promptContextForAgent,
    attachmentFiles,
    copyAttachments,
  }

  const repo = createRunRepository(db)
  const {
    getStored,
    getStoredAgent,
    getMainAgent,
    listStoredAgents,
    cursor,
    runningCount,
    getAgentPublic,
    getPublic,
  } = repo

  function replayedMessage(
    runId: string,
    kind: "user" | "resume" | Array<"user" | "resume">,
    content: string,
    messageId?: string
  ) {
    if (!messageId) return undefined
    const existing = db
      .select()
      .from(agentInbox)
      .where(eq(agentInbox.id, messageId))
      .get()
    if (!existing) return undefined
    const main = getMainAgent(runId)
    const allowedKinds = Array.isArray(kind) ? kind : [kind]
    if (
      !main ||
      existing.agentId !== main.id ||
      !allowedKinds.includes(existing.kind as "user" | "resume") ||
      existing.content !== content ||
      existing.metadata !== null
    ) {
      throw new RunActionError(
        "message_id_conflict",
        "Message ID conflicts with an existing message"
      )
    }
    const run = getPublic(runId)
    if (!run) throw new RunActionError("not_found", "Run not found")
    return { ...run, messageId }
  }

  const {
    messagesForAgent,
    conversationMessage,
    conversationSnapshot,
    conversationMessageForRuntime,
    usageForAgent,
    inspectorForAgent,
  } = createRunInspector({
    db,
    dataDir,
    getStoredRun: getStored,
    getStoredAgent,
    getAgentPublic,
    parseModelConfig,
    parseRuntimeSnapshot,
  })

  const eventBus: RunEventBus = createRunEventBus({
    db,
    getRun: getPublic,
    getAgent: getAgentPublic,
    getAgentUsage: usageForAgent,
    conversationMessage,
  })
  const emit = eventBus.emit

  const {
    transition: transitionRun,
    update,
    updateAgent,
  } = createRunStateStore({
    db,
    getRun: getPublic,
    getAgent: getStoredAgent,
    getPublicAgent: getAgentPublic,
    getAgentUsage: usageForAgent,
    emitRun: (runId, run, cursorValue) =>
      emit(runId, { type: "run.updated", run, cursor: cursorValue }),
    emitAgent: (runId, agent, usage, cursorValue) =>
      emit(runId, {
        type: "agent.updated",
        agent: { ...agent, usage },
        cursor: cursorValue,
      }),
  })

  function releaseAgent(agentId: string) {
    sessions.release(agentId)
  }

  async function releaseRun(runId: string) {
    sessions.releaseRun(runId)
    await containers.release(runId)
  }

  async function abortRun(runId: string, exceptAgentId?: string) {
    await sessions.abortRun(runId, exceptAgentId)
  }

  const { handleMainSettled, handleChildSettled, notifyMain } =
    createSettledHandlers({
      db,
      handles,
      isClosed: () => closed,
      withRunLock,
      getStored,
      getStoredAgent,
      getMainAgent,
      listStoredAgents,
      takeContainerFailure: (runId) => containers.takeFailure(runId),
      abortRun,
      releaseRun,
      releaseAgent,
      transitionRun,
      updateAgent,
      getMainRuntime: (agentId) => sessions.get(agentId)?.runtime,
    })

  function requireCapacity(count = 1) {
    if (runningCount() + count > maxConcurrency) {
      throw new RunActionError("capacity", "Run capacity reached")
    }
  }

  async function resolveRequestedModel(config: ModelConfig) {
    const model = options.modelService.find(config.provider, config.modelId)
    if (!model) {
      throw new RunStartError("Requested model is unavailable")
    }
    if (!(await options.modelService.models.getAuth(model))) {
      throw new RunStartError(
        "Credentials for the requested model are unavailable"
      )
    }
    return model
  }

  function runWorkspacePath(run: typeof runs.$inferSelect) {
    if (!run.workspacePath)
      throw new RunStartError("Run workspace is unavailable")
    return join(dataDir, run.workspacePath)
  }

  // createChildAgent is assigned after attachSession wiring to break the cycle.
  let createChildAgent: (
    runId: string,
    parentAgentId: string,
    name: string,
    task: string,
    signal?: AbortSignal
  ) => Promise<AgentPublic>

  const { attachSession, ensureSession } = createSessionAttacher({
    db,
    dataDir,
    sessions,
    containers,
    modelService: options.modelService,
    getSettings: options.getSettings,
    getApiKeys: options.getApiKeys,
    getStored,
    getStoredAgent,
    getAgentPublic,
    messagesForAgent,
    conversationMessageForRuntime,
    update,
    emit,
    prompts,
    createChildAgent: (...args) => createChildAgent(...args),
    canFinishRun: options.canFinishRun,
    submitFlag: options.submitFlag,
    targetAction: options.targetAction,
    onMainSettled: handleMainSettled,
    onChildSettled: handleChildSettled,
    resolveRequestedModel,
    createTools: createRunTools,
  })

  createChildAgent = async function createChildAgentImpl(
    runId: string,
    parentAgentId: string,
    name: string,
    task: string,
    signal?: AbortSignal
  ) {
    const run = getStored(runId)
    const parent = getStoredAgent(parentAgentId)
    const challenge = run
      ? db
          .select()
          .from(challenges)
          .where(eq(challenges.id, run.challengeId))
          .get()
      : undefined
    if (
      run?.status !== "running" ||
      !challenge ||
      !parent ||
      parent.runId !== runId ||
      parent.parentAgentId !== null
    ) {
      throw new RunActionError(
        "invalid_state",
        "Run state does not allow a child agent"
      )
    }
    if (!run.workspacePath) {
      throw new RunActionError("invalid_state", "Run workspace is unavailable")
    }
    requireCapacity()
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    const workspacePath = runWorkspacePath(run)
    let cursorValue: number | undefined
    db.transaction((tx) => {
      tx.insert(runAgents)
        .values({
          id,
          runId,
          parentAgentId,
          name,
          task,
          status: "running",
          createdAt: now,
          startedAt: now,
          updatedAt: now,
        })
        .run()
      cursorValue = tx
        .insert(runEvents)
        .values({
          runId,
          type: "agent_updated",
          agentId: id,
          entityId: id,
          createdAt: now,
        })
        .returning({ id: runEvents.id })
        .get()?.id
    })
    emit(runId, {
      type: "agent.updated",
      agent: {
        ...(getAgentPublic(id) as AgentPublic),
        usage: usageForAgent(id),
      },
      cursor: cursorValue,
    })

    const requireRunning = () => {
      if (
        signal?.aborted ||
        getStored(runId)?.status !== "running" ||
        getStoredAgent(id)?.status !== "running"
      ) {
        throw new RunStartError("Child agent start was interrupted")
      }
    }

    try {
      const modelConfig = parseModelConfig(run.modelConfig)
      const model = await resolveRequestedModel(modelConfig)
      requireRunning()
      const agent = getStoredAgent(id) as typeof runAgents.$inferSelect
      const runtime = await attachSession(
        agent,
        run,
        workspacePath,
        model,
        parseEnvironment(run.environmentConfig),
        modelConfig.provider
      )
      if (
        signal?.aborted ||
        getStored(runId)?.status !== "running" ||
        getStoredAgent(id)?.status !== "running"
      ) {
        await runtime.abort()
        releaseAgent(id)
        throw new RunStartError("Child agent start was interrupted")
      }
      runtime.dispatch("user", task)
      return getAgentPublic(id) as AgentPublic
    } catch (error) {
      if (
        !handles.isAborting(runId) &&
        getStored(runId)?.status === "running" &&
        getStoredAgent(id)?.status === "running"
      ) {
        updateAgent(id, {
          status: "failed",
          completedAt: new Date().toISOString(),
          error:
            error instanceof RunStartError
              ? error.message
              : "Agent session failed",
        })
      }
      releaseAgent(id)
      throw error
    }
  }

  async function create(
    challengeId: string,
    modelConfig: ModelConfig,
    environment: EnvironmentConfig = { type: "local" }
  ) {
    const challenge = db
      .select()
      .from(challenges)
      .where(eq(challenges.id, challengeId))
      .get()
    if (!challenge) throw new RunActionError("not_found", "Challenge not found")
    const remote = getChallengeRemote(db, challengeId)
    requireCapacity()
    const configuredModel = options.modelService.find(
      modelConfig.provider,
      modelConfig.modelId
    )
    const frozenModelConfig = {
      ...modelConfig,
      thinkingLevel: configuredModel
        ? clampThinkingLevel(configuredModel, modelConfig.thinkingLevel)
        : "off",
    }

    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    const workspacePath = join(dataDir, "workspaces", id)
    mkdirSync(workspacePath, { recursive: true })
    const challengeAttachments = copyAttachments(challengeId, workspacePath)
    const promptTemplates = options.getPromptTemplates()
    const promptContext = buildPromptContext(
      id,
      challenge,
      remote,
      challengeAttachments,
      environment,
      frozenModelConfig,
      {
        name: "Main agent",
        task: null,
        isMain: true,
      }
    )
    const prompt = renderInitialPrompt(
      promptTemplates.initialPromptTemplate,
      promptContext
    )
    db.transaction((tx) => {
      tx.insert(runs)
        .values({
          id,
          challengeId,
          status: "running",
          prompt,
          promptConfig: JSON.stringify({
            ...promptTemplates,
            context: promptContext,
          }),
          modelConfig: JSON.stringify(frozenModelConfig),
          environmentConfig: JSON.stringify(environment),
          workspacePath: relative(dataDir, workspacePath),
          createdAt: now,
          startedAt: now,
          updatedAt: now,
        })
        .run()
      tx.insert(runAgents)
        .values({
          id,
          runId: id,
          parentAgentId: null,
          name: "Main agent",
          task: null,
          status: "running",
          createdAt: now,
          startedAt: now,
          updatedAt: now,
        })
        .run()
    })

    try {
      const model = await resolveRequestedModel(frozenModelConfig)
      const agent = getStoredAgent(id) as typeof runAgents.$inferSelect
      const run = getStored(id) as typeof runs.$inferSelect
      const runtime = await attachSession(
        agent,
        run,
        workspacePath,
        model,
        environment,
        frozenModelConfig.provider
      )
      runtime.dispatch("user", prompt)
    } catch (error) {
      await releaseRun(id)
      const completedAt = new Date().toISOString()
      const failure =
        error instanceof RunStartError ? error.message : "Agent session failed"
      transitionRun(id, { status: "failed", completedAt, error: failure }, [
        {
          agentId: id,
          values: { status: "failed", completedAt, error: failure },
        },
      ])
    }
    return getPublic(id) as RunPublic
  }

  function pause(runId: string) {
    return withRunLock(runId, () => pauseNow(runId))
  }

  async function pauseNow(runId: string) {
    requireMutable(runId, ["running"])
    handles.beginAbort(runId, "paused")
    try {
      await abortRun(runId)
      const latest = getPublic(runId) as RunPublic
      if (terminalRunStatuses.includes(latest.status)) return latest
      await releaseRun(runId)
      containers.clearFailure(runId)
      const paused = transitionRun(
        runId,
        { status: "paused" },
        listStoredAgents(runId)
          .filter(
            (agent) => agent.status === "running" || agent.status === "idle"
          )
          .map((agent) => ({
            agentId: agent.id,
            values: { status: "paused" as const },
          }))
      )
      return paused
    } finally {
      handles.endAbort(runId)
    }
  }

  function resume(
    runId: string,
    message?: string,
    requestedMessageId?: string
  ) {
    return withRunLock(runId, () =>
      resumeNow(runId, message, requestedMessageId)
    )
  }

  async function resumeNow(
    runId: string,
    message?: string,
    requestedMessageId?: string
  ) {
    const resumeMessage = message?.trim() || defaultResumeMessage
    const replay = replayedMessage(
      runId,
      "resume",
      resumeMessage,
      requestedMessageId
    )
    if (replay) return replay
    requireMutable(runId, ["paused"])
    const pausedAgents = listStoredAgents(runId).filter(
      (agent) => agent.status === "paused"
    )
    const main = pausedAgents.find((agent) => agent.parentAgentId === null)
    if (!main)
      throw new RunActionError("invalid_state", "Main agent is unavailable")
    requireCapacity(pausedAgents.length)
    containers.clearFailure(runId)
    transitionRun(
      runId,
      { status: "running", error: null, completedAt: null },
      pausedAgents.map((agent) => ({
        agentId: agent.id,
        values: {
          status: "running" as const,
          error: null,
          completedAt: null,
        },
      }))
    )
    try {
      const runtime = await ensureSession(main.id)
      runtime.replayPending()
      const messageId = runtime.dispatch(
        "resume",
        resumeMessage,
        undefined,
        requestedMessageId
      )
      for (const child of pausedAgents) {
        if (child.id === main.id) continue
        try {
          const childRuntime = await ensureSession(child.id)
          childRuntime.dispatch(
            "resume",
            "Continue the delegated task from the current state and report your final findings."
          )
        } catch (error) {
          const failed = updateAgent(child.id, {
            status: "failed",
            completedAt: new Date().toISOString(),
            error:
              error instanceof RunStartError
                ? error.message
                : "Agent session failed",
          })
          await notifyMain(failed)
        }
      }
      return { ...(getPublic(runId) as RunPublic), messageId }
    } catch (error) {
      await abortRun(runId)
      await releaseRun(runId)
      const completedAt = new Date().toISOString()
      const failure =
        error instanceof RunStartError ? error.message : "Agent session failed"
      const failed = transitionRun(
        runId,
        { status: "failed", completedAt, error: failure },
        listStoredAgents(runId).flatMap((agent) =>
          terminalAgentStatuses.includes(agent.status as AgentStatus)
            ? []
            : [
                {
                  agentId: agent.id,
                  values: {
                    status:
                      agent.id === main.id
                        ? ("failed" as const)
                        : ("stopped" as const),
                    completedAt,
                    ...(agent.id === main.id ? { error: failure } : {}),
                  },
                },
              ]
        )
      )
      return failed
    }
  }

  function message(
    runId: string,
    messageText: string,
    requestedMessageId?: string
  ) {
    return withRunLock(runId, () =>
      messageNow(runId, messageText, requestedMessageId)
    )
  }

  async function messageNow(
    runId: string,
    messageText: string,
    requestedMessageId?: string
  ) {
    const replay = replayedMessage(
      runId,
      ["user", "resume"],
      messageText,
      requestedMessageId
    )
    if (replay) return replay
    const run = requireMutable(runId, ["running", "paused"])
    if (run.status === "paused")
      return resumeNow(runId, messageText, requestedMessageId)
    const main = getMainAgent(runId)
    if (!main)
      throw new RunActionError("invalid_state", "Main agent is unavailable")
    const runtime = await ensureSession(main.id)
    if (main.status === "idle") {
      updateAgent(main.id, {
        status: "running",
        completedAt: null,
        error: null,
      })
    }
    const messageId = runtime.dispatch(
      "user",
      messageText,
      undefined,
      requestedMessageId
    )
    return { ...(getPublic(runId) as RunPublic), messageId }
  }

  function stop(runId: string) {
    return withRunLock(runId, () => stopNow(runId))
  }

  async function stopNow(runId: string) {
    requireMutable(runId, ["running", "paused"])
    handles.beginAbort(runId, "stopped")
    try {
      const completedAt = new Date().toISOString()
      const stopped = transitionRun(
        runId,
        { status: "stopped", completedAt },
        listStoredAgents(runId)
          .filter(
            (agent) =>
              !terminalAgentStatuses.includes(agent.status as AgentStatus)
          )
          .map((agent) => ({
            agentId: agent.id,
            values: { status: "stopped" as const, completedAt },
          }))
      )
      await abortRun(runId)
      await releaseRun(runId)
      containers.clearFailure(runId)
      return stopped
    } finally {
      handles.endAbort(runId)
    }
  }

  function requireMutable(runId: string, allowed: RunStatus[]) {
    const run = getPublic(runId)
    if (!run) throw new RunActionError("not_found", "Run not found")
    if (!allowed.includes(run.status)) {
      throw new RunActionError(
        "invalid_state",
        "Run state does not allow this action"
      )
    }
    return run
  }

  async function closeManager() {
    if (closed) return
    closed = true
    await handles.drain()
    const runningRuns = db
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.status, "running"))
      .all()
    for (const { id } of runningRuns) {
      handles.beginAbort(id, "paused")
      try {
        await abortRun(id)
        await releaseRun(id)
        const agents = listStoredAgents(id)
          .filter(
            (agent) => agent.status === "running" || agent.status === "idle"
          )
          .map((agent) => ({
            agentId: agent.id,
            values: { status: "paused" as const },
          }))
        transitionRun(id, { status: "paused" }, agents)
      } catch (error) {
        console.error("Run cleanup failed", {
          runId: id,
          error: error instanceof Error ? error.message : String(error),
        })
      } finally {
        handles.endAbort(id)
      }
    }
    sessions.disposeAll()
    await containers.releaseAll()
    eventBus.clear()
    handles.clear()
  }

  function deleteRun(runId: string) {
    const run = getStored(runId)
    if (!run) throw new RunActionError("not_found", "Run not found")
    if (!terminalRunStatuses.includes(run.status as RunStatus)) {
      throw new RunActionError(
        "invalid_state",
        "Only completed, failed, or stopped runs can be deleted"
      )
    }
    releaseRun(runId)
    if (run.workspacePath) {
      rmSync(join(dataDir, run.workspacePath), { recursive: true, force: true })
    }
    db.delete(runs).where(eq(runs.id, runId)).run()
    eventBus.clearRun(runId)
  }

  return {
    create,
    get: getPublic,
    agents: (runId: string) => {
      if (!getStored(runId)) {
        throw new RunActionError("not_found", "Run not found")
      }
      return listStoredAgents(runId).map(
        (agent): AgentSummary => ({
          ...(getAgentPublic(agent.id) as AgentPublic),
          usage: usageForAgent(agent.id),
        })
      )
    },
    agent: getAgentPublic,
    inspector: inspectorForAgent,
    conversationSnapshot,
    listForEvent: repo.listForEvent,
    listForChallenge: repo.listForChallenge,
    pause,
    resume,
    message,
    stop,
    subscribe: eventBus.subscribe,
    activeSessionCount: () => sessions.size,
    setMaxConcurrency: (value: number) => {
      maxConcurrency = value
    },
    workspacePath: (runId: string) => {
      const path = getStored(runId)?.workspacePath
      return path ? join(dataDir, path) : undefined
    },
    agentUsage: usageForAgent,
    usage: (runId: string) => {
      const run = getStored(runId)
      if (!run) throw new RunActionError("not_found", "Run not found")
      return sumUsage(
        listStoredAgents(runId).map((agent) => usageForAgent(agent.id))
      )
    },
    cursor,
    delete: deleteRun,
    close: closeManager,
  }
}

export { RunActionError } from "./errors"
