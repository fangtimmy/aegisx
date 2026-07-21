import { copyFileSync, mkdirSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { basename, extname, join, relative } from "node:path"
import { clampThinkingLevel } from "@earendil-works/pi-ai"
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  sql,
} from "drizzle-orm"
import type {
  AgentPublic,
  AgentRuntimeSnapshot,
  AgentStatus,
  AgentSummary,
  ConversationMessage,
  RunPublic,
  RunStatus,
} from "../../../shared/api"
import {
  type AgentRuntime,
  createAgentRuntime,
  type RuntimeOutcome,
} from "../agents/runtime"
import { createLocalBackend, type WorkspaceBackend } from "../agents/tools"
import { sumUsage } from "../agents/usage"
import type { createDatabase } from "../db"
import {
  agentInbox,
  agentMessages,
  attachments,
  challenges,
  eventPlatforms,
  events,
  runAgents,
  runEvents,
  runs,
} from "../db/schema"
import {
  containerName,
  containerRunningAsync,
  createContainerAsync,
  createContainerBackend,
  removeContainer,
  removeContainerAsync,
} from "../infrastructure/container"
import { redactSecrets, replaceText } from "../infrastructure/redaction"
import type { TargetState } from "../platforms/core"
import type { ModelService } from "../providers/models"
import {
  type PromptAttachment,
  type PromptTemplateContext,
  type PromptTemplates,
  renderInitialPrompt,
  renderSystemPrompt,
} from "../settings/prompt-templates"
import {
  type EnvironmentConfig,
  type ModelConfig,
  parseEnvironment,
  parseModelConfig,
  parsePromptConfig,
  parseRuntimeSnapshot,
} from "./config"
import { RunActionError } from "./errors"
import { createRunInspector } from "./inspector"
import { type AgentChange, createRunStateStore } from "./state-store"
import { createRunTools } from "./tools"

type Database = ReturnType<typeof createDatabase>["db"]
type RunEvent =
  | { type: "run.updated"; run: RunPublic; cursor?: number }
  | { type: "agent.updated"; agent: AgentSummary; cursor?: number }
  | {
      type: "message.progress"
      agentId: string
      messageId: string
      revision: number
      message: Record<string, unknown>
    }
  | {
      type: "tool.progress"
      agentId: string
      toolCallId: string
      revision: number
      toolName: string
      args: unknown
      result?: unknown
      status: "running" | "done" | "error"
      isError?: boolean
    }
  | {
      type: "message.committed"
      agentId: string
      cursor: number
      message: ConversationMessage
    }
type RunEventListener = (
  event: RunEvent,
  sequence: number,
  replay: boolean
) => void
type Options = {
  db: Database
  dataDir: string
  maxConcurrency: number
  modelService: ModelService
  getPromptTemplates(): PromptTemplates
  getApiKeys?: (provider: string) => Iterable<string>
  submitFlag?(
    runId: string,
    challengeId: string,
    flag?: string
  ): Promise<unknown>
  canFinishRun?(runId: string, challengeId: string): boolean
  targetAction?(
    challengeId: string,
    action: "get" | "start" | "extend" | "stop"
  ): Promise<TargetState>
}

type CurrentSession = {
  runId: string
  agentId: string
  runtime: AgentRuntime
  generation: number
}
const terminalRunStatuses: RunStatus[] = ["completed", "failed", "stopped"]
const terminalAgentStatuses: AgentStatus[] = ["completed", "failed", "stopped"]
const defaultResumeMessage =
  "Continue solving the challenge from the current state."

export function createRunManager(options: Options) {
  const { db, dataDir } = options
  let maxConcurrency = options.maxConcurrency
  const current = new Map<string, CurrentSession>()
  const activeContainers = new Map<string, string>()
  const listeners = new Map<string, Set<RunEventListener>>()
  const aborting = new Map<string, "paused" | "stopped">()
  const containerFailures = new Map<string, string>()
  const runLocks = new Map<string, Promise<unknown>>()
  const sessionGenerations = new Map<string, number>()
  let closed = false

  function withRunLock<T>(runId: string, operation: () => T | Promise<T>) {
    if (closed) {
      return Promise.reject(
        new RunActionError("invalid_state", "Run manager is closed")
      )
    }
    const previous = runLocks.get(runId) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(operation)
    runLocks.set(runId, current)
    return current.finally(() => {
      if (runLocks.get(runId) === current) runLocks.delete(runId)
    })
  }

  const staleContainers = db
    .select({ id: runs.id, environmentConfig: runs.environmentConfig })
    .from(runs)
    .all()
    .filter(
      ({ environmentConfig }) =>
        parseEnvironment(environmentConfig).type === "container"
    )
  const pendingCompletions = db
    .select({
      id: runs.id,
      summary: runs.pendingCompletionSummary,
    })
    .from(runs)
    .where(
      and(eq(runs.status, "running"), isNotNull(runs.pendingCompletionSummary))
    )
    .all()
  for (const pending of pendingCompletions) {
    const completedAt = new Date().toISOString()
    db.transaction((tx) => {
      tx.update(runAgents)
        .set({
          status: "stopped",
          completedAt,
          updatedAt: completedAt,
        })
        .where(
          and(
            eq(runAgents.runId, pending.id),
            isNotNull(runAgents.parentAgentId),
            inArray(runAgents.status, ["running", "idle", "paused"])
          )
        )
        .run()
      tx.update(runAgents)
        .set({
          status: "completed",
          summary: pending.summary,
          error: null,
          completedAt,
          updatedAt: completedAt,
        })
        .where(
          and(eq(runAgents.runId, pending.id), isNull(runAgents.parentAgentId))
        )
        .run()
      tx.update(runs)
        .set({
          status: "completed",
          summary: pending.summary,
          pendingCompletionSummary: null,
          error: null,
          completedAt,
          updatedAt: completedAt,
        })
        .where(eq(runs.id, pending.id))
        .run()
      tx.insert(runEvents)
        .values({
          runId: pending.id,
          type: "run_updated",
          createdAt: completedAt,
        })
        .run()
    })
  }
  db.update(runs)
    .set({ status: "paused", updatedAt: new Date().toISOString() })
    .where(eq(runs.status, "running"))
    .run()
  db.update(runAgents)
    .set({ status: "paused", updatedAt: new Date().toISOString() })
    .where(inArray(runAgents.status, ["running", "idle"]))
    .run()
  for (const run of db
    .select({ id: runs.id, status: runs.status, summary: runs.summary })
    .from(runs)
    .where(inArray(runs.status, terminalRunStatuses))
    .all()) {
    const completedAt = new Date().toISOString()
    db.transaction((tx) => {
      tx.update(runAgents)
        .set({
          status:
            run.status === "completed"
              ? "completed"
              : run.status === "failed"
                ? "failed"
                : "stopped",
          ...(run.status === "completed" ? { summary: run.summary } : {}),
          completedAt,
          updatedAt: completedAt,
        })
        .where(
          and(
            eq(runAgents.runId, run.id),
            isNull(runAgents.parentAgentId),
            inArray(runAgents.status, ["running", "idle", "paused"])
          )
        )
        .run()
      tx.update(runAgents)
        .set({ status: "stopped", completedAt, updatedAt: completedAt })
        .where(
          and(
            eq(runAgents.runId, run.id),
            isNotNull(runAgents.parentAgentId),
            inArray(runAgents.status, ["running", "idle", "paused"])
          )
        )
        .run()
    })
  }
  for (const { id } of staleContainers) removeContainer(containerName(id))

  function getStored(runId: string) {
    return db.select().from(runs).where(eq(runs.id, runId)).get()
  }

  function cursor(runId: string) {
    return (
      db
        .select({ value: sql<number>`coalesce(max(${runEvents.id}), 0)` })
        .from(runEvents)
        .where(eq(runEvents.runId, runId))
        .get()?.value ?? 0
    )
  }

  function getStoredAgent(agentId: string) {
    return db.select().from(runAgents).where(eq(runAgents.id, agentId)).get()
  }

  function getMainAgent(runId: string) {
    return db
      .select()
      .from(runAgents)
      .where(and(eq(runAgents.runId, runId), isNull(runAgents.parentAgentId)))
      .get()
  }

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

  function listStoredAgents(runId: string) {
    return db
      .select()
      .from(runAgents)
      .where(eq(runAgents.runId, runId))
      .orderBy(runAgents.createdAt, runAgents.id)
      .all()
  }

  function getAgentPublic(agentId: string): AgentPublic | undefined {
    const agent = getStoredAgent(agentId)
    if (!agent) return undefined
    return {
      id: agent.id,
      runId: agent.runId,
      parentAgentId: agent.parentAgentId,
      name: agent.name,
      status: agent.status as AgentStatus,
      summary: agent.summary,
      error: agent.error,
      createdAt: agent.createdAt,
      startedAt: agent.startedAt,
      updatedAt: agent.updatedAt,
      completedAt: agent.completedAt,
    }
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

  function getPublic(
    runId: string,
    includeFlag = false
  ): RunPublic | undefined {
    const row = db
      .select({
        run: runs,
        challengeName: challenges.name,
        eventId: events.id,
        targetSupported: challenges.remoteTarget,
        targetIgnored: challenges.remoteTargetIgnored,
        targetAvailable: challenges.remoteAvailable,
      })
      .from(runs)
      .innerJoin(challenges, eq(runs.challengeId, challenges.id))
      .innerJoin(events, eq(challenges.eventId, events.id))
      .where(eq(runs.id, runId))
      .get()
    if (!row) return undefined
    const config = parseModelConfig(row.run.modelConfig)
    const environment = parseEnvironment(row.run.environmentConfig)
    const value: RunPublic = {
      id: row.run.id,
      challengeId: row.run.challengeId,
      challengeName: row.challengeName,
      eventId: row.eventId,
      status: row.run.status as RunStatus,
      provider: config.providerLabel ?? config.provider ?? "",
      modelId: config.modelId ?? "",
      modelName: config.modelLabel ?? config.modelId ?? "",
      thinkingLevel: config.thinkingLevel,
      environment: environment.type,
      targetSupported:
        row.targetSupported && row.targetAvailable && !row.targetIgnored,
      createdAt: row.run.createdAt,
      startedAt: row.run.startedAt,
      updatedAt: row.run.updatedAt,
      completedAt: row.run.completedAt,
      error: row.run.error,
      summary: row.run.summary,
      hasFlag: Boolean(row.run.flag),
    }
    if (environment.type === "container") {
      value.image = environment.image
      value.cpus = environment.cpus
      value.memoryMb = environment.memoryMb
      value.pidsLimit = environment.pidsLimit
    }
    if (includeFlag) value.flag = row.run.flag
    return value
  }

  function emit(runId: string, event: RunEvent) {
    const sequence = "cursor" in event ? (event.cursor ?? 0) : 0
    for (const listener of listeners.get(runId) ?? []) {
      listener(event, sequence, false)
    }
  }

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
    const active = current.get(agentId)
    if (active) {
      active.runtime.dispose()
      current.delete(agentId)
    }
  }

  async function releaseRun(runId: string) {
    for (const active of [...current.values()]) {
      if (active.runId === runId) releaseAgent(active.agentId)
    }
    const name = activeContainers.get(runId)
    if (name) {
      await removeContainerAsync(name)
      activeContainers.delete(runId)
    }
  }

  function runningCount() {
    return (
      db
        .select({ value: count() })
        .from(runAgents)
        .where(inArray(runAgents.status, ["running", "idle"]))
        .get()?.value ?? 0
    )
  }

  function requireCapacity(count = 1) {
    if (runningCount() + count > maxConcurrency) {
      throw new RunActionError("capacity", "Run capacity reached")
    }
  }

  function buildPromptContext(
    runId: string,
    challenge: typeof challenges.$inferSelect,
    challengeAttachments: PromptAttachment[],
    environment: EnvironmentConfig,
    modelConfig: ModelConfig,
    agent: {
      name: string
      task: string | null
      isMain: boolean
    }
  ): PromptTemplateContext {
    const event = db
      .select()
      .from(events)
      .where(eq(events.id, challenge.eventId))
      .get()
    if (!event) throw new RunStartError("Event is unavailable")
    const platform = db
      .select({ type: eventPlatforms.type })
      .from(eventPlatforms)
      .where(eq(eventPlatforms.eventId, event.id))
      .get()
    const targetSupported =
      challenge.remoteTarget &&
      challenge.remoteAvailable &&
      !challenge.remoteTargetIgnored
    const platformIntegrated = Boolean(
      challenge.remoteId && challenge.remoteAvailable
    )
    return {
      agent: {
        role: agent.isMain ? "main" : "child",
        isMain: agent.isMain,
        name: agent.name,
        task: agent.task,
      },
      event: {
        id: event.id,
        name: event.name,
        platform: platform?.type ?? null,
      },
      challenge: {
        id: challenge.id,
        name: challenge.name,
        description: challenge.description,
        category: challenge.category,
        points: challenge.points,
        attachments: challengeAttachments,
        attachmentPaths: challengeAttachments.map(({ path }) => path),
      },
      model: {
        provider: modelConfig.providerLabel ?? modelConfig.provider,
        name: modelConfig.modelLabel ?? modelConfig.modelId,
        id: modelConfig.modelId,
      },
      run: {
        id: runId,
        environment: environment.type,
        isContainer: environment.type === "container",
        workspace:
          environment.type === "container" ? "/workspace" : "$WORKSPACE",
        targetSupported,
        platformIntegrated,
        containerImage:
          environment.type === "container" ? environment.image : null,
        cpus: environment.type === "container" ? environment.cpus : null,
        memoryMb:
          environment.type === "container" ? environment.memoryMb : null,
        pidsLimit:
          environment.type === "container" ? environment.pidsLimit : null,
      },
      capabilities: {
        canFinishRun: agent.isMain,
        canSpawnAgent: agent.isMain,
        canSubmitFlag: agent.isMain && platformIntegrated,
        canManageTarget: agent.isMain && targetSupported,
      },
    }
  }

  function promptContextForAgent(
    context: PromptTemplateContext,
    agent: { name: string; task: string | null; isMain: boolean }
  ): PromptTemplateContext {
    return {
      ...context,
      agent: {
        role: agent.isMain ? "main" : "child",
        isMain: agent.isMain,
        name: agent.name,
        task: agent.task,
      },
      capabilities: {
        canFinishRun: agent.isMain,
        canSpawnAgent: agent.isMain,
        canSubmitFlag: agent.isMain && context.run.platformIntegrated,
        canManageTarget: agent.isMain && context.run.targetSupported,
      },
    }
  }

  function attachmentFiles(challengeId: string) {
    const rows = db
      .select()
      .from(attachments)
      .where(eq(attachments.challengeId, challengeId))
      .orderBy(attachments.createdAt, attachments.id)
      .all()
    const used = new Set<string>()
    return rows.map((attachment) => {
      const original = basename(attachment.originalName) || "attachment"
      const extension = extname(original)
      const stem = original.slice(0, original.length - extension.length)
      let filename = original
      for (let suffix = 2; used.has(filename); suffix += 1) {
        filename = `${stem} (${suffix})${extension}`
      }
      used.add(filename)
      return {
        name: attachment.originalName,
        path: filename,
        size: attachment.size,
        storageKey: attachment.storageKey,
      }
    })
  }

  function copyAttachments(
    challengeId: string,
    workspacePath: string
  ): PromptAttachment[] {
    return attachmentFiles(challengeId).map(({ storageKey, ...attachment }) => {
      copyFileSync(
        join(dataDir, "attachments", ...storageKey.split("/")),
        join(workspacePath, attachment.path)
      )
      return attachment
    })
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

  async function ensureSession(agentId: string) {
    const existing = current.get(agentId)
    if (existing) return existing.runtime
    const agent = getStoredAgent(agentId)
    const run = agent ? getStored(agent.runId) : undefined
    if (!agent || !run) {
      throw new RunStartError("Agent session is unavailable")
    }
    const modelConfig = parseModelConfig(run.modelConfig)
    const model = await resolveRequestedModel(modelConfig)
    const workspacePath = runWorkspacePath(run)
    return attachSession(
      agent,
      run,
      workspacePath,
      model,
      parseEnvironment(run.environmentConfig),
      modelConfig.provider
    )
  }

  async function attachSession(
    agent: typeof runAgents.$inferSelect,
    run: typeof runs.$inferSelect,
    workspacePath: string,
    model: Awaited<ReturnType<typeof resolveRequestedModel>>,
    environment: EnvironmentConfig,
    provider: string
  ) {
    const runId = run.id
    const agentId = agent.id
    const generation = (sessionGenerations.get(agentId) ?? 0) + 1
    sessionGenerations.set(agentId, generation)
    const isMain = agent.parentAgentId === null
    const runWorkspacePath = join(dataDir, run.workspacePath as string)
    let backend: WorkspaceBackend
    if (environment.type === "container") {
      let name = activeContainers.get(runId)
      if (name && !(await containerRunningAsync(name))) {
        activeContainers.delete(runId)
        name = undefined
      }
      if (!name) {
        name = containerName(runId)
        if (!run.workspacePath) {
          throw new RunStartError("Run workspace is unavailable")
        }
        try {
          await createContainerAsync(
            name,
            join(dataDir, run.workspacePath),
            environment.image,
            environment
          )
        } catch {
          throw new RunStartError("Container could not be started")
        }
        activeContainers.set(runId, name)
      }
      backend = createContainerBackend(name, undefined, () => {
        if (activeContainers.get(runId) === name) {
          activeContainers.delete(runId)
          void removeContainerAsync(name)
        }
        if (!containerFailures.has(runId)) {
          containerFailures.set(runId, "Container execution became unavailable")
          void abortRun(runId)
        }
      })
    } else {
      backend = createLocalBackend(runWorkspacePath)
    }
    const challenge = db
      .select()
      .from(challenges)
      .where(eq(challenges.id, run.challengeId))
      .get()
    if (!challenge) throw new RunStartError("Challenge is unavailable")
    const tools = createRunTools({
      runId,
      agentId,
      isMain,
      agent,
      run,
      challenge,
      backend,
      getStoredRun: () => getStored(runId),
      updateRun: (values) => update(runId, values),
      getStoredAgent,
      getAgentPublic,
      messagesForAgent,
      createChildAgent,
      canFinishRun: options.canFinishRun,
      submitFlag: options.submitFlag,
      targetAction: options.targetAction,
    })
    const secrets = new Set(options.getApiKeys?.(provider))
    const logicalCwd =
      environment.type === "container" ? "/workspace" : "$WORKSPACE"
    const modelConfig = parseModelConfig(run.modelConfig)
    const thinkingLevel = clampThinkingLevel(model, modelConfig.thinkingLevel)
    const promptConfig = parsePromptConfig(run.promptConfig)
    const agentContext = {
      name: agent.name,
      task: agent.task,
      isMain,
    }
    const promptContext = promptConfig.context
      ? promptContextForAgent(promptConfig.context, agentContext)
      : buildPromptContext(
          runId,
          challenge,
          attachmentFiles(challenge.id).map(
            ({ storageKey: _, ...attachment }) => attachment
          ),
          environment,
          modelConfig,
          agentContext
        )
    const systemPrompt = renderSystemPrompt(
      isMain
        ? promptConfig.mainSystemPromptTemplate
        : promptConfig.childSystemPromptTemplate,
      promptContext
    )
    const snapshot: AgentRuntimeSnapshot = {
      capturedAt: new Date().toISOString(),
      systemPrompt,
      cwd: logicalCwd,
      model: {
        provider: modelConfig.providerLabel ?? provider,
        modelId: model.id,
        thinkingLevel,
      },
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
    }
    redactSecrets(snapshot, secrets)
    replaceText(snapshot, workspacePath, logicalCwd)
    if (run.workspacePath) {
      replaceText(snapshot, join(dataDir, run.workspacePath), "$WORKSPACE")
    }
    replaceText(snapshot, dataDir, "$DATA")
    replaceText(snapshot, homedir(), "$HOME")
    db.update(runAgents)
      .set({ runtimeSnapshot: JSON.stringify(snapshot) })
      .where(eq(runAgents.id, agentId))
      .run()
    const messageRevisions = new Map<string, number>()
    const toolRevisions = new Map<string, number>()
    const nextRevision = (values: Map<string, number>, id: string) => {
      const revision = (values.get(id) ?? -1) + 1
      values.set(id, revision)
      return revision
    }
    const runtime = createAgentRuntime({
      db,
      runId,
      agentId,
      systemPrompt,
      model,
      models: options.modelService.models,
      tools,
      secrets,
      thinkingLevel,
      canRunTool: () =>
        !containerFailures.has(runId) &&
        getStored(runId)?.status === "running" &&
        getStoredAgent(agentId)?.status === "running",
      onEvent: (event, messageId, cursor) => {
        if (current.get(agentId)?.generation !== generation) return
        for (const secret of options.getApiKeys?.(provider) ?? []) {
          runtime.addSecrets([secret])
        }
        if (
          messageId &&
          (event.type === "message_start" ||
            event.type === "message_update" ||
            event.type === "message_end")
        ) {
          const revision = nextRevision(messageRevisions, messageId)
          if (event.type === "message_end" && cursor !== undefined) {
            const message = conversationMessageForRuntime(agentId, messageId)
            if (message) {
              emit(runId, {
                type: "message.committed",
                agentId,
                cursor,
                message,
              })
              return
            }
          }
          emit(runId, {
            type: "message.progress",
            agentId,
            messageId,
            revision,
            message: event.message as unknown as Record<string, unknown>,
          })
          return
        }
        if (
          event.type === "tool_execution_start" ||
          event.type === "tool_execution_update" ||
          event.type === "tool_execution_end"
        ) {
          const revision = nextRevision(toolRevisions, event.toolCallId)
          const ended = event.type === "tool_execution_end"
          const args = "args" in event ? event.args : undefined
          emit(runId, {
            type: "tool.progress",
            agentId,
            toolCallId: event.toolCallId,
            revision,
            toolName: event.toolName,
            args,
            ...(event.type === "tool_execution_update"
              ? { result: event.partialResult }
              : event.type === "tool_execution_end"
                ? { result: event.result }
                : {}),
            status: ended ? (event.isError ? "error" : "done") : "running",
            ...(ended && event.isError ? { isError: true } : {}),
          })
        }
      },
      onSettled: (outcome) => {
        if (current.get(agentId)?.generation !== generation) return
        return isMain
          ? handleMainSettled(runId, agentId, outcome)
          : handleChildSettled(runId, agentId, outcome)
      },
    })
    current.set(agentId, { runId, agentId, runtime, generation })
    return runtime
  }

  async function handleMainSettled(
    runId: string,
    agentId: string,
    outcome: RuntimeOutcome
  ) {
    if (closed || aborting.has(runId)) return
    return withRunLock(runId, async () => {
      if (closed || aborting.has(runId)) return
      const storedRun = getStored(runId)
      if (
        !storedRun ||
        terminalRunStatuses.includes(storedRun.status as RunStatus)
      ) {
        await releaseRun(runId)
        return
      }
      if (getStoredAgent(agentId)?.status !== "running") return

      const containerFailure = containerFailures.get(runId)
      if (containerFailure) {
        aborting.set(runId, "paused")
        try {
          await abortRun(runId, agentId)
          const changes = listStoredAgents(runId)
            .filter(
              (agent) =>
                !terminalAgentStatuses.includes(agent.status as AgentStatus)
            )
            .map((agent) => ({
              agentId: agent.id,
              values: { status: "paused" as const },
            }))
          await releaseRun(runId)
          transitionRun(
            runId,
            { status: "paused", error: containerFailure },
            changes
          )
        } finally {
          containerFailures.delete(runId)
          aborting.delete(runId)
        }
        return
      }

      if (outcome.status === "success" && storedRun.pendingCompletionSummary) {
        const completedAt = new Date().toISOString()
        aborting.set(runId, "stopped")
        try {
          await abortRun(runId, agentId)
          const changes: AgentChange[] = []
          for (const agent of listStoredAgents(runId)) {
            if (agent.id === agentId) {
              changes.push({
                agentId,
                values: {
                  status: "completed",
                  completedAt,
                  summary: storedRun.pendingCompletionSummary,
                  error: null,
                },
              })
              continue
            }
            if (!terminalAgentStatuses.includes(agent.status as AgentStatus)) {
              changes.push({
                agentId: agent.id,
                values: { status: "stopped", completedAt },
              })
            }
          }
          await releaseRun(runId)
          transitionRun(
            runId,
            {
              status: "completed",
              completedAt,
              summary: storedRun.pendingCompletionSummary,
              pendingCompletionSummary: null,
              error: null,
            },
            changes
          )
        } finally {
          aborting.delete(runId)
        }
        return
      }
      if (outcome.status === "success") {
        updateAgent(agentId, { status: "idle" })
        return
      }

      const completedAt = new Date().toISOString()
      const error = outcome.error ?? "Agent session failed"
      aborting.set(runId, "stopped")
      try {
        await abortRun(runId, agentId)
        const changes: AgentChange[] = []
        for (const agent of listStoredAgents(runId)) {
          if (agent.id === agentId) {
            changes.push({
              agentId,
              values: {
                status: "failed",
                completedAt,
                summary: outcome.summary,
                error,
              },
            })
            continue
          }
          if (!terminalAgentStatuses.includes(agent.status as AgentStatus)) {
            changes.push({
              agentId: agent.id,
              values: { status: "stopped", completedAt },
            })
          }
        }
        await releaseRun(runId)
        transitionRun(runId, { status: "failed", completedAt, error }, changes)
      } finally {
        aborting.delete(runId)
      }
    })
  }

  async function handleChildSettled(
    runId: string,
    agentId: string,
    outcome: RuntimeOutcome
  ) {
    if (
      closed ||
      aborting.has(runId) ||
      getStoredAgent(agentId)?.status !== "running"
    ) {
      releaseAgent(agentId)
      return
    }
    return withRunLock(runId, async () => {
      if (
        closed ||
        aborting.has(runId) ||
        getStoredAgent(agentId)?.status !== "running"
      ) {
        releaseAgent(agentId)
        return
      }
      const finished = updateAgent(agentId, {
        status: outcome.status === "success" ? "completed" : "failed",
        completedAt: new Date().toISOString(),
        summary: outcome.summary,
        error:
          outcome.status === "success"
            ? null
            : (outcome.error ?? "Agent session failed"),
      })
      await notifyMain(finished)
      releaseAgent(agentId)
    })
  }

  async function abortRun(runId: string, exceptAgentId?: string) {
    await Promise.allSettled(
      [...current.values()]
        .filter(
          (active) => active.runId === runId && active.agentId !== exceptAgentId
        )
        .map((active) => active.runtime.abort())
    )
  }

  async function notifyMain(agent: AgentPublic) {
    if (closed || aborting.has(agent.runId)) return
    const run = getStored(agent.runId)
    const main = getMainAgent(agent.runId)
    if (
      run?.status !== "running" ||
      !main ||
      (main.status !== "running" && main.status !== "idle")
    ) {
      return
    }
    const result =
      agent.summary ?? agent.error ?? "No final output was produced."
    const message = [
      `Background agent ${agent.name} (${agent.id}) ${agent.status}.`,
      "Final output:",
      result,
    ].join("\n\n")
    db.insert(agentInbox)
      .values({
        id: crypto.randomUUID(),
        agentId: main.id,
        kind: "child_result",
        content: message,
        metadata: JSON.stringify({
          handoff: {
            agentId: agent.id,
            agentName: agent.name,
            status: agent.status,
          },
        }),
        createdAt: new Date().toISOString(),
      })
      .run()
    if (main.status === "idle") updateAgent(main.id, { status: "running" })
    const runtime = current.get(main.id)?.runtime
    if (runtime) runtime.replayPending()
  }

  async function createChildAgent(
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
        !aborting.has(runId) &&
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
    aborting.set(runId, "paused")
    try {
      await abortRun(runId)
      const latest = getPublic(runId) as RunPublic
      if (terminalRunStatuses.includes(latest.status)) return latest
      await releaseRun(runId)
      containerFailures.delete(runId)
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
      aborting.delete(runId)
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
    containerFailures.delete(runId)
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
    aborting.set(runId, "stopped")
    try {
      await abortRun(runId)
      const latest = getPublic(runId) as RunPublic
      if (terminalRunStatuses.includes(latest.status)) return latest
      await releaseRun(runId)
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
      containerFailures.delete(runId)
      return stopped
    } finally {
      aborting.delete(runId)
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

  function replayEvents(
    runId: string,
    afterCursor: number,
    listener: RunEventListener
  ) {
    const rows = db
      .select()
      .from(runEvents)
      .where(and(eq(runEvents.runId, runId), gt(runEvents.id, afterCursor)))
      .orderBy(asc(runEvents.id))
      .all()
    for (const row of rows) {
      let event: RunEvent | undefined
      if (row.type === "run_updated") {
        const run = getPublic(runId)
        if (run) event = { type: "run.updated", run, cursor: row.id }
      } else if (row.type === "agent_updated" && row.agentId) {
        const agent = getAgentPublic(row.agentId)
        if (agent) {
          event = {
            type: "agent.updated",
            agent: { ...agent, usage: usageForAgent(agent.id) },
            cursor: row.id,
          }
        }
      } else if (row.type === "message_committed" && row.entityId) {
        const stored = db
          .select()
          .from(agentMessages)
          .where(eq(agentMessages.id, row.entityId))
          .get()
        if (stored) {
          event = {
            type: "message.committed",
            agentId: stored.agentId,
            cursor: row.id,
            message: conversationMessage(stored),
          }
        }
      }
      if (event) listener(event, row.id, true)
    }
  }

  async function closeManager() {
    if (closed) return
    closed = true
    await Promise.allSettled([...runLocks.values()])
    const runningRuns = db
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.status, "running"))
      .all()
    for (const { id } of runningRuns) {
      aborting.set(id, "paused")
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
        aborting.delete(id)
      }
    }
    for (const { runtime } of current.values()) runtime.dispose()
    current.clear()
    await Promise.allSettled(
      [...activeContainers.values()].map((name) => removeContainerAsync(name))
    )
    activeContainers.clear()
    containerFailures.clear()
    listeners.clear()
    runLocks.clear()
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
    listeners.delete(runId)
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
    listForEvent: (eventId: string) =>
      db
        .select({ id: runs.id })
        .from(runs)
        .innerJoin(challenges, eq(runs.challengeId, challenges.id))
        .where(eq(challenges.eventId, eventId))
        .orderBy(desc(runs.createdAt))
        .all()
        .map(({ id }) => getPublic(id) as RunPublic),
    listForChallenge: (challengeId: string) =>
      db
        .select({ id: runs.id })
        .from(runs)
        .where(eq(runs.challengeId, challengeId))
        .orderBy(desc(runs.createdAt))
        .all()
        .map(({ id }) => getPublic(id) as RunPublic),
    pause,
    resume,
    message,
    stop,
    subscribe: (runId: string, listener: RunEventListener, afterCursor = 0) => {
      const runListeners = listeners.get(runId) ?? new Set()
      runListeners.add(listener)
      listeners.set(runId, runListeners)
      replayEvents(runId, afterCursor, listener)
      return () => {
        runListeners.delete(listener)
        if (runListeners.size === 0) {
          listeners.delete(runId)
        }
      }
    },
    activeSessionCount: () => current.size,
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

export { RunActionError }

class RunStartError extends Error {}
