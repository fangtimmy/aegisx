import { rmSync } from "node:fs"
import { join } from "node:path"
import { eq } from "drizzle-orm"
import type {
  AgentSummary,
  EnvironmentConfig,
  FrozenPromptConfig,
  LiveEvent,
  ModelConfig,
  RunPublic,
  UsageSummary,
} from "../../../shared"
import { isTerminalRunStatus } from "../../../shared"
import type { createDatabase } from "../db"
import { challenges } from "../db/schema"
import { createLiveBus } from "./bus"
import { RunActionError } from "./errors"
import { activeAgentCount, pausedAgentCount, reduce } from "./machine"
import type { RuntimePort } from "./runtime-port"
import { createRunStore } from "./store"
import type { AgentOutcome, Cmd, Effect, RunAggregate } from "./types"
import { mainAgent } from "./types"

type Database = ReturnType<typeof createDatabase>["db"]

const DEFAULT_RESUME = "Continue solving the challenge from the current state."

export type RunServiceOptions = {
  db: Database
  dataDir?: string
  maxConcurrency: number
  runtime: RuntimePort
  now?: () => string
  newId?: () => string
  onLiveEvent?: (runId: string, event: LiveEvent) => void
  /** Challenge display fields for public mapping (optional in Phase 2). */
  resolveChallenge?: (challengeId: string) =>
    | {
        name: string
        eventId: string
        targetSupported: boolean
      }
    | undefined
  /** Live session count; optional for fake runtime tests. */
  activeSessionCount?: () => number
}

export function createRunService(options: RunServiceOptions) {
  const store = createRunStore(options.db)
  const bus = createLiveBus()
  const locks = new Map<string, Promise<unknown>>()
  const aborting = new Set<string>()
  let maxConcurrency = options.maxConcurrency
  let closed = false
  const now = () => options.now?.() ?? new Date().toISOString()
  const newId = () => options.newId?.() ?? crypto.randomUUID()

  function withLock<T>(runId: string, operation: () => T | Promise<T>) {
    if (closed) {
      return Promise.reject(
        new RunActionError("invalid_state", "Run manager is closed")
      )
    }
    const previous = locks.get(runId) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(operation)
    locks.set(runId, next)
    return next.finally(() => {
      if (locks.get(runId) === next) locks.delete(runId)
    }) as Promise<T>
  }

  function requireCapacity(extra: number) {
    if (store.globalActiveAgentCount() + extra > maxConcurrency) {
      throw new RunActionError("capacity", "Run capacity reached")
    }
  }

  function emit(runId: string, event: LiveEvent) {
    bus.emit(runId, event)
    options.onLiveEvent?.(runId, event)
  }

  function resolveChallenge(challengeId: string) {
    return (
      options.resolveChallenge?.(challengeId) ??
      store.challengeMeta(challengeId)
    )
  }

  async function applyEffects(runId: string, effects: Effect[]): Promise<void> {
    for (const effect of effects) {
      switch (effect.t) {
        case "insert_message": {
          const message = store.insertMessage(effect.message)
          emit(runId, {
            type: "message.committed",
            agentId: message.agentId,
            message,
          })
          break
        }
        case "abort_all":
          aborting.add(runId)
          try {
            await options.runtime.abort(runId, effect.exceptAgentId)
          } finally {
            aborting.delete(runId)
          }
          break
        case "release_all":
          await options.runtime.releaseRun(runId)
          break
        case "release_agent":
          options.runtime.release(effect.agentId)
          break
        case "attach":
          await options.runtime.attach(runId, effect.agentId)
          break
        case "dispatch":
          options.runtime.dispatch({
            runId,
            agentId: effect.agentId,
            kind: effect.kind,
            text: effect.text,
            messageId: effect.messageId,
            clientMessageId: effect.clientMessageId,
            handoff: effect.handoff,
          })
          break
      }
    }
  }

  function emitState(state: RunAggregate) {
    const run = toRunPublic(state)
    emit(state.id, { type: "run.updated", run })
    for (const agent of state.agents) {
      emit(state.id, {
        type: "agent.updated",
        agent: {
          ...agent,
          usage: store.usageForAgent(agent.id),
        },
      })
    }
  }

  function toRunPublic(state: RunAggregate): RunPublic {
    let model: ModelConfig
    let env: EnvironmentConfig
    try {
      model = JSON.parse(state.modelJson) as ModelConfig
      env = JSON.parse(state.envJson) as EnvironmentConfig
    } catch {
      model = {
        provider: "unknown",
        modelId: "unknown",
        thinkingLevel: "off",
      }
      env = { type: "local" }
    }
    const challenge = resolveChallenge(state.challengeId)
    return {
      id: state.id,
      mainAgentId: state.mainAgentId,
      challengeId: state.challengeId,
      challengeName: challenge?.name ?? "",
      eventId: challenge?.eventId ?? "",
      status: state.status,
      provider: model.providerLabel ?? model.provider,
      modelId: model.modelId,
      modelName: model.modelLabel ?? model.modelId,
      thinkingLevel: model.thinkingLevel,
      environment: env.type,
      targetSupported: challenge?.targetSupported ?? false,
      image: env.type === "container" ? env.image : null,
      cpus: env.type === "container" ? env.cpus : undefined,
      memoryMb: env.type === "container" ? env.memoryMb : undefined,
      pidsLimit: env.type === "container" ? env.pidsLimit : undefined,
      createdAt: state.createdAt,
      startedAt: state.startedAt,
      updatedAt: state.updatedAt,
      completedAt: state.completedAt,
      error: state.error,
      summary: state.summary,
      hasFlag: Boolean(state.flag),
      flag: state.flag,
    }
  }

  async function apply(
    runId: string,
    cmd: Cmd,
    existing?: RunAggregate | null
  ): Promise<RunAggregate> {
    const current =
      existing === undefined ? store.loadAggregate(runId) : existing
    const result = reduce(current, cmd)
    if (!result.ok) {
      throw new RunActionError(result.code, result.message)
    }
    store.saveAggregate(result.state)
    await applyEffects(runId, result.effects)
    emitState(result.state)
    return result.state
  }

  async function create(input: {
    challengeId: string
    model: ModelConfig
    env?: EnvironmentConfig
    prompt: FrozenPromptConfig
    workspacePath: string
    bootstrapText: string
    /** Optional fixed ids (HTTP layer aligns workspace path with run id). */
    runId?: string
    mainAgentId?: string
  }): Promise<RunPublic> {
    const challenge = options.db
      .select()
      .from(challenges)
      .where(eq(challenges.id, input.challengeId))
      .get()
    if (!challenge) {
      throw new RunActionError("not_found", "Challenge not found")
    }
    requireCapacity(1)
    const runId = input.runId ?? newId()
    const mainAgentId = input.mainAgentId ?? newId()
    const bootstrapMessageId = newId()
    const timestamp = now()
    return withLock(runId, async () => {
      if (store.loadAggregate(runId)) {
        throw new RunActionError("invalid_state", "Run already exists")
      }
      const state = await apply(
        runId,
        {
          t: "create",
          runId,
          mainAgentId,
          challengeId: input.challengeId,
          model: input.model,
          env: input.env ?? { type: "local" },
          prompt: input.prompt,
          workspacePath: input.workspacePath,
          bootstrapText: input.bootstrapText,
          bootstrapMessageId,
          now: timestamp,
        },
        null
      )
      return toRunPublic(state)
    })
  }

  function pause(runId: string) {
    return withLock(runId, () =>
      apply(runId, { t: "pause", now: now() }).then(toRunPublic)
    )
  }

  function resume(runId: string, message?: string, clientMessageId?: string) {
    return withLock(runId, async () => {
      const current = store.loadAggregate(runId)
      if (!current) {
        throw new RunActionError("not_found", "Run not found")
      }
      if (clientMessageId) {
        const main = mainAgent(current)
        if (main) {
          const existing = store.findByClientMessageId(main.id, clientMessageId)
          if (existing) return toRunPublic(current)
        }
      }
      requireCapacity(pausedAgentCount(current))
      const text = message?.trim() || DEFAULT_RESUME
      const state = await apply(
        runId,
        {
          t: "resume",
          text,
          messageId: newId(),
          clientMessageId,
          now: now(),
        },
        current
      )
      return toRunPublic(state)
    })
  }

  function stop(runId: string) {
    return withLock(runId, () =>
      apply(runId, { t: "stop", now: now() }).then(toRunPublic)
    )
  }

  function postMessage(runId: string, text: string, clientMessageId?: string) {
    return withLock(runId, async () => {
      const current = store.loadAggregate(runId)
      if (!current) {
        throw new RunActionError("not_found", "Run not found")
      }
      const main = mainAgent(current)
      if (!main) {
        throw new RunActionError("invalid_state", "Main agent is unavailable")
      }
      if (clientMessageId) {
        const existing = store.findByClientMessageId(main.id, clientMessageId)
        if (existing) return toRunPublic(current)
      }
      const state = await apply(
        runId,
        {
          t: "user_message",
          text,
          messageId: newId(),
          clientMessageId,
          now: now(),
        },
        current
      )
      return toRunPublic(state)
    })
  }

  function requestFinish(runId: string, summary: string) {
    return withLock(runId, () =>
      apply(runId, { t: "request_finish", summary }).then(toRunPublic)
    )
  }

  function spawn(runId: string, parentId: string, name: string, task: string) {
    return withLock(runId, async () => {
      requireCapacity(1)
      const agentId = newId()
      const state = await apply(runId, {
        t: "spawn",
        agentId,
        parentId,
        name,
        task,
        taskMessageId: newId(),
        now: now(),
      })
      const child = state.agents.find((agent) => agent.id === agentId)
      if (!child) throw new Error("spawn failed")
      return child
    })
  }

  function onSettled(runId: string, agentId: string, outcome: AgentOutcome) {
    if (closed || aborting.has(runId)) return Promise.resolve()
    return withLock(runId, async () => {
      if (closed || aborting.has(runId)) return
      const current = store.loadAggregate(runId)
      if (!current) return
      const agent = current.agents.find((row) => row.id === agentId)
      if (!agent) return
      if (agent.parentAgentId === null) {
        await apply(runId, { t: "main_settled", outcome, now: now() }, current)
      } else {
        await apply(
          runId,
          {
            t: "child_settled",
            agentId,
            outcome,
            noticeMessageId: newId(),
            now: now(),
          },
          current
        )
      }
    })
  }

  function containerFailed(runId: string, error: string) {
    return withLock(runId, () =>
      apply(runId, {
        t: "container_failed",
        error,
        now: now(),
      }).then(toRunPublic)
    )
  }

  async function recoverOnBoot() {
    for (const runId of store.listRunningRunIds()) {
      await withLock(runId, () =>
        apply(runId, { t: "recover_on_boot", now: now() })
      )
    }
  }

  function get(runId: string): RunPublic | undefined {
    const state = store.loadAggregate(runId)
    return state ? toRunPublic(state) : undefined
  }

  function getAggregate(runId: string) {
    return store.loadAggregate(runId)
  }

  function agents(runId: string): AgentSummary[] {
    const state = store.loadAggregate(runId)
    if (!state) throw new RunActionError("not_found", "Run not found")
    return state.agents.map((agent) => ({
      ...agent,
      usage: store.usageForAgent(agent.id),
    }))
  }

  function agentUsage(agentId: string): UsageSummary {
    return store.usageForAgent(agentId)
  }

  function usage(runId: string): UsageSummary {
    const state = store.loadAggregate(runId)
    if (!state) throw new RunActionError("not_found", "Run not found")
    return state.agents
      .map((a) => store.usageForAgent(a.id))
      .reduce(
        (acc, item) => ({
          input: acc.input + item.input,
          output: acc.output + item.output,
          cacheRead: acc.cacheRead + item.cacheRead,
          cacheWrite: acc.cacheWrite + item.cacheWrite,
          totalTokens: acc.totalTokens + item.totalTokens,
          cost:
            acc.cost === null || item.cost === null
              ? null
              : (acc.cost ?? 0) + item.cost,
        }),
        {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: 0 as number | null,
        }
      )
  }

  function listForEvent(eventId: string): RunPublic[] {
    return store
      .listRunIdsForEvent(eventId)
      .map((id) => get(id))
      .filter((run): run is RunPublic => Boolean(run))
  }

  function listForChallenge(challengeId: string): RunPublic[] {
    return store
      .listRunIdsForChallenge(challengeId)
      .map((id) => get(id))
      .filter((run): run is RunPublic => Boolean(run))
  }

  function workspacePath(runId: string): string | undefined {
    const state = store.loadAggregate(runId)
    if (!state?.workspacePath || !options.dataDir) return undefined
    return join(options.dataDir, state.workspacePath)
  }

  async function deleteRun(runId: string) {
    const state = store.loadAggregate(runId)
    if (!state) throw new RunActionError("not_found", "Run not found")
    if (!isTerminalRunStatus(state.status)) {
      throw new RunActionError(
        "invalid_state",
        "Only completed, failed, or stopped runs can be deleted"
      )
    }
    await options.runtime.releaseRun(runId)
    if (state.workspacePath && options.dataDir) {
      rmSync(join(options.dataDir, state.workspacePath), {
        recursive: true,
        force: true,
      })
    }
    store.deleteRun(runId)
    bus.clearRun(runId)
  }

  /** Re-read DB aggregate and broadcast (e.g. after platform writes flag). */
  function refresh(runId: string): RunPublic | undefined {
    const state = store.loadAggregate(runId)
    if (!state) return undefined
    emitState(state)
    return toRunPublic(state)
  }

  function getAgent(runId: string, agentId: string): AgentSummary | undefined {
    const state = store.loadAggregate(runId)
    const row = state?.agents.find((a) => a.id === agentId)
    if (!row) return undefined
    return { ...row, usage: store.usageForAgent(agentId) }
  }

  function inspector(runId: string, agentId: string) {
    const state = store.loadAggregate(runId)
    const row = state?.agents.find((a) => a.id === agentId)
    if (!state || !row) return undefined
    let runtime: {
      capturedAt?: string
      systemPrompt?: string
      cwd?: string
      model?: unknown
      tools: Array<{ name: string; description?: string; parameters?: unknown }>
    } = { tools: [] }
    try {
      const snapshotText = store.getRuntimeSnapshot(agentId)
      if (snapshotText) {
        const parsed = JSON.parse(snapshotText) as {
          capturedAt?: string
          systemPrompt?: string
          cwd?: string
          model?: unknown
          tools?: Array<{
            name: string
            description?: string
            parameters?: unknown
          }>
        }
        runtime = {
          capturedAt: parsed.capturedAt,
          systemPrompt: parsed.systemPrompt ?? "",
          cwd: parsed.cwd ?? "",
          model: parsed.model,
          tools: Array.isArray(parsed.tools)
            ? parsed.tools.map((tool) => ({
                name: String(tool?.name ?? "unknown"),
                description: tool?.description,
                parameters: tool?.parameters ?? {},
              }))
            : [],
        }
      }
    } catch {
      runtime = { tools: [], systemPrompt: "" }
    }
    return {
      agent: {
        id: row.id,
        runId: row.runId,
        parentAgentId: row.parentAgentId,
        name: row.name,
        status: row.status,
        summary: row.summary,
        error: row.error,
        createdAt: row.createdAt,
        startedAt: row.startedAt,
        updatedAt: row.updatedAt,
        completedAt: row.completedAt,
      },
      task: row.task,
      runtime,
      usage: store.usageForAgent(agentId),
      toolStats: [],
    }
  }

  async function close() {
    closed = true
    await Promise.allSettled([...locks.values()])
    locks.clear()
    bus.clear()
  }

  return {
    create,
    pause,
    resume,
    stop,
    postMessage,
    requestFinish,
    spawn,
    onSettled,
    containerFailed,
    recoverOnBoot,
    get,
    getAggregate,
    getAgent,
    agents,
    inspector,
    usage,
    agentUsage,
    listForEvent,
    listForChallenge,
    workspacePath,
    delete: deleteRun,
    refresh,
    subscribe: bus.subscribe,
    store,
    setMaxConcurrency(value: number) {
      if (Number.isInteger(value) && value > 0) maxConcurrency = value
    },
    get maxConcurrency() {
      return maxConcurrency
    },
    close,
    activeAgentCount: (runId: string) => {
      const state = store.loadAggregate(runId)
      return state ? activeAgentCount(state) : 0
    },
    globalActiveAgentCount: () => store.globalActiveAgentCount(),
    activeSessionCount: () => options.activeSessionCount?.() ?? 0,
  }
}

export type RunService = ReturnType<typeof createRunService>
