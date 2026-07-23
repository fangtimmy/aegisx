import { homedir } from "node:os"
import { join } from "node:path"
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import { clampThinkingLevel } from "@earendil-works/pi-ai"
import { and, eq } from "drizzle-orm"
import type {
  AgentPublic,
  AgentRuntimeSnapshot,
  ConversationMessage,
} from "../../../shared"
import {
  type AgentRuntime,
  createAgentRuntime,
  type RuntimeOutcome,
} from "../agents/runtime"
import type { createDatabase } from "../db"
import { agentToolCalls, challenges, runAgents, type runs } from "../db/schema"
import type { SettingsPublic } from "../infrastructure/config-store"
import { redactSecrets, replaceText } from "../infrastructure/redaction"
import {
  getChallengeRemote,
  isPlatformIntegrated,
  isTargetCapable,
} from "../platforms/challenge-state"
import type { TargetState } from "../platforms/core"
import type { ModelService } from "../providers/models"
import { renderSystemPrompt } from "../settings/prompt-templates"
import type { EnvironmentConfig, ModelConfig } from "./config"
import { parseEnvironment, parseModelConfig, parsePromptConfig } from "./config"
import type { ContainerPool } from "./container-pool"
import { RunStartError } from "./errors"
import type { RunEvent } from "./events"
import type { PromptContextBuilder } from "./prompt-context"
import type { createRunTools } from "./tools"

type Database = ReturnType<typeof createDatabase>["db"]
type StoredRun = typeof runs.$inferSelect
type StoredAgent = typeof runAgents.$inferSelect
type ResolvedModel = NonNullable<ReturnType<ModelService["find"]>>

export type AgentSession = {
  runId: string
  agentId: string
  runtime: AgentRuntime
  generation: number
}

/**
 * In-memory registry of live agent runtimes.
 * Generation guards stale callbacks after dispose/re-attach.
 */
export function createSessionRegistry() {
  const sessions = new Map<string, AgentSession>()
  const generations = new Map<string, number>()

  function nextGeneration(agentId: string) {
    const generation = (generations.get(agentId) ?? 0) + 1
    generations.set(agentId, generation)
    return generation
  }

  function get(agentId: string) {
    return sessions.get(agentId)
  }

  function isCurrent(agentId: string, generation: number) {
    return sessions.get(agentId)?.generation === generation
  }

  function set(session: AgentSession) {
    sessions.set(session.agentId, session)
  }

  function release(agentId: string) {
    const active = sessions.get(agentId)
    if (!active) return
    active.runtime.dispose()
    sessions.delete(agentId)
  }

  function releaseRun(runId: string) {
    for (const session of [...sessions.values()]) {
      if (session.runId === runId) release(session.agentId)
    }
  }

  async function abortRun(runId: string, exceptAgentId?: string) {
    const pending = Promise.allSettled(
      [...sessions.values()]
        .filter(
          (session) =>
            session.runId === runId && session.agentId !== exceptAgentId
        )
        .map((session) => session.runtime.abort())
    )
    await Promise.race([pending, Bun.sleep(5000)])
  }

  function disposeAll() {
    for (const session of sessions.values()) session.runtime.dispose()
    sessions.clear()
  }

  return {
    get,
    set,
    isCurrent,
    nextGeneration,
    release,
    releaseRun,
    abortRun,
    disposeAll,
    get size() {
      return sessions.size
    },
    values() {
      return sessions.values()
    },
  }
}

export type SessionRegistry = ReturnType<typeof createSessionRegistry>

export function createSessionAttacher(options: {
  db: Database
  dataDir: string
  sessions: SessionRegistry
  containers: ContainerPool
  modelService: ModelService
  getSettings(): SettingsPublic
  getApiKeys?: (provider: string) => Iterable<string>
  getStored(runId: string): StoredRun | undefined
  getStoredAgent(agentId: string): StoredAgent | undefined
  getAgentPublic(agentId: string): AgentPublic | undefined
  messagesForAgent(agentId: string): AgentMessage[]
  conversationMessageForRuntime(
    agentId: string,
    messageId: string
  ): ConversationMessage | undefined
  update(runId: string, values: Partial<typeof runs.$inferInsert>): unknown
  emit(runId: string, event: RunEvent): void
  prompts: PromptContextBuilder
  createChildAgent(
    runId: string,
    parentAgentId: string,
    name: string,
    task: string,
    signal?: AbortSignal
  ): Promise<AgentPublic>
  canFinishRun?(runId: string, challengeId: string): boolean
  submitFlag?(
    runId: string,
    challengeId: string,
    flag?: string,
    signal?: AbortSignal
  ): Promise<unknown>
  targetAction?(
    challengeId: string,
    action: "get" | "start" | "extend" | "stop",
    signal?: AbortSignal
  ): Promise<TargetState>
  onMainSettled(
    runId: string,
    agentId: string,
    outcome: RuntimeOutcome
  ): void | Promise<void>
  onChildSettled(
    runId: string,
    agentId: string,
    outcome: RuntimeOutcome
  ): void | Promise<void>
  resolveRequestedModel(config: ModelConfig): Promise<ResolvedModel>
  createTools: typeof createRunTools
}) {
  const {
    db,
    dataDir,
    sessions,
    containers,
    getSettings,
    getApiKeys,
    getStored,
    getStoredAgent,
    getAgentPublic,
    messagesForAgent,
    conversationMessageForRuntime,
    update,
    emit,
    prompts,
    createChildAgent,
    canFinishRun,
    submitFlag,
    targetAction,
    onMainSettled,
    onChildSettled,
    resolveRequestedModel,
    createTools,
  } = options

  async function attachSession(
    agent: StoredAgent,
    run: StoredRun,
    workspacePath: string,
    model: ResolvedModel,
    environment: EnvironmentConfig,
    provider: string
  ) {
    const runId = run.id
    const agentId = agent.id
    const generation = sessions.nextGeneration(agentId)
    const isMain = agent.parentAgentId === null
    const settings = getSettings()
    const backend = await containers.ensureBackend(
      runId,
      run.workspacePath,
      environment,
      settings
    )
    const challenge = db
      .select()
      .from(challenges)
      .where(eq(challenges.id, run.challengeId))
      .get()
    if (!challenge) throw new RunStartError("Challenge is unavailable")
    const remote = getChallengeRemote(db, challenge.id)
    const tools = createTools({
      runId,
      agentId,
      isMain,
      agent,
      run,
      challenge: {
        id: challenge.id,
        platformIntegrated: isPlatformIntegrated(remote),
        targetCapable: isTargetCapable(remote),
      },
      backend,
      toolLimits: {
        maxOutput: settings.maxToolOutputBytes,
        maxShellOutput: settings.maxInlineShellOutputBytes,
        maxCapturedShellOutput: settings.maxCapturedShellOutputBytes,
      },
      getStoredRun: () => getStored(runId),
      updateRun: (values) => update(runId, values),
      getStoredAgent,
      getAgentPublic,
      messagesForAgent,
      createChildAgent,
      canFinishRun,
      submitFlag,
      targetAction,
    })
    const secrets = new Set(getApiKeys?.(provider))
    const logicalCwd =
      environment.type === "container"
        ? settings.containerWorkspace
        : "$WORKSPACE"
    const modelConfig = parseModelConfig(run.modelConfig)
    const thinkingLevel = clampThinkingLevel(model, modelConfig.thinkingLevel)
    const promptConfig = parsePromptConfig(run.promptConfig)
    const agentContext = {
      name: agent.name,
      task: agent.task,
      isMain,
    }
    const promptContext = promptConfig.context
      ? prompts.promptContextForAgent(promptConfig.context, agentContext)
      : prompts.buildPromptContext(
          runId,
          challenge,
          remote,
          prompts
            .attachmentFiles(challenge.id)
            .map(({ storageKey: _, ...attachment }) => attachment),
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
      retryConfig: {
        maxAttempts: settings.maxRetryAttempts,
        baseDelayMs: settings.retryBaseDelayMs,
        maxDelayMs: settings.retryMaxDelayMs,
      },
      getToolTimeoutSettings: () => {
        const live = getSettings()
        return {
          defaultToolTimeoutMs: live.defaultToolTimeoutMs,
          toolTimeouts: live.toolTimeouts,
        }
      },
      canRunTool: () =>
        !containers.hasFailure(runId) &&
        getStored(runId)?.status === "running" &&
        getStoredAgent(agentId)?.status === "running",
      onActivity: (activity, detail) => {
        if (!sessions.isCurrent(agentId, generation)) return
        emit(runId, { type: "agent.activity", agentId, activity, detail })
      },
      onEvent: (event, messageId, cursor) => {
        if (!sessions.isCurrent(agentId, generation)) return
        for (const secret of getApiKeys?.(provider) ?? []) {
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
            message: event.message as ConversationMessage["message"],
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
          const terminal =
            ended && event.isError
              ? db
                  .select({
                    status: agentToolCalls.status,
                    error: agentToolCalls.error,
                  })
                  .from(agentToolCalls)
                  .where(
                    and(
                      eq(agentToolCalls.agentId, agentId),
                      eq(agentToolCalls.toolCallId, event.toolCallId)
                    )
                  )
                  .get()
              : undefined
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
            ...(terminal &&
            ["timed_out", "cancelled", "failed"].includes(terminal.status)
              ? {
                  terminal: terminal.status as
                    | "timed_out"
                    | "cancelled"
                    | "failed",
                  ...(terminal.error
                    ? { terminalMessage: terminal.error }
                    : {}),
                }
              : {}),
          })
        }
      },
      onSettled: (outcome) => {
        if (!sessions.isCurrent(agentId, generation)) return
        return isMain
          ? onMainSettled(runId, agentId, outcome)
          : onChildSettled(runId, agentId, outcome)
      },
    })
    sessions.set({ runId, agentId, runtime, generation })
    return runtime
  }

  async function ensureSession(agentId: string) {
    const existing = sessions.get(agentId)
    if (existing) return existing.runtime
    const agent = getStoredAgent(agentId)
    const run = agent ? getStored(agent.runId) : undefined
    if (!agent || !run) {
      throw new RunStartError("Agent session is unavailable")
    }
    const modelConfig = parseModelConfig(run.modelConfig)
    const model = await resolveRequestedModel(modelConfig)
    if (!run.workspacePath) {
      throw new RunStartError("Run workspace is unavailable")
    }
    const workspacePath = join(dataDir, run.workspacePath)
    return attachSession(
      agent,
      run,
      workspacePath,
      model,
      parseEnvironment(run.environmentConfig),
      modelConfig.provider
    )
  }

  return { attachSession, ensureSession }
}

export type SessionAttacher = ReturnType<typeof createSessionAttacher>
