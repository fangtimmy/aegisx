import { mkdirSync } from "node:fs"
import { join, relative } from "node:path"
import type {
  FlatSettings,
  OrchestratorConfigInput,
  OrchestratorDetail,
  OrchestratorStatus,
  SwitchModelInput,
} from "@aegisx/shared"
import { get } from "@aegisx/shared"
import type { ProviderConnection } from "@aegisx/shared/provider"
import type { ThinkingLevel } from "@aegisx/shared/thinking"
import type { Api, Model } from "@earendil-works/pi-ai"
import type {
  ModelRuntime,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent"
import { desc, eq } from "drizzle-orm"
import type { HostAgentSession } from "../agents/host-session"
import { chainLock, createSessionLifecycle } from "../agents/lifecycle"
import { createLiveBus, type LiveBus } from "../agents/live"
import { resolveSwitchTarget, type SwitchTarget } from "../agents/model-switch"
import type { createDatabase } from "../db"
import {
  challengeRemote,
  challenges,
  events,
  orchestrators,
  runs,
} from "../db/schema"
import type { ConfigStore } from "../infrastructure/config-store"
import { isTargetCapable } from "../platforms/challenge-state"
import { getProviderConnections } from "../providers/public"
import { createBashTool } from "../run/bash-tool"
import type { ContainerManager } from "../run/container/container-manager"
import { createToolboxContainer } from "../run/container/container-manager"
import { createRunModelRuntime, resolveRunModel } from "../run/model-runtime"
import type { RunService } from "../run/service"
import { createDockerExecBackend } from "../run/workspace/backend"
import { createWorkspaceTools } from "../run/workspace/tools"
import { canLaunchRun, countRunningRuns, countTargetRuns } from "./guard"
import { createOrchestratorQueries, type OrchestratorQueries } from "./queries"
import {
  createOrchestratorSession,
  ORCHESTRATOR_AGENT_ID,
  type OrchestratorAgentSettings,
} from "./session"
import {
  type ChallengeDigest,
  createOrchestratorTools,
  flattenEntryText,
  type OrchestratorToolContext,
  type ReadRunResult,
  type RunDigest,
} from "./tools"

type Database = ReturnType<typeof createDatabase>["db"]

const ORCH_SUBDIR = "orchestrators"

/** Orchestrator action error (mirrors RunActionError semantics). */
export class OrchestratorActionError extends Error {
  constructor(
    readonly code: "not_found" | "invalid_state" | "launch_failed",
    message: string
  ) {
    super(message)
    this.name = "OrchestratorActionError"
  }
}

export type OrchestratorServiceOptions = {
  db: Database
  dataDir: string
  containerManager: ContainerManager
  runService: RunService
  getSettings(): FlatSettings
  configStore: ConfigStore
  /** Test seam: override the host-session creation (default =
   * createOrchestratorSession). Tests inject a stub to avoid building a real
   * pi AgentSession + hitting a model. */
  createSession?: typeof createOrchestratorSession
}

export type OrchestratorService = ReturnType<typeof createOrchestratorService>

/**
 * Per-event orchestrator lifecycle: a host-side pi SDK session (own container
 * + workspace) armed with management tools (list/start/stop/read/status) and
 * the file tools. Woken on solver events (idle/finish/flag/timeout) via
 * `notify()`. Mirrors runService's shape (create/stop/close/sendMessage/
 * listMessages/recoverOnBoot) so the frontend can reuse ConversationStore.
 */
/** Dependencies for {@link buildOrchestratorToolContext}. Extracted from the
 * service factory so the tool-context wiring is unit-testable in isolation
 * (the closures only need these deps, not the whole service). */
export type BuildToolContextDeps = {
  db: Database
  eventId: string
  /** Current orchestrator config row (max concurrent targets / model / level). */
  getRow: () => typeof orchestrators.$inferSelect
  getSettings(): FlatSettings
  runService: RunService
  resolveModelSelection(modelId?: string | null): {
    provider: ProviderConnection
    model: { id: string; enabled: boolean }
  }
  containerConfig(): {
    image: string
    cpus: number
    memoryMb: number
    pidsLimit: number
    tmpfsSize: string
    workspace: string
  }
}

/** Build the orchestrator's management-tool context: the closures the
 * list_challenges / start_run / stop_run / read_run / get_status tools call.
 * Pure DB + delegation logic — no model, no async side effects beyond
 * runService calls. */
export function buildOrchestratorToolContext(
  deps: BuildToolContextDeps
): OrchestratorToolContext {
  const {
    db,
    eventId,
    getRow,
    getSettings,
    runService,
    resolveModelSelection,
    containerConfig,
  } = deps

  const ctx: OrchestratorToolContext = {
    eventId,

    listChallenges(): ChallengeDigest[] {
      const list = db
        .select({ challenge: challenges, remote: challengeRemote })
        .from(challenges)
        .leftJoin(
          challengeRemote,
          eq(challenges.id, challengeRemote.challengeId)
        )
        .where(eq(challenges.eventId, eventId))
        .all()
      return list.map(({ challenge: c, remote }) => {
        const chRuns = db
          .select()
          .from(runs)
          .where(eq(runs.challengeId, c.id))
          .all()
          .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        return {
          id: c.id,
          name: c.name,
          category: c.category,
          points: c.points,
          targetCapable: isTargetCapable(remote ?? undefined),
          remoteSolved: remote?.solved ?? false,
          hasRunningRun: chRuns.some((r) => r.status === "running"),
          lastRunStatus: chRuns[0]?.status ?? null,
          attempts: chRuns.length,
        }
      })
    },

    async startRun(input) {
      const r = getRow()
      const verdict = canLaunchRun(db, eventId, input.challengeId, {
        maxConcurrentRuns: get(getSettings(), "scheduler.maxConcurrentRuns"),
        maxConcurrentTargets: r.maxConcurrentTargets,
      })
      if (!verdict.ok)
        return { runId: "", status: "rejected", reason: verdict.reason }
      try {
        const { provider, model } = resolveModelSelection(
          input.modelId ?? r.modelId
        )
        if (!model.enabled || !provider.enabled || !provider.apiKey)
          return {
            runId: "",
            status: "rejected",
            reason: "Model unavailable",
          }
        const cfg = containerConfig()
        const created = await runService.create({
          challengeId: input.challengeId,
          provider,
          modelId: model.id,
          thinkingLevel: r.thinkingLevel as ThinkingLevel,
          container: {
            image: cfg.image,
            cpus: cfg.cpus,
            memoryMb: cfg.memoryMb,
            pidsLimit: cfg.pidsLimit,
            tmpfsSize: cfg.tmpfsSize,
            workspace: cfg.workspace,
          },
          source: "orchestrator",
          ...(input.timeoutMs !== undefined
            ? { timeoutMs: input.timeoutMs }
            : {}),
          ...(input.initialPromptOverride !== undefined
            ? { initialPromptOverride: input.initialPromptOverride }
            : {}),
        })
        return { runId: created.id, status: created.status }
      } catch (error) {
        return {
          runId: "",
          status: "rejected",
          reason: error instanceof Error ? error.message : String(error),
        }
      }
    },

    async stopRun(runId) {
      const target = db.select().from(runs).where(eq(runs.id, runId)).get()
      if (!target) return { status: "rejected", reason: "Run not found" }
      if (target.status !== "running")
        return { status: target.status, reason: "Run is not running" }
      try {
        const updated = await runService.stop(runId)
        return { status: updated.status }
      } catch (error) {
        return {
          status: "rejected",
          reason: error instanceof Error ? error.message : String(error),
        }
      }
    },

    async readRun(runId, opts): Promise<ReadRunResult & { reason?: string }> {
      const target = db.select().from(runs).where(eq(runs.id, runId)).get()
      if (!target)
        return { runId, items: [], nextAfter: 0, reason: "Run not found" }
      const challenge = db
        .select()
        .from(challenges)
        .where(eq(challenges.id, target.challengeId))
        .get()
      if (challenge?.eventId !== eventId)
        return {
          runId,
          items: [],
          nextAfter: 0,
          reason: "Run belongs to another event",
        }
      const list = runService.listMessages(runId, { after: opts?.since })
      // Default to assistant + toolResult so the orchestrator sees a run's
      // reasoning and tool outcomes without the verbosity of raw user
      // prompts. Caller can narrow/expand via opts.roles.
      const roles = opts?.roles ?? ["assistant", "toolResult"]
      const items = list.items
        .map((it) => {
          const msg = it.entry as {
            type: string
            message?: { role: string; content: unknown; toolName?: string }
          }
          if (
            roles &&
            msg.type === "message" &&
            msg.message &&
            !roles.includes(msg.message.role)
          )
            return null
          const flat = flattenEntryText(msg)
          return flat ? { seq: it.seq, role: flat.role, text: flat.text } : null
        })
        .filter(
          (x): x is { seq: number; role: string; text: string } => x !== null
        )
      return { runId, items, nextAfter: list.nextAfter }
    },

    getStatus() {
      const r = getRow()
      const active = db
        .select({ run: runs, challenge: challenges })
        .from(runs)
        .innerJoin(challenges, eq(runs.challengeId, challenges.id))
        .where(eq(challenges.eventId, eventId))
        .orderBy(desc(runs.updatedAt))
        .all()
        .filter(({ run }) => run.status === "running" || run.status === "idle")
      const digest: RunDigest[] = active.map(({ run, challenge }) => ({
        id: run.id,
        challengeId: run.challengeId,
        challengeName: challenge.name,
        status: run.status,
        source: run.source,
        hasFlag: Boolean(run.flag),
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
      }))
      return {
        running: countRunningRuns(db),
        maxConcurrentRuns: get(getSettings(), "scheduler.maxConcurrentRuns"),
        inflightTargets: countTargetRuns(db, eventId),
        maxConcurrentTargets: r.maxConcurrentTargets,
        runs: digest,
      }
    },
  }
  return ctx
}

export function createOrchestratorService(options: OrchestratorServiceOptions) {
  const { db, dataDir, containerManager, runService, configStore } = options
  /** Host-session creation (real impl by default; stubbable for tests). */
  const createSession = options.createSession ?? createOrchestratorSession
  const queries: OrchestratorQueries = createOrchestratorQueries({ db })
  const bus: LiveBus = createLiveBus()
  const locks = new Map<string, Promise<unknown>>()
  let closed = false

  const orchDir = (eventId: string) => join(dataDir, ORCH_SUBDIR, eventId)
  const workspaceAbs = (eventId: string) => join(orchDir(eventId), "workspace")
  const runtimeAbs = (eventId: string) =>
    join(orchDir(eventId), "agent-runtime")
  const containerName = (eventId: string) => `aegisx-orchestrator-${eventId}`

  function withLock<T>(eventId: string, op: () => T | Promise<T>): Promise<T> {
    if (closed)
      return Promise.reject(
        new OrchestratorActionError(
          "invalid_state",
          "Orchestrator service is closed"
        )
      )
    return chainLock(locks, eventId, op)
  }

  // Shared turn-driving core (generation-guarded, lock-serialized). The
  // orchestrator plugs in only its status transitions; everything else
  // (containers, management tools, triggers) stays orchestrator-specific.
  const lifecycle = createSessionLifecycle({
    kind: "orchestrator",
    withLock,
    onTurnStart: (eventId) => queries.update(eventId, { status: "running" }),
    onTurnSettled: (eventId) => queries.update(eventId, { status: "idle" }),
  })

  function providers(): ProviderConnection[] {
    return getProviderConnections(configStore)
  }

  function agentSettings(): OrchestratorAgentSettings {
    const s = options.getSettings()
    return {
      compaction: { enabled: get(s, "agent.compactionEnabled") },
      retry: {
        enabled: get(s, "agent.retryEnabled"),
        maxRetries: get(s, "agent.retryMaxRetries"),
      },
    }
  }

  function containerConfig() {
    const s = options.getSettings()
    return {
      image: get(s, "container.image"),
      cpus: get(s, "container.cpus"),
      memoryMb: get(s, "container.memoryMb"),
      pidsLimit: get(s, "container.pidsLimit"),
      tmpfsSize: get(s, "container.tmpfsSize"),
      workspace: get(s, "container.workspace"),
    }
  }

  /** Find the provider + ProviderModel for a model id (or the global default). */
  function resolveModelSelection(modelId?: string | null): {
    provider: ProviderConnection
    model: { id: string; enabled: boolean }
  } {
    const selectedModelId =
      modelId ?? get(options.getSettings(), "agent.defaultModelId") ?? undefined
    if (!selectedModelId)
      throw new OrchestratorActionError(
        "invalid_state",
        "No model selected (set a default model or the orchestrator model)"
      )
    for (const provider of providers()) {
      const model = provider.models.find((m) => m.id === selectedModelId)
      if (model) return { provider, model }
    }
    throw new OrchestratorActionError("invalid_state", "Model not found")
  }

  /** Resolve the SDK model + a per-orchestrator ModelRuntime. */
  async function resolveOrchestratorModel(
    eventId: string,
    modelId?: string | null
  ): Promise<{ modelRuntime: ModelRuntime; sdkModel: Model<Api> }> {
    const { provider, model } = resolveModelSelection(modelId)
    if (!model.enabled || !provider.enabled)
      throw new OrchestratorActionError("invalid_state", "Model is unavailable")
    if (!provider.apiKey)
      throw new OrchestratorActionError(
        "invalid_state",
        "Provider API key is required"
      )
    const modelRuntime = await createRunModelRuntime({
      runtimeDir: runtimeAbs(eventId),
      providers: providers(),
    })
    const sdkModel = resolveRunModel(modelRuntime, provider, model.id)
    if (!sdkModel)
      throw new OrchestratorActionError(
        "launch_failed",
        "Could not resolve model"
      )
    return { modelRuntime, sdkModel }
  }

  /** Build the tool context the orchestrator's management tools delegate to. */
  function buildToolContext(eventId: string): OrchestratorToolContext {
    return buildOrchestratorToolContext({
      db,
      eventId,
      getRow: () => queries.ensureRow(eventId),
      getSettings: options.getSettings,
      runService,
      resolveModelSelection,
      containerConfig,
    })
  }

  function statusSnapshot(eventId: string): OrchestratorStatus {
    const r = queries.ensureRow(eventId)
    return {
      running: countRunningRuns(db),
      maxConcurrentRuns: get(
        options.getSettings(),
        "scheduler.maxConcurrentRuns"
      ),
      inflightTargets: countTargetRuns(db, eventId),
      maxConcurrentTargets: r.maxConcurrentTargets,
    }
  }

  function getDetail(eventId: string): OrchestratorDetail | undefined {
    const ev = db.select().from(events).where(eq(events.id, eventId)).get()
    if (!ev) return undefined
    queries.ensureRow(eventId)
    const orchestrator = queries.get(eventId)
    if (!orchestrator)
      throw new Error(`orchestrator row missing for ${eventId} after ensureRow`)
    return {
      orchestrator,
      status: statusSnapshot(eventId),
      usage: queries.usageTotals(eventId),
    }
  }

  function patchConfig(
    eventId: string,
    input: OrchestratorConfigInput
  ): OrchestratorDetail | undefined {
    if (!db.select().from(events).where(eq(events.id, eventId)).get())
      return undefined
    const patch: Partial<typeof orchestrators.$inferInsert> = {}
    if (input.enabled !== undefined) patch.enabled = input.enabled
    if (input.modelId !== undefined) patch.modelId = input.modelId
    if (input.thinkingLevel !== undefined)
      patch.thinkingLevel = input.thinkingLevel
    if (input.instruction !== undefined) patch.instruction = input.instruction
    if (input.maxConcurrentTargets !== undefined)
      patch.maxConcurrentTargets = input.maxConcurrentTargets
    queries.update(eventId, patch)
    return getDetail(eventId)
  }

  /** Render the orchestrator system prompt (role + instruction + tool guide). */
  function buildSystemPrompt(instruction: string): string {
    return [
      "You are the AegisX orchestrator — the scheduling brain for a CTF event. You do not solve challenges yourself; you manage solver runs.",
      "",
      "Your job: decide which challenges to work on, when to start/stop/restart runs, and how long each run gets. Review solver progress and adapt.",
      "",
      "The user's instruction (your strategic direction):",
      '"""',
      instruction.trim() ||
        "(none — proceed by your best judgment, or ask the user)",
      '"""',
      "",
      "Tools:",
      "- list_challenges / start_run / stop_run / read_run / get_status (see each tool's description).",
      "- File tools (read/bash/edit/write/grep/find/ls): keep strategy and state notes in your workspace (e.g. STRATEGY.md, STATE.md, DECISIONS.md).",
      "",
      "Hard guardrails (server-enforced, you cannot violate): global run concurrency, per-event target slots, no duplicate run on a challenge. Everything else — priority, retry, whether to redo solved challenges — is your judgment, guided by the instruction.",
      "",
      "You are woken on events: a run went idle (finished a turn), a flag was accepted, or a run hit its halfway / time limit. Act on each wake-up: read_run to assess, then start/stop/restart as needed. Be decisive and concise. Do not poll repeatedly — wait for events.",
    ].join("\n")
  }

  function buildInitialPrompt(eventId: string): string {
    const ev = db.select().from(events).where(eq(events.id, eventId)).get()
    const list = buildToolContext(eventId).listChallenges()
    const solved = list.filter((c) => c.remoteSolved).length
    const s = statusSnapshot(eventId)
    const row = queries.getRow(eventId)
    return [
      `Orchestrator started for event "${ev?.name ?? eventId}".`,
      "",
      "Current state:",
      `- ${list.length} challenges (${solved} solved remotely)`,
      `- ${s.running}/${s.maxConcurrentRuns} runs active, ${s.inflightTargets}/${s.maxConcurrentTargets} target slots in use`,
      "",
      "Instruction:",
      row?.instruction?.trim() || "(none)",
      "",
      "Assess the situation (list_challenges, get_status) and begin scheduling.",
    ].join("\n")
  }

  /** Trigger entry: inject a lifecycle message (run idle/finish/flag/
   * timeout). Routes through the shared lifecycle so it serializes against
   * sends/starts and is generation-guarded — previously this bypassed the lock
   * and could double-drive one session when several runs settled at once.
   * No-op if no live session. Streaming → steer; idle → fresh turn. */
  function notify(eventId: string, message: string): void {
    if (!lifecycle.has(eventId)) return
    void lifecycle.send(eventId, message).catch(() => undefined)
  }

  async function start(eventId: string): Promise<OrchestratorDetail> {
    return withLock(eventId, async () => {
      const ev = db.select().from(events).where(eq(events.id, eventId)).get()
      if (!ev) throw new OrchestratorActionError("not_found", "Event not found")
      const row = queries.ensureRow(eventId)
      if (lifecycle.has(eventId))
        return getDetail(eventId) as OrchestratorDetail
      // `enabled` is the arm/disarm switch (docs §八/§九): start requires it
      // so a toggled-off orchestrator can't be launched, even via the API.
      if (!row.enabled)
        throw new OrchestratorActionError(
          "invalid_state",
          "Orchestrator is disabled; enable it before starting"
        )

      const { modelRuntime, sdkModel } = await resolveOrchestratorModel(
        eventId,
        row.modelId
      )
      const cfg = containerConfig()
      const name = containerName(eventId)
      const wsAbs = workspaceAbs(eventId)
      mkdirSync(wsAbs, { recursive: true })
      mkdirSync(runtimeAbs(eventId), { recursive: true })

      await createToolboxContainer(containerManager, {
        name,
        image: cfg.image,
        workspace: cfg.workspace,
        hostWorkspace: wsAbs,
        cpus: cfg.cpus,
        memoryMb: cfg.memoryMb,
        pidsLimit: cfg.pidsLimit,
        tmpfsSize: cfg.tmpfsSize,
      })

      const toolCtx = buildToolContext(eventId)
      const bashDef = createBashTool(cfg.workspace, name, containerManager)
      const workspaceTools = createWorkspaceTools(
        createDockerExecBackend(name, containerManager, cfg.workspace)
      )
      const mgmt = createOrchestratorTools(toolCtx)
      const customTools = [
        bashDef,
        ...workspaceTools,
        ...mgmt,
      ] as ToolDefinition[]
      const toolNames = [
        "read",
        "bash",
        "edit",
        "write",
        "grep",
        "find",
        "ls",
        ...mgmt.map((t) => t.name),
      ]

      let orchSession: HostAgentSession
      try {
        orchSession = await createSession({
          eventId,
          workspaceHostPath: wsAbs,
          containerWorkspace: cfg.workspace,
          modelRuntime,
          model: sdkModel,
          thinkingLevel: row.thinkingLevel as ThinkingLevel,
          agentSettings: agentSettings(),
          systemPrompt: buildSystemPrompt(row.instruction),
          customTools,
          toolNames,
          db,
          bus,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await containerManager.remove(name).catch(() => undefined)
        throw new OrchestratorActionError("launch_failed", message)
      }

      lifecycle.set(eventId, orchSession)
      queries.update(eventId, {
        status: "running",
        containerName: name,
        image: cfg.image,
        cpus: Math.round(cfg.cpus),
        memoryMb: cfg.memoryMb,
        pidsLimit: cfg.pidsLimit,
        workspacePath: relative(dataDir, wsAbs),
        sessionDir: relative(dataDir, orchDir(eventId)),
      })
      const detail = getDetail(eventId) as OrchestratorDetail
      lifecycle.drive(eventId, buildInitialPrompt(eventId))
      return detail
    })
  }

  async function stop(eventId: string): Promise<OrchestratorDetail> {
    if (!lifecycle.has(eventId))
      throw new OrchestratorActionError(
        "invalid_state",
        "Orchestrator is not running"
      )
    await lifecycle.abort(eventId)
    return getDetail(eventId) as OrchestratorDetail
  }

  /** Switch the live orchestrator session's model (and optionally thinking
   * level). Takes effect on the next turn (matches the run switch + pi-tui).
   * Requires a running session. Persists the new model + clamped thinking level
   * on the orchestrator row; the SDK persists the change entries. */
  async function switchModel(
    eventId: string,
    input: SwitchModelInput
  ): Promise<OrchestratorDetail> {
    return withLock(eventId, async () => {
      const orch = lifecycle.get(eventId)
      if (!orch)
        throw new OrchestratorActionError(
          "invalid_state",
          "Orchestrator is not running"
        )
      let target: SwitchTarget
      try {
        target = resolveSwitchTarget(
          orch.session.modelRuntime,
          providers(),
          input.modelId
        )
      } catch (error) {
        throw new OrchestratorActionError(
          "invalid_state",
          error instanceof Error ? error.message : String(error)
        )
      }
      // Skip setModel when unchanged (thinking-only switch) to avoid a spurious
      // model_change marker; setThinkingLevel short-circuits on no-change.
      const row = queries.getRow(eventId)
      const modelUnchanged = row?.modelId === target.model.id
      try {
        if (!modelUnchanged) await orch.session.setModel(target.sdkModel)
        if (input.thinkingLevel)
          orch.session.setThinkingLevel(input.thinkingLevel)
      } catch (error) {
        throw new OrchestratorActionError(
          "invalid_state",
          error instanceof Error ? error.message : String(error)
        )
      }
      queries.update(eventId, {
        modelId: target.model.id,
        thinkingLevel: orch.session.thinkingLevel as ThinkingLevel,
      })
      return getDetail(eventId) as OrchestratorDetail
    })
  }

  async function closeOrchestrator(
    eventId: string
  ): Promise<OrchestratorDetail> {
    return withLock(eventId, async () => {
      if (!getDetail(eventId))
        throw new OrchestratorActionError("not_found", "Event not found")
      const orch = lifecycle.get(eventId)
      if (orch?.session.isStreaming) {
        await orch.session.abort().catch(() => undefined)
      }
      if (orch) {
        await orch.dispose()
        lifecycle.delete(eventId)
      }
      const row = queries.getRow(eventId)
      if (row?.containerName)
        await containerManager.remove(row.containerName).catch(() => undefined)
      queries.update(eventId, { status: "closed" })
      return getDetail(eventId) as OrchestratorDetail
    })
  }

  async function sendMessage(
    eventId: string,
    input: { text: string; deliverAs?: "steer" | "followUp" }
  ): Promise<OrchestratorDetail> {
    if (!lifecycle.has(eventId))
      throw new OrchestratorActionError(
        "invalid_state",
        "Orchestrator is not running"
      )
    await lifecycle.send(eventId, input.text, input.deliverAs)
    return getDetail(eventId) as OrchestratorDetail
  }

  function listMessages(eventId: string, opts: { after?: number }) {
    return queries.listMessages(eventId, opts)
  }

  async function recoverOnBoot() {
    const rows = db.select().from(orchestrators).all()
    for (const row of rows) {
      if (row.status === "closed") continue
      await containerManager.remove(row.containerName).catch(() => undefined)
      queries.update(row.eventId, { status: "closed" })
    }
  }

  async function close() {
    closed = true
    await Promise.allSettled([...locks.values()])
    locks.clear()
    await lifecycle.closeAll()
    bus.close()
  }

  return {
    bus,
    agentId: ORCHESTRATOR_AGENT_ID,
    getDetail,
    patchConfig,
    listMessages,
    start,
    stop,
    switchModel,
    closeOrchestrator,
    sendMessage,
    notify,
    recoverOnBoot,
    close,
  }
}
