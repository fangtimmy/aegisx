import { rmSync } from "node:fs"
import { join } from "node:path"
import { eq } from "drizzle-orm"
import type {
  EnvironmentConfig,
  FrozenPromptConfig,
  LiveEvent,
  ModelConfig,
  RunPublic,
} from "../../../shared"
import { isTerminalRunStatus } from "../../../shared"
import type { createDatabase } from "../db"
import { challenges } from "../db/schema"
import { createLiveBus } from "./bus"
import { RunActionError } from "./errors"
import { activeAgentCount, pausedAgentCount, reduce } from "./machine"
import { createRunQueries } from "./queries"
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
  const queries = createRunQueries({
    store,
    dataDir: options.dataDir,
    resolveChallenge: options.resolveChallenge,
  })
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
    const run = queries.mapPublic(state)
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
      return queries.mapPublic(state)
    })
  }

  function pause(runId: string) {
    return withLock(runId, () =>
      apply(runId, { t: "pause", now: now() }).then(queries.mapPublic)
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
          if (existing) return queries.mapPublic(current)
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
      return queries.mapPublic(state)
    })
  }

  function stop(runId: string) {
    return withLock(runId, () =>
      apply(runId, { t: "stop", now: now() }).then(queries.mapPublic)
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
        if (existing) return queries.mapPublic(current)
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
      return queries.mapPublic(state)
    })
  }

  function requestFinish(runId: string, summary: string) {
    return withLock(runId, () =>
      apply(runId, { t: "request_finish", summary }).then(queries.mapPublic)
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
      }).then(queries.mapPublic)
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
    return queries.get(runId)
  }

  function agents(runId: string) {
    const state = store.loadAggregate(runId)
    if (!state) throw new RunActionError("not_found", "Run not found")
    return queries.agents(runId)
  }

  function usage(runId: string) {
    const state = store.loadAggregate(runId)
    if (!state) throw new RunActionError("not_found", "Run not found")
    return queries.usage(runId)
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
    return queries.mapPublic(state)
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
    getAggregate: queries.getAggregate,
    getAgent: queries.getAgent,
    agents,
    inspector: queries.inspector,
    usage,
    agentUsage: queries.agentUsage,
    listForEvent: queries.listForEvent,
    listForChallenge: queries.listForChallenge,
    workspacePath: queries.workspacePath,
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
