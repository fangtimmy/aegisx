import { copyFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { basename, extname, join, relative } from "node:path"
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import {
  clampThinkingLevel,
  type ModelThinkingLevel,
  type Usage,
} from "@earendil-works/pi-ai"
import { and, asc, count, desc, eq, inArray, isNull, sql } from "drizzle-orm"
import { Type } from "typebox"
import type {
  AgentInspector,
  AgentPublic,
  AgentRuntimeSnapshot,
  AgentStatus,
  AgentSummary,
  RunPublic,
  RunStatus,
} from "../../shared/api"
import {
  type AgentEvent,
  type AgentRuntime,
  createAgentRuntime,
  publicAgentMessage,
  type RuntimeOutcome,
} from "./agent-runtime"
import {
  createLocalBackend,
  createWorkspaceTools,
  defineAgentTool,
  type WorkspaceBackend,
} from "./agent-tools"
import {
  containerName,
  createContainer,
  createContainerBackend,
  removeContainer,
} from "./container"
import type { createDatabase } from "./db"
import {
  agentInbox,
  agentMessages,
  agentToolCalls,
  agentUsage,
  attachments,
  challenges,
  eventPlatforms,
  events,
  runAgents,
  runs,
} from "./db/schema"
import type { ModelService } from "./models"
import type { TargetState } from "./platform"
import {
  type PromptAttachment,
  type PromptTemplateContext,
  type PromptTemplates,
  renderInitialPrompt,
  renderSystemPrompt,
  resolvePromptTemplates,
} from "./prompt-templates"
import { redactSecrets, replaceText } from "./redaction"
import { summarizeUsage, summarizeUsageRecords, sumUsage } from "./usage"

type Database = ReturnType<typeof createDatabase>["db"]
type RunEvent =
  | { type: "status"; run: RunPublic }
  | { type: "agent_status"; agent: AgentPublic }
  | {
      type: "agent_event"
      agentId: string
      event: AgentEvent
      messageId?: string
    }
type RunEventListener = (
  event: RunEvent,
  sequence: number,
  replay: boolean
) => void
type EnvironmentConfig =
  | { type: "local" }
  | {
      type: "container"
      image: string
      cpus: number
      memoryMb: number
      pidsLimit: number
    }
type ModelConfig = {
  provider: string
  providerLabel?: string
  modelId: string
  modelLabel?: string
  baseUrl?: string
  costKnown?: boolean
  thinkingLevel: ModelThinkingLevel
}
type FrozenPromptConfig = PromptTemplates & {
  context?: PromptTemplateContext
}

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
}

const terminalRunStatuses: RunStatus[] = ["completed", "failed", "stopped"]
const terminalAgentStatuses: AgentStatus[] = ["completed", "failed", "stopped"]

export function createRunManager(options: Options) {
  const { db, dataDir } = options
  let maxConcurrency = options.maxConcurrency
  const current = new Map<string, CurrentSession>()
  const activeContainers = new Map<string, string>()
  const listeners = new Map<string, Set<RunEventListener>>()
  const eventSequences = new Map<string, number>()
  const eventHistory = new Map<
    string,
    Array<{ sequence: number; event: RunEvent }>
  >()
  const aborting = new Map<string, "paused" | "stopped">()
  let closed = false

  const interruptedContainers = db
    .select({ id: runs.id, environmentConfig: runs.environmentConfig })
    .from(runs)
    .where(eq(runs.status, "running"))
    .all()
    .filter(
      ({ environmentConfig }) =>
        parseEnvironment(environmentConfig).type === "container"
    )
  db.update(runs)
    .set({ status: "paused", updatedAt: new Date().toISOString() })
    .where(eq(runs.status, "running"))
    .run()
  db.update(runAgents)
    .set({ status: "paused", updatedAt: new Date().toISOString() })
    .where(inArray(runAgents.status, ["running", "idle"]))
    .run()
  for (const { id } of interruptedContainers) removeContainer(containerName(id))

  function getStored(runId: string) {
    return db.select().from(runs).where(eq(runs.id, runId)).get()
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
    const sequence = (eventSequences.get(runId) ?? 0) + 1
    eventSequences.set(runId, sequence)
    const history = eventHistory.get(runId) ?? []
    history.push({ sequence, event })
    if (history.length > 256) history.shift()
    eventHistory.set(runId, history)
    for (const listener of listeners.get(runId) ?? []) {
      listener(event, sequence, false)
    }
  }

  function releaseAgent(agentId: string) {
    const active = current.get(agentId)
    if (active) {
      active.runtime.dispose()
      current.delete(agentId)
    }
  }

  function releaseRun(runId: string) {
    for (const active of [...current.values()]) {
      if (active.runId === runId) releaseAgent(active.agentId)
    }
    const name = activeContainers.get(runId)
    if (name) {
      removeContainer(name)
      activeContainers.delete(runId)
    }
  }

  function update(
    runId: string,
    values: Partial<typeof runs.$inferInsert>
  ): RunPublic {
    db.update(runs)
      .set({ ...values, updatedAt: new Date().toISOString() })
      .where(eq(runs.id, runId))
      .run()
    const run = getPublic(runId)
    if (!run) throw new Error("Run not found")
    emit(runId, { type: "status", run })
    return run
  }

  function updateAgent(
    agentId: string,
    values: Partial<typeof runAgents.$inferInsert>
  ): AgentPublic {
    db.update(runAgents)
      .set({ ...values, updatedAt: new Date().toISOString() })
      .where(eq(runAgents.id, agentId))
      .run()
    const agent = getAgentPublic(agentId)
    if (!agent) throw new Error("Agent not found")
    emit(agent.runId, { type: "agent_status", agent })
    return agent
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
    const isMain = agent.parentAgentId === null
    const runWorkspacePath = join(dataDir, run.workspacePath as string)
    let backend: WorkspaceBackend
    if (environment.type === "container") {
      let name = activeContainers.get(runId)
      if (!name) {
        name = containerName(runId)
        if (!run.workspacePath) {
          throw new RunStartError("Run workspace is unavailable")
        }
        try {
          createContainer(
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
      backend = createContainerBackend(name)
    } else {
      backend = createLocalBackend(runWorkspacePath)
    }
    const challenge = db
      .select()
      .from(challenges)
      .where(eq(challenges.id, run.challengeId))
      .get()
    const finishRun = defineAgentTool({
      name: "finish_run",
      label: "Finish run",
      description: "Mark this challenge run complete and stop further work",
      parameters: Type.Object({
        summary: Type.String({ minLength: 1 }),
      }),
      execute: async (_id, params) => {
        const stored = getStored(runId)
        if (
          !stored ||
          terminalRunStatuses.includes(stored.status as RunStatus)
        ) {
          throw new Error("Run is already finished")
        }
        if (!options.canFinishRun?.(runId, run.challengeId)) {
          throw new Error("Submit an accepted flag before finishing this Run")
        }
        if (
          challenge?.remoteTarget &&
          challenge.remoteAvailable &&
          !challenge.remoteTargetIgnored &&
          options.targetAction
        ) {
          const target = await options.targetAction(run.challengeId, "get")
          if (["starting", "running", "stopping"].includes(target.status)) {
            throw new Error("Stop the remote target before finishing this Run")
          }
        }
        update(runId, {
          status: "completed",
          completedAt: new Date().toISOString(),
          summary: params.summary,
          error: null,
        })
        updateAgent(agentId, {
          status: "completed",
          completedAt: new Date().toISOString(),
          summary: params.summary,
          error: null,
        })
        for (const child of listStoredAgents(runId)) {
          if (
            child.id !== agentId &&
            !terminalAgentStatuses.includes(child.status as AgentStatus)
          ) {
            updateAgent(child.id, {
              status: "stopped",
              completedAt: new Date().toISOString(),
            })
          }
        }
        await abortRun(runId, agentId)
        return {
          content: [{ type: "text" as const, text: "Run completed" }],
          details: {},
          terminate: true,
        }
      },
      executionMode: "sequential",
    })
    const submitFlag = defineAgentTool({
      name: "submit_flag",
      label: "Submit flag",
      description: "Submit a candidate flag to the connected CTF platform",
      parameters: Type.Object({ flag: Type.String({ minLength: 1 }) }),
      executionMode: "sequential",
      execute: async (_id, params) => {
        if (!options.submitFlag) {
          throw new Error("Flag submission is unavailable")
        }
        const result = await options.submitFlag(
          runId,
          run.challengeId,
          params.flag
        )
        if (!result) throw new Error("Flag submission is unavailable")
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          details: result,
        }
      },
    })
    const spawnAgent = defineAgentTool({
      name: "spawn_agent",
      label: "Spawn agent",
      description:
        "Start a background child agent for a focused task. Completion is delivered automatically; do not poll repeatedly.",
      parameters: Type.Object({
        name: Type.String({ minLength: 1, maxLength: 80 }),
        task: Type.String({ minLength: 1, maxLength: 100_000 }),
      }),
      executionMode: "parallel",
      execute: async (_id, params, signal) => {
        if (signal?.aborted) throw new Error("Sub-agent creation was aborted")
        const child = await createChildAgent(
          runId,
          agentId,
          params.name.trim(),
          params.task.trim(),
          signal
        )
        return {
          content: [
            {
              type: "text" as const,
              text: `Started ${child.name} in the background with agent ID ${child.id}. It shares the Run workspace. Completion will be delivered automatically.`,
            },
          ],
          details: {
            agentId: child.id,
            status: child.status,
            workspace: ".",
          },
        }
      },
    })
    const inspectAgent = defineAgentTool({
      name: "inspect_agent",
      label: "Inspect agent",
      description:
        "Read a child agent status and latest output when needed. Completion is delivered automatically.",
      parameters: Type.Object({
        agent_id: Type.String({ minLength: 1 }),
      }),
      execute: async (_id, params) => {
        const child = getStoredAgent(params.agent_id)
        if (child?.runId !== runId || child.parentAgentId !== agentId) {
          throw new Error("Child agent was not found")
        }
        const value = getAgentPublic(child.id) as AgentPublic
        const summary =
          value.summary ?? lastAssistantText(messagesForAgent(child.id))
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                id: value.id,
                name: value.name,
                status: value.status,
                summary,
                error: value.error,
              }),
            },
          ],
          details: { found: true },
        }
      },
    })
    const targetTool = (
      name: "get_target" | "start_target" | "extend_target" | "stop_target",
      label: string,
      description: string,
      action: "get" | "start" | "extend" | "stop"
    ) =>
      defineAgentTool({
        name,
        label,
        description,
        parameters: Type.Object({}, { additionalProperties: false }),
        executionMode: "sequential",
        execute: async () => {
          if (!options.targetAction) {
            throw new Error("Target management is unavailable")
          }
          const target = await options.targetAction(run.challengeId, action)
          return {
            content: [{ type: "text" as const, text: JSON.stringify(target) }],
            details: target,
          }
        },
      })
    const targetTools =
      isMain &&
      challenge?.remoteTarget &&
      challenge.remoteAvailable &&
      !challenge.remoteTargetIgnored &&
      options.targetAction
        ? [
            targetTool(
              "get_target",
              "Get target",
              "Get the current remote challenge target status and endpoints",
              "get"
            ),
            targetTool(
              "start_target",
              "Start target",
              "Start the remote challenge target and wait until it is ready",
              "start"
            ),
            targetTool(
              "extend_target",
              "Extend target",
              "Extend the remote challenge target lifetime",
              "extend"
            ),
            targetTool(
              "stop_target",
              "Stop target",
              "Stop the remote challenge target",
              "stop"
            ),
          ]
        : []
    const tools = [
      ...createWorkspaceTools(backend),
      ...(isMain
        ? [
            finishRun,
            ...(challenge?.remoteId && challenge.remoteAvailable
              ? [submitFlag]
              : []),
            spawnAgent,
            inspectAgent,
            ...targetTools,
          ]
        : []),
    ]
    const secrets = new Set(options.getApiKeys?.(provider))
    const logicalCwd =
      environment.type === "container" ? "/workspace" : "$WORKSPACE"
    if (!challenge) throw new RunStartError("Challenge is unavailable")
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
    const runtime = createAgentRuntime({
      db,
      agentId,
      systemPrompt,
      model,
      models: options.modelService.models,
      tools,
      secrets,
      thinkingLevel,
      canRunTool: () =>
        getStored(runId)?.status === "running" &&
        getStoredAgent(agentId)?.status === "running",
      onEvent: (event, messageId) => {
        for (const secret of options.getApiKeys?.(provider) ?? []) {
          runtime.addSecrets([secret])
        }
        emit(runId, {
          type: "agent_event",
          agentId,
          event,
          ...(messageId ? { messageId } : {}),
        })
      },
      onSettled: (outcome) =>
        isMain
          ? handleMainSettled(runId, agentId, outcome)
          : handleChildSettled(runId, agentId, outcome),
    })
    current.set(agentId, { runId, agentId, runtime })
    return runtime
  }

  async function handleMainSettled(
    runId: string,
    agentId: string,
    outcome: RuntimeOutcome
  ) {
    if (closed) return
    const storedRun = getStored(runId)
    if (
      !storedRun ||
      terminalRunStatuses.includes(storedRun.status as RunStatus)
    ) {
      releaseRun(runId)
      return
    }
    if (aborting.has(runId) || getStoredAgent(agentId)?.status !== "running")
      return
    if (outcome.status === "success") {
      updateAgent(agentId, { status: "idle" })
      return
    }
    const error = outcome.error ?? "Agent session failed"
    update(runId, {
      status: "failed",
      completedAt: new Date().toISOString(),
      error,
    })
    updateAgent(agentId, {
      status: "failed",
      completedAt: new Date().toISOString(),
      summary: outcome.summary,
      error,
    })
    for (const child of listStoredAgents(runId)) {
      if (
        child.id !== agentId &&
        !terminalAgentStatuses.includes(child.status as AgentStatus)
      ) {
        updateAgent(child.id, {
          status: "stopped",
          completedAt: new Date().toISOString(),
        })
      }
    }
    await abortRun(runId, agentId)
    releaseRun(runId)
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

  function messageRowsForAgent(agentId: string) {
    const agent = getStoredAgent(agentId)
    if (!agent) throw new RunActionError("not_found", "Agent not found")
    return db
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.agentId, agentId))
      .orderBy(asc(agentMessages.sequence))
      .all()
  }

  function messagesForAgent(agentId: string): AgentMessage[] {
    return messageRowsForAgent(agentId).map(
      ({ message }) => JSON.parse(message) as AgentMessage
    )
  }

  function historyForAgent(agentId: string) {
    let parentId: string | null = null
    return messageRowsForAgent(agentId).map((row) => {
      const entry = {
        type: "message" as const,
        id: row.id,
        parentId,
        timestamp: row.createdAt,
        message: publicAgentMessage(JSON.parse(row.message) as AgentMessage),
      }
      parentId = row.id
      return entry
    })
  }

  function usageForAgent(agentId: string) {
    const agent = getStoredAgent(agentId)
    if (!agent) throw new RunActionError("not_found", "Agent not found")
    const run = getStored(agent.runId)
    if (!run) throw new RunActionError("not_found", "Run not found")
    const costKnown = parseModelConfig(run.modelConfig).costKnown !== false
    return sumUsage([
      summarizeUsage(messagesForAgent(agentId), costKnown),
      summarizeUsageRecords(
        db
          .select({ usage: agentUsage.usage })
          .from(agentUsage)
          .where(eq(agentUsage.agentId, agentId))
          .all()
          .map(({ usage }) => JSON.parse(usage) as Usage),
        costKnown
      ),
    ])
  }

  function toolStatsForAgent(agentId: string) {
    return db
      .select({
        toolName: agentToolCalls.toolName,
        callCount: count(),
        failedCount: sql<number>`coalesce(sum(case when ${agentToolCalls.succeeded} = 0 then 1 else 0 end), 0)`,
        durationMs: sql<number>`coalesce(sum(${agentToolCalls.durationMs}), 0)`,
        outputBytes: sql<number>`coalesce(sum(${agentToolCalls.outputBytes}), 0)`,
        truncatedCount: sql<number>`coalesce(sum(case when ${agentToolCalls.truncated} = 1 then 1 else 0 end), 0)`,
      })
      .from(agentToolCalls)
      .where(eq(agentToolCalls.agentId, agentId))
      .groupBy(agentToolCalls.toolName)
      .orderBy(agentToolCalls.toolName)
      .all()
      .map((value) => ({
        ...value,
        callCount: Number(value.callCount),
        failedCount: Number(value.failedCount),
        durationMs: Number(value.durationMs),
        outputBytes: Number(value.outputBytes),
        truncatedCount: Number(value.truncatedCount),
      }))
  }

  function inspectorForAgent(agentId: string): AgentInspector {
    const stored = getStoredAgent(agentId)
    const agent = getAgentPublic(agentId)
    if (!stored || !agent) {
      throw new RunActionError("not_found", "Agent not found")
    }
    const runtime = parseRuntimeSnapshot(stored.runtimeSnapshot)
    if (runtime) {
      replaceText(runtime, dataDir, "$DATA")
      replaceText(runtime, homedir(), "$HOME")
    }
    return {
      agent,
      task: stored.task,
      runtime,
      usage: usageForAgent(agentId),
      toolStats: toolStatsForAgent(agentId),
    }
  }

  function lastAssistantText(entries: AgentMessage[]) {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const message = entries[index]
      if (message.role !== "assistant") continue
      const text = message.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n")
        .trim()
      if (text) return text.slice(0, 50_000)
    }
    return null
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
    db.insert(runAgents)
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
    emit(runId, {
      type: "agent_status",
      agent: getAgentPublic(id) as AgentPublic,
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
    db.insert(runs)
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
    db.insert(runAgents)
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
      update(id, {
        status: "failed",
        completedAt: new Date().toISOString(),
        error:
          error instanceof RunStartError
            ? error.message
            : "Agent session failed",
      })
      updateAgent(id, {
        status: "failed",
        completedAt: new Date().toISOString(),
        error:
          error instanceof RunStartError
            ? error.message
            : "Agent session failed",
      })
      releaseRun(id)
    }
    return getPublic(id) as RunPublic
  }

  async function pause(runId: string) {
    requireMutable(runId, ["running"])
    aborting.set(runId, "paused")
    try {
      await abortRun(runId)
      const latest = getPublic(runId) as RunPublic
      if (terminalRunStatuses.includes(latest.status)) return latest
      const paused = update(runId, { status: "paused" })
      for (const agent of listStoredAgents(runId)) {
        if (agent.status === "running" || agent.status === "idle") {
          updateAgent(agent.id, { status: "paused" })
        }
      }
      releaseRun(runId)
      return paused
    } finally {
      aborting.delete(runId)
    }
  }

  async function resume(runId: string, message?: string) {
    requireMutable(runId, ["paused"])
    const pausedAgents = listStoredAgents(runId).filter(
      (agent) => agent.status === "paused"
    )
    const main = pausedAgents.find((agent) => agent.parentAgentId === null)
    if (!main)
      throw new RunActionError("invalid_state", "Main agent is unavailable")
    requireCapacity(pausedAgents.length)
    update(runId, { status: "running", error: null, completedAt: null })
    for (const agent of pausedAgents) {
      updateAgent(agent.id, {
        status: "running",
        error: null,
        completedAt: null,
      })
    }
    try {
      const runtime = await ensureSession(main.id)
      runtime.replayPending()
      runtime.dispatch(
        "resume",
        message?.trim() ||
          "Continue solving the challenge from the current state."
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
      return getPublic(runId) as RunPublic
    } catch (error) {
      const failed = update(runId, {
        status: "failed",
        completedAt: new Date().toISOString(),
        error:
          error instanceof RunStartError
            ? error.message
            : "Agent session failed",
      })
      updateAgent(main.id, {
        status: "failed",
        completedAt: new Date().toISOString(),
        error: failed.error,
      })
      for (const child of listStoredAgents(runId)) {
        if (!terminalAgentStatuses.includes(child.status as AgentStatus)) {
          updateAgent(child.id, {
            status: "stopped",
            completedAt: new Date().toISOString(),
          })
        }
      }
      await abortRun(runId)
      releaseRun(runId)
      return failed
    }
  }

  async function message(runId: string, messageText: string) {
    const run = requireMutable(runId, ["running", "paused"])
    if (run.status === "paused") return resume(runId, messageText)
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
    runtime.dispatch("user", messageText)
    return getPublic(runId) as RunPublic
  }

  async function stop(runId: string) {
    requireMutable(runId, ["running", "paused"])
    aborting.set(runId, "stopped")
    try {
      await abortRun(runId)
      const latest = getPublic(runId) as RunPublic
      if (terminalRunStatuses.includes(latest.status)) return latest
      const stopped = update(runId, {
        status: "stopped",
        completedAt: new Date().toISOString(),
      })
      for (const agent of listStoredAgents(runId)) {
        if (!terminalAgentStatuses.includes(agent.status as AgentStatus)) {
          updateAgent(agent.id, {
            status: "stopped",
            completedAt: new Date().toISOString(),
          })
        }
      }
      releaseRun(runId)
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
    history: historyForAgent,
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
    subscribe: (
      runId: string,
      listener: RunEventListener,
      afterSequence = 0
    ) => {
      for (const entry of eventHistory.get(runId) ?? []) {
        if (entry.sequence > afterSequence) {
          listener(entry.event, entry.sequence, true)
        }
      }
      const runListeners = listeners.get(runId) ?? new Set()
      runListeners.add(listener)
      listeners.set(runId, runListeners)
      return () => {
        runListeners.delete(listener)
        if (runListeners.size === 0) {
          listeners.delete(runId)
          const status = getPublic(runId)?.status
          if (status && terminalRunStatuses.includes(status)) {
            eventSequences.delete(runId)
            eventHistory.delete(runId)
          }
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
    close: () => {
      if (closed) return
      closed = true
      for (const { runtime } of current.values()) {
        runtime.dispose()
      }
      current.clear()
      for (const name of activeContainers.values()) removeContainer(name)
      activeContainers.clear()
      listeners.clear()
      eventSequences.clear()
      eventHistory.clear()
    },
  }
}

function parseEnvironment(value: string): EnvironmentConfig {
  try {
    const parsed = JSON.parse(value) as Partial<EnvironmentConfig>
    if (parsed.type === "container" && typeof parsed.image === "string") {
      return {
        type: "container",
        image: parsed.image,
        cpus:
          "cpus" in parsed && typeof parsed.cpus === "number" ? parsed.cpus : 1,
        memoryMb:
          "memoryMb" in parsed && typeof parsed.memoryMb === "number"
            ? parsed.memoryMb
            : 512,
        pidsLimit:
          "pidsLimit" in parsed && typeof parsed.pidsLimit === "number"
            ? parsed.pidsLimit
            : 128,
      }
    }
  } catch {
    // Existing and malformed rows remain local rather than gaining container access.
  }
  return { type: "local" }
}

function parsePromptConfig(value: string): FrozenPromptConfig {
  try {
    const parsed = JSON.parse(value) as Partial<FrozenPromptConfig> & {
      systemPromptTemplate?: string
    }
    return {
      ...resolvePromptTemplates({
        mainSystemPromptTemplate:
          typeof parsed.mainSystemPromptTemplate === "string"
            ? parsed.mainSystemPromptTemplate
            : "",
        childSystemPromptTemplate:
          typeof parsed.childSystemPromptTemplate === "string"
            ? parsed.childSystemPromptTemplate
            : "",
        initialPromptTemplate:
          typeof parsed.initialPromptTemplate === "string"
            ? parsed.initialPromptTemplate
            : "",
        systemPromptTemplate: parsed.systemPromptTemplate,
      }),
      ...(parsed.context && typeof parsed.context === "object"
        ? { context: parsed.context }
        : {}),
    }
  } catch {
    return resolvePromptTemplates({
      mainSystemPromptTemplate: "",
      childSystemPromptTemplate: "",
      initialPromptTemplate: "",
    })
  }
}

function parseModelConfig(value: string): ModelConfig {
  try {
    const parsed = JSON.parse(value) as Partial<ModelConfig>
    return {
      provider: typeof parsed.provider === "string" ? parsed.provider : "",
      ...(typeof parsed.providerLabel === "string"
        ? { providerLabel: parsed.providerLabel }
        : {}),
      modelId: typeof parsed.modelId === "string" ? parsed.modelId : "",
      ...(typeof parsed.modelLabel === "string"
        ? { modelLabel: parsed.modelLabel }
        : {}),
      ...(typeof parsed.baseUrl === "string"
        ? { baseUrl: parsed.baseUrl }
        : {}),
      ...(parsed.costKnown === false ? { costKnown: false } : {}),
      thinkingLevel:
        parsed.thinkingLevel === "minimal" ||
        parsed.thinkingLevel === "low" ||
        parsed.thinkingLevel === "medium" ||
        parsed.thinkingLevel === "high" ||
        parsed.thinkingLevel === "xhigh" ||
        parsed.thinkingLevel === "max"
          ? parsed.thinkingLevel
          : "off",
    }
  } catch {
    return { provider: "", modelId: "", thinkingLevel: "off" }
  }
}

function parseRuntimeSnapshot(
  value: string | null
): AgentRuntimeSnapshot | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as Partial<AgentRuntimeSnapshot>
    if (
      typeof parsed.capturedAt !== "string" ||
      typeof parsed.systemPrompt !== "string" ||
      typeof parsed.cwd !== "string" ||
      !parsed.model ||
      typeof parsed.model.provider !== "string" ||
      typeof parsed.model.modelId !== "string" ||
      !Array.isArray(parsed.tools)
    ) {
      return null
    }
    const thinkingLevel =
      parsed.model.thinkingLevel === "minimal" ||
      parsed.model.thinkingLevel === "low" ||
      parsed.model.thinkingLevel === "medium" ||
      parsed.model.thinkingLevel === "high" ||
      parsed.model.thinkingLevel === "xhigh" ||
      parsed.model.thinkingLevel === "max"
        ? parsed.model.thinkingLevel
        : "off"
    return {
      ...parsed,
      model: { ...parsed.model, thinkingLevel },
    } as AgentRuntimeSnapshot
  } catch {
    return null
  }
}

export class RunActionError extends Error {
  constructor(
    readonly code: "capacity" | "not_found" | "invalid_state",
    message: string
  ) {
    super(message)
  }
}

class RunStartError extends Error {}
