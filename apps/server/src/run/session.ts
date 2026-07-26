import { homedir } from "node:os"
import { join } from "node:path"
import type { Api, Model } from "@earendil-works/pi-ai"
import { clampThinkingLevel } from "@earendil-works/pi-ai"
import { eq } from "drizzle-orm"
import type {
  AgentPublic,
  EnvironmentConfig,
  FrozenPromptConfig,
  LiveEvent,
  ModelConfig,
} from "../../../shared"
import {
  type AgentRuntime,
  createAgentRuntime,
  createRuntimePersistence,
} from "../agent/runtime"
import type { createDatabase } from "../db"
import { agents, challenges } from "../db/schema"
import type { FlatSettings } from "../infrastructure/config-store"
import { redactSecrets, replaceText } from "../infrastructure/redaction"
import {
  getChallengeRemote,
  isPlatformIntegrated,
  isTargetCapable,
} from "../platforms/challenge-state"
import type { TargetState } from "../platforms/core"
import type { ModelService } from "../providers/models"
import { renderSystemPrompt } from "../settings/prompt-templates"
import { type ContainerPool, createContainerPool } from "./container-pool"
import { RunStartError } from "./errors"
import type { RuntimePort } from "./runtime-port"
import type { RunStore } from "./store"
import { createRunTools } from "./tools"
import type { DispatchKind } from "./types"

type Database = ReturnType<typeof createDatabase>["db"]
type ResolvedModel = Model<Api>

export type AgentSession = {
  runId: string
  agentId: string
  runtime: AgentRuntime
  generation: number
}

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

export type SessionHost = {
  db: Database
  dataDir: string
  store: RunStore
  sessions: SessionRegistry
  containers: ContainerPool
  modelService: ModelService
  getSettings(): FlatSettings
  getApiKeys?: (provider: string) => Iterable<string>
  onLiveEvent(runId: string, event: LiveEvent): void
  onSettled(
    runId: string,
    agentId: string,
    outcome: {
      status: "success" | "error" | "aborted"
      summary: string | null
      error: string | null
    }
  ): void | Promise<void>
  requestFinish(runId: string, summary: string): void | Promise<void>
  spawnChild(
    runId: string,
    parentId: string,
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
}

export function createSessionRuntime(host: SessionHost): RuntimePort {
  const {
    db,
    dataDir,
    sessions,
    containers,
    modelService,
    getSettings,
    getApiKeys,
  } = host
  const store = () => host.store

  async function resolveModel(config: ModelConfig): Promise<ResolvedModel> {
    const model = modelService.find(config.provider, config.modelId)
    if (!model) throw new RunStartError("Requested model is unavailable")
    if (!(await modelService.models.getAuth(model))) {
      throw new RunStartError(
        "Credentials for the requested model are unavailable"
      )
    }
    return model
  }

  async function attach(runId: string, agentId: string) {
    if (sessions.get(agentId)) return

    const state = store().loadAggregate(runId)
    if (!state) throw new RunStartError("Run is unavailable")
    const agent = state.agents.find((row) => row.id === agentId)
    if (!agent) throw new RunStartError("Agent is unavailable")
    if (!state.workspacePath) {
      throw new RunStartError("Run workspace is unavailable")
    }

    let modelConfig: ModelConfig
    let environment: EnvironmentConfig
    let promptConfig: FrozenPromptConfig
    try {
      modelConfig = JSON.parse(state.modelJson) as ModelConfig
      environment = JSON.parse(state.envJson) as EnvironmentConfig
      promptConfig = JSON.parse(state.promptJson) as FrozenPromptConfig
    } catch {
      throw new RunStartError("Run configuration is invalid")
    }

    const model = await resolveModel(modelConfig)
    const workspacePath = join(dataDir, state.workspacePath)
    const generation = sessions.nextGeneration(agentId)
    const isMain = agent.parentAgentId === null
    const settings = getSettings()
    const backend = await containers.ensureBackend(
      runId,
      state.workspacePath,
      environment,
      settings
    )

    const challenge = db
      .select()
      .from(challenges)
      .where(eq(challenges.id, state.challengeId))
      .get()
    if (!challenge) throw new RunStartError("Challenge is unavailable")
    const remote = getChallengeRemote(db, challenge.id)

    const tools = createRunTools({
      runId,
      agentId,
      isMain,
      challengeId: challenge.id,
      challenge: {
        platformIntegrated: isPlatformIntegrated(remote),
        targetCapable: isTargetCapable(remote),
      },
      backend,
      toolLimits: {
        maxOutput: settings["runtime.maxToolOutputBytes"],
        maxShellOutput: settings["runtime.maxInlineShellOutputBytes"],
        maxCapturedShellOutput: settings["runtime.maxCapturedShellOutputBytes"],
      },
      getRun: () => store().loadAggregate(runId),
      requestFinish: (summary) => {
        void host.requestFinish(runId, summary)
      },
      getAgent: (id) =>
        store()
          .loadAggregate(runId)
          ?.agents.find((a) => a.id === id),
      messagesForAgent: (id) => store().listMessages(id),
      spawnChild: (name, task, signal) =>
        host.spawnChild(runId, agentId, name, task, signal),
      canFinishRun: host.canFinishRun,
      submitFlag: host.submitFlag,
      targetAction: host.targetAction,
    })

    const secrets = new Set(getApiKeys?.(modelConfig.provider))
    const logicalCwd =
      environment.type === "container"
        ? settings["container.workspace"]
        : "$WORKSPACE"
    const thinkingLevel = clampThinkingLevel(model, modelConfig.thinkingLevel)
    const systemPrompt = renderSystemPrompt(
      isMain
        ? promptConfig.mainSystemPromptTemplate
        : promptConfig.childSystemPromptTemplate,
      promptConfig.context ?? {
        agent: {
          role: isMain ? "main" : "child",
          isMain,
          name: agent.name,
          task: agent.task,
        },
        event: { id: "", name: "", platform: null, promptHint: "" },
        challenge: {
          id: challenge.id,
          name: challenge.name,
          description: challenge.description,
          category: challenge.category,
          points: challenge.points,
          attachments: [],
          attachmentPaths: [],
        },
        model: {
          provider: modelConfig.provider,
          name: modelConfig.modelLabel ?? modelConfig.modelId,
          id: modelConfig.modelId,
        },
        run: {
          id: runId,
          environment: environment.type,
          isContainer: environment.type === "container",
          workspace: logicalCwd,
          targetSupported: isTargetCapable(remote),
          platformIntegrated: isPlatformIntegrated(remote),
          containerImage:
            environment.type === "container" ? environment.image : null,
          cpus: environment.type === "container" ? environment.cpus : null,
          memoryMb:
            environment.type === "container" ? environment.memoryMb : null,
          pidsLimit:
            environment.type === "container" ? environment.pidsLimit : null,
        },
        capabilities: {
          canFinishRun: isMain,
          canSpawnAgent: isMain,
          canSubmitFlag: isMain && isPlatformIntegrated(remote),
          canManageTarget: isMain && isTargetCapable(remote),
        },
      }
    )

    // Keep tools metadata simple: never run path replacement over tool schemas.
    const toolsMeta = tools.map((tool) => ({
      name: String(tool.name),
      description: String(tool.description ?? ""),
      parameters: {},
    }))
    let promptText = systemPrompt
    let cwdText = logicalCwd
    try {
      promptText = redactSecrets(systemPrompt, secrets)
      for (const [from, to] of [
        [workspacePath, logicalCwd],
        [
          state.workspacePath ? join(dataDir, state.workspacePath) : "",
          "$WORKSPACE",
        ],
        [dataDir, "$DATA"],
        [homedir(), "$HOME"],
      ] as const) {
        if (from) {
          promptText = replaceText(promptText, from, to)
          cwdText = replaceText(cwdText, from, to)
        }
      }
    } catch (error) {
      console.error("Failed to redact runtime snapshot paths", error)
    }
    const snapshotPayload = {
      capturedAt: new Date().toISOString(),
      systemPrompt: promptText,
      cwd: cwdText,
      model: {
        provider: modelConfig.providerLabel ?? modelConfig.provider,
        modelId: model.id,
        thinkingLevel,
      },
      tools: toolsMeta,
    }
    const snapshotJson = JSON.stringify(snapshotPayload)
    db.update(agents)
      .set({ runtimeSnapshot: snapshotJson })
      .where(eq(agents.id, agentId))
      .run()

    const persistence = createRuntimePersistence({
      db,
      agentId,
      commitMessage: (message) => store().insertMessage(message),
      loadMessages: () => store().listMessages(agentId),
    })

    const runtime = createAgentRuntime({
      db,
      runId,
      agentId,
      systemPrompt,
      model,
      models: modelService.models,
      tools,
      secrets,
      thinkingLevel,
      retryConfig: {
        maxAttempts: settings["runtime.maxRetryAttempts"],
        baseDelayMs: settings["runtime.retryBaseDelayMs"],
        maxDelayMs: settings["runtime.retryMaxDelayMs"],
      },
      getToolTimeoutSettings: () => getSettings(),
      callbacks: {
        ...persistence,
        canRunTool: () => {
          if (containers.hasFailure(runId)) return false
          const live = store().loadAggregate(runId)
          const liveAgent = live?.agents.find((a) => a.id === agentId)
          return live?.status === "running" && liveAgent?.status === "running"
        },
        onLiveEvent: (event) => {
          if (!sessions.isCurrent(agentId, generation)) return
          host.onLiveEvent(runId, event)
        },
        onSettled: (outcome) => {
          if (!sessions.isCurrent(agentId, generation)) return
          return host.onSettled(runId, agentId, outcome)
        },
      },
    })

    sessions.set({ runId, agentId, runtime, generation })
  }

  return {
    async attach(runId, agentId) {
      await attach(runId, agentId)
    },
    dispatch(input) {
      const session = sessions.get(input.agentId)
      if (!session) {
        // attach may be async; best-effort — service orders attach before dispatch
        console.error("dispatch without session", input.agentId)
        return
      }
      for (const secret of getApiKeys?.(
        (() => {
          try {
            const state = store().loadAggregate(input.runId)
            if (!state) return ""
            return (JSON.parse(state.modelJson) as ModelConfig).provider
          } catch {
            return ""
          }
        })()
      ) ?? []) {
        session.runtime.addSecrets([secret])
      }
      session.runtime.dispatch(input.kind as DispatchKind, input.text)
    },
    async abort(runId, exceptAgentId) {
      await sessions.abortRun(runId, exceptAgentId)
    },
    release(agentId) {
      sessions.release(agentId)
    },
    async releaseRun(runId) {
      sessions.releaseRun(runId)
      await containers.release(runId)
    },
  }
}

export function createLiveSessionStack(options: {
  db: Database
  dataDir: string
  store: RunStore
  modelService: ModelService
  getSettings(): FlatSettings
  getApiKeys?: (provider: string) => Iterable<string>
  onLiveEvent(runId: string, event: LiveEvent): void
  onSettled: SessionHost["onSettled"]
  requestFinish: SessionHost["requestFinish"]
  spawnChild: SessionHost["spawnChild"]
  canFinishRun?: SessionHost["canFinishRun"]
  submitFlag?: SessionHost["submitFlag"]
  targetAction?: SessionHost["targetAction"]
  onContainerFailure?(runId: string): void
}) {
  const sessions = createSessionRegistry()
  const containers = createContainerPool({
    dataDir: options.dataDir,
    onFailure: (runId) => {
      void sessions.abortRun(runId)
      options.onContainerFailure?.(runId)
    },
  })
  const runtime = createSessionRuntime({
    db: options.db,
    dataDir: options.dataDir,
    store: options.store,
    sessions,
    containers,
    modelService: options.modelService,
    getSettings: options.getSettings,
    getApiKeys: options.getApiKeys,
    onLiveEvent: options.onLiveEvent,
    onSettled: options.onSettled,
    requestFinish: options.requestFinish,
    spawnChild: options.spawnChild,
    canFinishRun: options.canFinishRun,
    submitFlag: options.submitFlag,
    targetAction: options.targetAction,
  })
  return { sessions, containers, runtime }
}
