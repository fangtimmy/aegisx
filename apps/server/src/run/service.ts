import { mkdirSync, rmSync } from "node:fs"
import { join, relative } from "node:path"
import type { Api, Model } from "@earendil-works/pi-ai"
import { eq } from "drizzle-orm"
import type {
  EnvironmentConfig,
  ModelConfig,
  PromptTemplateContext,
  RunPublic,
  SwitchModelInput,
} from "../../../shared"
import { get } from "../../../shared"
import type { ProviderConnection } from "../../../shared/provider"
import type { ThinkingLevel } from "../../../shared/thinking"
import type {
  AgentLoopSettings,
  HostAgentSession,
} from "../agents/host-session"
import { createSessionLifecycle } from "../agents/lifecycle"
import { createLiveBus, type LiveBus } from "../agents/live"
import { resolveSwitchTarget, type SwitchTarget } from "../agents/model-switch"
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
import { RunActionError, RunStartError } from "./errors"
import {
  createRunModelRuntime,
  type RunModelRuntime,
  resolveRunModel,
} from "./model-runtime"
import { buildPromptContext, copyAttachments } from "./prompt"
import { provisionRunSession } from "./provision"
import { createRunQueries } from "./queries"
import type { RunToolContext, ToolCapabilities } from "./tools"

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

export type RunContext = {
  containerName: string
  workspaceHostPath: string
  containerWorkspace: string
  sessionsDir: string
  modelRuntime: RunModelRuntime
  sdkModel: Model<Api>
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
  /** Who started this run. Defaults to 'manual'. */
  source?: "manual" | "orchestrator"
  /** Per-run hard deadline (ms). Defaults to scheduler.defaultRunTimeoutMs. */
  timeoutMs?: number
  /** Override the rendered initial prompt (orchestrator per-run strategy). */
  initialPromptOverride?: string
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

  const childSessions = new Map<string, HostAgentSession>() // by child agent id
  const contexts = new Map<string, RunContext>() // per-run reusable handles
  const locks = new Map<string, Promise<unknown>>()
  const pending = new Map<string, PendingOutcome>()
  const forceKillTimers = new Map<string, NodeJS.Timeout>()
  /** Per-run halfway/deadline timers (orchestrator scheduling). */
  const timeoutTimers = new Map<
    string,
    { halfway?: NodeJS.Timeout; deadline?: NodeJS.Timeout }
  >()
  /** Notifies the event orchestrator of run lifecycle events. */
  let orchestratorNotifier:
    | ((eventId: string, message: string) => void)
    | undefined
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

  // Shared turn-driving core (generation-guarded, lock-serialized). The run
  // service keeps what's genuinely run-specific — child agents, pending
  // finish/close outcomes, force-kill + halfway/deadline timers, orchestrator
  // notification — and reaches them through the hooks below.
  const lifecycle = createSessionLifecycle({
    kind: "run",
    withLock,
    onTurnStart(runId) {
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
    },
    onTurnSettled(runId, runError) {
      const row = queries.getRow(runId)
      if (row?.status !== "running") return
      const outcome = pending.get(runId)
      pending.delete(runId)
      if (outcome?.mode === "finish") {
        freeRun(runId, { summary: outcome.summary, finished: true })
      } else if (outcome?.mode === "close") {
        freeRun(runId)
      } else {
        idleRun(runId, runError)
      }
    },
    onBeforeNewTurn(runId) {
      pending.delete(runId)
    },
    async onResume(runId) {
      await ensureWarm(runId)
    },
  })

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

  /** Resolve the event id for a run (run → challenge → event). */
  function eventIdOf(runId: string): string | undefined {
    const row = queries.getRow(runId)
    if (!row) return undefined
    const challenge = db
      .select()
      .from(challenges)
      .where(eq(challenges.id, row.challengeId))
      .get()
    return challenge?.eventId
  }

  /** Push a lifecycle message to the owning event's orchestrator (no-op if none). */
  function notifyOrchestratorForRun(runId: string, message: string): void {
    const eventId = eventIdOf(runId)
    if (!eventId) return
    orchestratorNotifier?.(eventId, message)
  }

  /** Compact one-liner identifying the run's challenge + outcome, appended to
   * orchestrator notifications so it can often decide without a read_run
   * round-trip. `flag` override is used by notifyFlagAccepted (the row may not
   * be persisted yet). Returns "" if the run can't be resolved. */
  function runDigest(runId: string, opts: { flag?: boolean } = {}): string {
    const row = queries.getRow(runId)
    if (!row) return ""
    const challenge = db
      .select()
      .from(challenges)
      .where(eq(challenges.id, row.challengeId))
      .get()
    const parts: string[] = []
    if (challenge) {
      parts.push(`challenge "${challenge.name}"`)
      if (challenge.category) parts.push(challenge.category)
      if (challenge.points != null) parts.push(`${challenge.points}pts`)
    }
    const hasFlag = opts.flag ?? Boolean(row.flag)
    parts.push(`flag=${hasFlag ? "yes" : "no"}`)
    parts.push(`src=${row.source}`)
    return parts.join(", ")
  }

  /** Suffix helper: ` — <digest>` or "" when the run can't be described. */
  function appendDigest(runId: string, opts: { flag?: boolean } = {}): string {
    const digest = runDigest(runId, opts)
    return digest ? ` — ${digest}` : ""
  }

  /** Clear a run's halfway/deadline timers. */
  function clearRunTimers(runId: string): void {
    const t = timeoutTimers.get(runId)
    if (t?.halfway) clearTimeout(t.halfway)
    if (t?.deadline) clearTimeout(t.deadline)
    timeoutTimers.delete(runId)
  }

  /** Arm a run's halfway-notify + hard-deadline timers. At the halfway point
   * the orchestrator is nudged; at the deadline the current turn is aborted
   * (→ idle, container kept) and the orchestrator is told. Idempotent. */
  function armRunTimers(
    runId: string,
    timeoutMs: number,
    deadlineAt: string | null,
    halfwayNotified: boolean
  ): void {
    clearRunTimers(runId)
    if (!deadlineAt || timeoutMs <= 0) return
    const deadlineMs = new Date(deadlineAt).getTime()
    const nowMs = Date.now()
    const entry: { halfway?: NodeJS.Timeout; deadline?: NodeJS.Timeout } = {}
    if (!halfwayNotified) {
      const halfwayMs = deadlineMs - timeoutMs / 2
      const delay = halfwayMs - nowMs
      if (delay > 0) {
        entry.halfway = setTimeout(() => {
          updateRun(runId, { halfwayNotifiedAt: new Date().toISOString() })
          notifyOrchestratorForRun(
            runId,
            `Run ${runId} is at the halfway mark of its time limit` +
              appendDigest(runId)
          )
        }, delay)
      }
    }
    const deadlineDelay = Math.max(deadlineMs - nowMs, 0)
    entry.deadline = setTimeout(() => {
      const agentSession = lifecycle.get(runId)
      if (agentSession?.session.isStreaming) {
        void agentSession.session.abort().catch(() => undefined)
      }
      clearRunTimers(runId)
      notifyOrchestratorForRun(
        runId,
        `Run ${runId} reached its time limit and was interrupted` +
          appendDigest(runId)
      )
    }, deadlineDelay)
    timeoutTimers.set(runId, entry)
  }

  /** Grace period between SIGTERM and the forced SIGKILL. */
  const FORCE_KILL_GRACE_MS = 10_000

  /** SIGTERM now; force SIGKILL after a grace period if still alive. */
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
    notifyOrchestratorForRun(
      runId,
      `Run ${runId} went idle${runError ? `: ${runError}` : ""}` +
        appendDigest(runId)
    )
  }

  /**
   * Release a run's live resources (container + in-process session). The DB
   * session + workspace are kept so the run can be cold-restored by messaging it. Run
   * becomes closed. `finished` stamps completedAt (finish_run / force finish).
   */
  function freeRun(
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
    const mainAgent = queries.mainAgent(runId)
    if (mainAgent) updateAgent(mainAgent.id, { status: "idle", updatedAt: ts })
    clearForceKill(runId)
    clearRunTimers(runId)
    terminateContainer(runId, containerName(runId))
    childRuntime.abortAll(runId)
    const agentSession = lifecycle.get(runId)
    if (agentSession) {
      void agentSession.dispose()
      lifecycle.delete(runId)
    }
    contexts.delete(runId)
    pending.delete(runId)
    emitRun(runId)
    emitAgents(runId)
    if (opts.finished) {
      notifyOrchestratorForRun(
        runId,
        `Run ${runId} finished${opts.summary ? `: ${opts.summary}` : ""}` +
          appendDigest(runId)
      )
    }
  }

  function providers(): ProviderConnection[] {
    return getProviderConnections(configStore)
  }

  /** Resolve SDK agent-loop settings (compaction/retry) from AegisX settings. */
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

  /** Capabilities granted to a main agent (children get none). */
  function resolveCaps(promptContext: PromptTemplateContext): ToolCapabilities {
    return {
      canSubmitFlag: promptContext.capabilities.canSubmitFlag,
      canManageTarget: promptContext.capabilities.canManageTarget,
      canSpawnAgent: true,
    }
  }

  /** Wire the per-run callbacks the native tools delegate to. */
  function buildMainToolContext(
    runId: string,
    challengeId: string,
    mainAgentId: string
  ): RunToolContext {
    return {
      runId,
      challengeId,
      agentId: mainAgentId,
      submitFlag: (flag) =>
        platformService
          .submitFlag(runId, challengeId, flag)
          .then((r) => r ?? null),
      targetAction: (action) =>
        platformService.targetAction(challengeId, action),
      requestFinish: (summary) =>
        pending.set(runId, { mode: "finish", summary }),
      spawnChild: (childInput) =>
        childRuntime.spawn(runId, mainAgentId, childInput),
      hasAcceptedFlag: () => Promise.resolve(queries.hasAcceptedFlag(runId)),
      getAgent: (agentId) =>
        queries.listAgents(runId).find((a) => a.id === agentId),
      lastAssistantText: (agentId) => lastAssistantText(runId, agentId),
    }
  }

  /** Hand a finished child's result text to its parent: steer into the current
   * turn if streaming, otherwise drive a fresh turn (steer never starts a loop). */
  const deliverToParent = (runId: string, text: string): void => {
    const mainSession = lifecycle.get(runId)
    if (!mainSession) return // run closed/gone
    if (mainSession.session.isStreaming) {
      void mainSession.session.steer(text).catch(() => undefined)
    } else {
      lifecycle.drive(runId, text)
    }
  }

  /** Deps shared by create/ensureWarm (main-agent provisioning). */
  const provisionDeps = {
    db,
    bus,
    containerManager,
    agentSettings,
    buildMainToolContext,
    onUsageMaybeChanged: emitRun,
  }

  /** Background child-agent orchestration (spawn_agent). */
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
  })

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

      const caps = resolveCaps(promptContext)

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
          networkMode: get(options.getSettings(), "container.networkMode"),
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
          source: runSource,
          timeoutMs: runTimeoutMs,
          deadlineAt: deadlineAtIso,
          createdAt: ts,
          startedAt: ts,
          updatedAt: ts,
        })
        .run()

      const mainAgentId = crypto.randomUUID()

      // The agent row must exist before the session: DbSessionManager writes a
      // `sessions` row (FK → agents) at create time. sessionFile is back-filled
      // once the session exists (same pattern as child agents).
      db.insert(agents)
        .values({
          id: mainAgentId,
          runId,
          role: "main",
          parentAgentId: null,
          status: "running",
          sessionFile: null,
          name: null,
          task: null,
          createdAt: ts,
          startedAt: ts,
          updatedAt: ts,
        })
        .run()

      let agentSession: HostAgentSession
      try {
        agentSession = await provisionRunSession(
          {
            runId,
            agentId: mainAgentId,
            containerWorkspace: input.container.workspace,
            sessionsDir: sessAbs,
            modelRuntime,
            sdkModel,
            thinkingLevel: input.thinkingLevel,
            systemPrompt: mainSystemPrompt,
            containerName: name,
            challengeId: challenge.id,
            promptContext,
            caps,
          },
          provisionDeps
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        updateAgent(mainAgentId, {
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

      updateAgent(mainAgentId, {
        sessionFile: agentSession.sessionId ?? null,
      })

      contexts.set(runId, {
        containerName: name,
        workspaceHostPath: wsAbs,
        containerWorkspace: input.container.workspace,
        sessionsDir: sessAbs,
        modelRuntime,
        sdkModel,
        thinkingLevel: input.thinkingLevel,
        childTemplate: templates.childSystemPromptTemplate,
        promptContext,
        caps,
        challengeId: challenge.id,
      })
      lifecycle.set(runId, agentSession)
      emitRun(runId)
      emitAgents(runId)

      // Fire the bootstrap prompt; the run settles (idle/closed) on resolution.
      armRunTimers(runId, runTimeoutMs, deadlineAtIso, false)
      lifecycle.drive(runId, input.initialPromptOverride ?? initialPrompt)
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
      const agentSession = lifecycle.get(runId)
      if (agentSession)
        await agentSession.session.abort().catch(() => undefined)
      return requireRun(runId)
    })
  }

  /** Switch the live main-agent session's model (and optionally thinking
   * level) mid-run. Takes effect on the next turn — the current turn, if any,
   * finishes on the old model (matches pi-tui). Requires a live session
   * (rejects closed runs). Persists the new model + the possibly-clamped
   * thinking level on the run row so cold-restore stays consistent; the SDK
   * persists model_change / thinking_level_change entries automatically. */
  function switchModel(
    runId: string,
    input: SwitchModelInput
  ): Promise<RunPublic> {
    return withLock(runId, async () => {
      const agentSession = lifecycle.get(runId)
      if (!agentSession)
        throw new RunActionError(
          "invalid_state",
          "Run has no live session; start or reopen it first"
        )
      let target: SwitchTarget
      try {
        target = resolveSwitchTarget(
          agentSession.session.modelRuntime,
          providers(),
          input.modelId
        )
      } catch (error) {
        throw new RunActionError(
          "invalid_state",
          error instanceof Error ? error.message : String(error)
        )
      }
      // Skip setModel when the model is unchanged (thinking-only switch) so we
      // don't persist a spurious model_change marker. setThinkingLevel itself
      // short-circuits when the level doesn't change.
      const row = queries.getRow(runId)
      const modelUnchanged = row?.modelId === target.model.modelId
      try {
        if (!modelUnchanged)
          await agentSession.session.setModel(target.sdkModel)
        if (input.thinkingLevel)
          agentSession.session.setThinkingLevel(input.thinkingLevel)
      } catch (error) {
        throw new RunActionError(
          "invalid_state",
          error instanceof Error ? error.message : String(error)
        )
      }
      updateRun(runId, {
        provider: target.provider.label,
        providerLabel: target.provider.label,
        modelId: target.model.modelId,
        modelLabel: target.model.label,
        thinkingLevel: agentSession.session.thinkingLevel,
        updatedAt: now(),
      })
      emitRun(runId)
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
      const agentSession = lifecycle.get(runId)
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
   * cold-restores a closed run from its DB session (DbSessionManager.open) with a
   * fresh container. Does not drive a turn — the caller prompts afterwards.
   */
  async function ensureWarm(runId: string): Promise<void> {
    if (lifecycle.has(runId)) return
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
        networkMode: get(settings, "container.networkMode"),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new RunActionError("launch_failed", message)
    }

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
    const caps = resolveCaps(promptContext)

    let agentSession: HostAgentSession
    try {
      agentSession = await provisionRunSession(
        {
          runId,
          agentId: mainAgent.id,
          containerWorkspace: settings["container.workspace"],
          sessionsDir: sessAbs,
          sessionFile: mainAgent.sessionFile,
          modelRuntime,
          sdkModel,
          thinkingLevel: row.thinkingLevel as ThinkingLevel,
          systemPrompt: renderSystemPrompt(
            templates.mainSystemPromptTemplate,
            promptContext
          ),
          containerName: row.containerName,
          challengeId: row.challengeId,
          promptContext,
          caps,
        },
        provisionDeps
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      clearForceKill(runId)
      terminateContainer(runId, row.containerName)
      throw new RunActionError("launch_failed", message)
    }

    contexts.set(runId, {
      containerName: row.containerName,
      workspaceHostPath: wsAbs,
      containerWorkspace: settings["container.workspace"],
      sessionsDir: sessAbs,
      modelRuntime,
      sdkModel,
      thinkingLevel: row.thinkingLevel as ThinkingLevel,
      childTemplate: templates.childSystemPromptTemplate,
      promptContext,
      caps,
      challengeId: row.challengeId,
    })
    lifecycle.set(runId, agentSession)
    armRunTimers(
      runId,
      row.timeoutMs ?? 0,
      row.deadlineAt,
      Boolean(row.halfwayNotifiedAt)
    )
  }

  /**
   * Unified message entry, delegated to the shared lifecycle: streaming →
   * steer/followUp (queue into the current turn); idle/closed → a fresh turn
   * (cold-restoring a closed run first via onResume). pending finish/close
   * outcomes are cleared on a new turn (onBeforeNewTurn).
   */
  async function sendMessage(
    runId: string,
    input: SendMessageInput
  ): Promise<RunPublic> {
    await lifecycle.send(runId, input.text, input.deliverAs)
    return requireRun(runId)
  }

  /**
   * Replace the main agent's steer/followUp queue. The SDK only exposes
   * clearQueue() (drains all), so an edit/remove is clear + re-queue the
   * remaining messages. Each steer/followUp re-emits queue_update, which the
   * UI reconciles against. No-op for runs without a live session.
   */
  function setQueue(
    runId: string,
    input: { steering: string[]; followUp: string[] }
  ): Promise<void> {
    return withLock(runId, async () => {
      const agentSession = lifecycle.get(runId)
      if (!agentSession) return
      agentSession.session.clearQueue()
      for (const text of input.steering) {
        const trimmed = text.trim()
        if (trimmed) await agentSession.session.steer(trimmed)
      }
      for (const text of input.followUp) {
        const trimmed = text.trim()
        if (trimmed) await agentSession.session.followUp(trimmed)
      }
    })
  }

  /**
   * Manually release a run's container + session (→ closed). Keeps the DB
   * session so the run can be cold-restored by messaging it. A streaming turn is aborted first
   * and freed when it settles.
   */
  function closeRun(runId: string): Promise<RunPublic> {
    return withLock(runId, async () => {
      const run = requireRun(runId)
      if (run.status === "closed") {
        throw new RunActionError("invalid_state", "Run is already closed")
      }
      const agentSession = lifecycle.get(runId)
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
      const agentSession = lifecycle.get(runId)
      if (agentSession?.session.isStreaming) {
        await agentSession.session.abort().catch(() => undefined)
      }
      clearForceKill(runId)
      clearRunTimers(runId)
      await containerManager.remove(row.containerName).catch(() => undefined)
      childRuntime.abortAll(runId)
      if (agentSession) {
        void agentSession.dispose()
        lifecycle.delete(runId)
      }
      contexts.delete(runId)
      pending.delete(runId)
      rmSync(runDir(runId), { recursive: true, force: true })
      db.delete(runs).where(eq(runs.id, runId)).run()
    })
  }

  function mainSessionFor(runId: string) {
    return lifecycle.get(runId)
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

  async function recoverOnBoot() {
    const rows = db.select().from(runs).all()
    for (const row of rows) {
      if (row.status === "closed") continue
      // running/idle held live resources that are gone after a crash. Reclaim
      // any orphan container; the DB session stays so the run is cold-restorable.
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
    for (const t of timeoutTimers.values()) {
      if (t.halfway) clearTimeout(t.halfway)
      if (t.deadline) clearTimeout(t.deadline)
    }
    timeoutTimers.clear()
    await lifecycle.closeAll()
    for (const childSession of childSessions.values())
      await childSession.dispose()
    childSessions.clear()
    pending.clear()
    bus.close()
  }

  function setOrchestratorNotifier(
    fn: (eventId: string, message: string) => void
  ) {
    orchestratorNotifier = fn
  }

  /** Called when a platform accepts a flag (hook from app.ts) so the
   * orchestrator can react to a solve. */
  function notifyFlagAccepted(runId: string) {
    notifyOrchestratorForRun(
      runId,
      `Flag accepted for run ${runId}${appendDigest(runId, { flag: true })}`
    )
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
    setOrchestratorNotifier,
    notifyFlagAccepted,
    listMessages: queries.listMessages,
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
