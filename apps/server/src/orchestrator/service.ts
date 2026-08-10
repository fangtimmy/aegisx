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
import type { ModelRuntime } from "@earendil-works/pi-coding-agent"
import { and, desc, eq } from "drizzle-orm"

import { applyModelSwitch, type SwitchTarget } from "../agents/agent-ops"
import { createAgentHost } from "../agents/host"
import type { HostAgentSession } from "../agents/host-session"
import { chainLock, createSessionLifecycle } from "../agents/lifecycle"
import { createLiveBus, type LiveBus } from "../agents/live"
import type { createDatabase } from "../db"
import {
  attachments,
  challengeFlags,
  challengeRemote,
  challenges,
  events,
  orchestrators,
  runs,
} from "../db/schema"
import type { ConfigStore } from "../infrastructure/config-store"
import {
  isPlatformIntegrated,
  isTargetCapable,
} from "../platforms/challenge-state"
import { getProviderConnections } from "../providers/public"
import type { ContainerManager } from "../run/container/container-manager"
import { createToolboxContainer } from "../run/container/container-manager"
import { createRunModelRuntime, resolveRunModel } from "../run/model-runtime"
import type { RunService } from "../run/service"
import { renderOrchestratorSystemPrompt } from "../settings/prompt-templates"
import { canLaunchRun, countRunningRuns, countTargetChallenges } from "./guard"
import { createOrchestratorQueries, type OrchestratorQueries } from "./queries"
import {
  findExistingOrchestratorSessionId,
  ORCHESTRATOR_AGENT_ID,
  type OrchestratorAgentSettings,
} from "./session"
import {
  type ChallengeDetail,
  type ChallengeDigest,
  createOrchestratorTools,
  flattenEntryText,
  LIST_RUNS_ROW_LIMIT,
  type OrchestratorToolContext,
  type ReadRunResult,
  type RunDigest,
  type RunListItem,
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
  /** Test seam: override the host-session creation (default = createAgentHost).
   * Tests inject a stub to avoid building a real pi AgentSession + hitting a
   * model. */
  createHost?: typeof createAgentHost
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

  /** True iff the run has any accepted flag record (platform- or run-sourced). */
  function runHasAcceptedFlag(runId: string): boolean {
    return Boolean(
      db
        .select({ id: challengeFlags.id })
        .from(challengeFlags)
        .where(
          and(
            eq(challengeFlags.runId, runId),
            eq(challengeFlags.status, "accepted")
          )
        )
        .get()
    )
  }

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

    getChallenge(challengeId): ChallengeDetail | { reason: string } {
      const row = db
        .select({ challenge: challenges, remote: challengeRemote })
        .from(challenges)
        .leftJoin(
          challengeRemote,
          eq(challenges.id, challengeRemote.challengeId)
        )
        .where(eq(challenges.id, challengeId))
        .get()
      if (!row) return { reason: "Challenge not found" }
      if (row.challenge.eventId !== eventId)
        return { reason: "Challenge belongs to another event" }
      const chRuns = db
        .select()
        .from(runs)
        .where(eq(runs.challengeId, challengeId))
        .all()
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      const remote = row.remote
      const targetRows =
        remote && remote.targetInfo ? safeParseTargets(remote.targetInfo) : []
      const files = db
        .select({ name: attachments.originalName, size: attachments.size })
        .from(attachments)
        .where(eq(attachments.challengeId, challengeId))
        .orderBy(attachments.createdAt, attachments.id)
        .all()
      return {
        id: row.challenge.id,
        name: row.challenge.name,
        category: row.challenge.category,
        points: row.challenge.points,
        targetCapable: isTargetCapable(remote ?? undefined),
        remoteSolved: remote?.solved ?? false,
        hasRunningRun: chRuns.some((r) => r.status === "running"),
        lastRunStatus: chRuns[0]?.status ?? null,
        lastRunSummary: chRuns[0]?.summary ?? null,
        attempts: chRuns.length,
        description: row.challenge.description,
        platformIntegrated: isPlatformIntegrated(remote ?? undefined),
        available: remote?.available ?? false,
        attachments: files,
        targets: targetRows,
        runningRuns: chRuns.filter((r) => r.status === "running").length,
        idleRuns: chRuns.filter((r) => r.status === "idle").length,
        closedRuns: chRuns.filter((r) => r.status === "closed").length,
      }
    },

    listRuns(opts): RunListItem[] {
      const rows = db
        .select({ run: runs, challenge: challenges })
        .from(runs)
        .innerJoin(challenges, eq(runs.challengeId, challenges.id))
        .where(eq(challenges.eventId, eventId))
        .orderBy(desc(runs.updatedAt))
        .all()
      const filtered = rows.filter(({ run }) => {
        if (opts?.status && run.status !== opts.status) return false
        if (opts?.challengeId && run.challengeId !== opts.challengeId)
          return false
        return true
      })
      return filtered
        .slice(0, LIST_RUNS_ROW_LIMIT)
        .map(({ run, challenge }) => ({
          id: run.id,
          challengeId: run.challengeId,
          challengeName: challenge.name,
          status: run.status,
          source: run.source,
          hasFlag: runHasAcceptedFlag(run.id),
          summary: run.summary,
          error: run.error,
          createdAt: run.createdAt,
          updatedAt: run.updatedAt,
          completedAt: run.completedAt,
          deadlineAt: run.deadlineAt,
        }))
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

    async messageRun(runId, input) {
      const target = db.select().from(runs).where(eq(runs.id, runId)).get()
      if (!target) return { status: "rejected", reason: "Run not found" }
      const challenge = db
        .select()
        .from(challenges)
        .where(eq(challenges.id, target.challengeId))
        .get()
      if (challenge?.eventId !== eventId)
        return { status: "rejected", reason: "Run belongs to another event" }
      // Restoring a closed run (→ running) consumes a global concurrency
      // slot, so honor the same cap start_run does; idle/running messages
      // reclaim a slot this run already holds and skip the check.
      if (target.status === "closed") {
        const cap = get(getSettings(), "scheduler.maxConcurrentRuns")
        if (countRunningRuns(db) >= cap)
          return {
            status: "rejected",
            reason: `Concurrency full — close or wait for a run first (cap ${cap})`,
          }
      }
      try {
        const updated = await runService.sendMessage(runId, input)
        return { status: updated.status }
      } catch (error) {
        return {
          status: "rejected",
          reason: error instanceof Error ? error.message : String(error),
        }
      }
    },

    async closeRun(runId) {
      const target = db.select().from(runs).where(eq(runs.id, runId)).get()
      if (!target) return { status: "rejected", reason: "Run not found" }
      if (target.status === "closed")
        return { status: "closed", reason: "Run is already closed" }
      try {
        const updated = await runService.closeRun(runId)
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
        hasFlag: runHasAcceptedFlag(run.id),
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        deadlineAt: run.deadlineAt,
      }))
      return {
        running: countRunningRuns(db),
        maxConcurrentRuns: get(getSettings(), "scheduler.maxConcurrentRuns"),
        inflightTargets: countTargetChallenges(db, eventId),
        maxConcurrentTargets: r.maxConcurrentTargets,
        runs: digest,
      }
    },
  }
  return ctx
}

/** Parse challenge_remote.target_info (a JSON array of {name, services}).
 * Defensive: bad shapes yield [] rather than throwing into the tool path. */
function safeParseTargets(raw: string): { name: string; services: string[] }[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((t) => {
      if (!t || typeof t !== "object") return []
      const o = t as { name?: unknown; services?: unknown }
      if (typeof o.name !== "string") return []
      const services = Array.isArray(o.services)
        ? o.services.filter((s): s is string => typeof s === "string")
        : []
      return [{ name: o.name, services }]
    })
  } catch {
    return []
  }
}

export function createOrchestratorService(options: OrchestratorServiceOptions) {
  const { db, dataDir, containerManager, runService, configStore } = options
  /** Host-session creation (real impl by default; stubbable for tests). */
  const createHost = options.createHost ?? createAgentHost
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
      inflightTargets: countTargetChallenges(db, eventId),
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
  /** Render the orchestrator system prompt from the configurable template
   * (settings: prompts.orchestratorSystem), injecting the event + the user's
   * instruction. Mirrors the solver's template path. */
  function buildSystemPrompt(eventId: string, instruction: string): string {
    const ev = db.select().from(events).where(eq(events.id, eventId)).get()
    const template = get(options.getSettings(), "prompts.orchestratorSystem")
    return renderOrchestratorSystemPrompt(template, {
      event: { id: eventId, name: ev?.name ?? eventId },
      instruction: instruction.trim(),
    })
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

  async function start(
    eventId: string,
    opts?: { fresh?: boolean }
  ): Promise<OrchestratorDetail> {
    return withLock(eventId, async () => {
      const ev = db.select().from(events).where(eq(events.id, eventId)).get()
      if (!ev) throw new OrchestratorActionError("not_found", "Event not found")
      const row = queries.ensureRow(eventId)
      if (lifecycle.has(eventId)) {
        if (opts?.fresh) {
          // "New session": discard the live session (its DB row stays as
          // archived history) and fall through to create a brand-new one. The
          // container is recreated below (createToolboxContainer is idempotent)
          // with the same workspace, so strategy/state notes persist.
          const live = lifecycle.get(eventId) as HostAgentSession
          if (live.session.isStreaming)
            await live.session.abort().catch(() => undefined)
          await live.dispose()
          lifecycle.delete(eventId)
        } else {
          return getDetail(eventId) as OrchestratorDetail
        }
      }
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
      const mgmt = createOrchestratorTools(toolCtx)
      // Fresh start (newSession) skips the resume — it creates a brand-new
      // session row. Otherwise cold-restore the active (newest) session.
      const existingSessionId = opts?.fresh
        ? undefined
        : findExistingOrchestratorSessionId(db, eventId)

      let orchSession: HostAgentSession
      try {
        orchSession = await createHost({
          owner: { type: "orchestrator", id: eventId },
          channel: eventId,
          agentId: ORCHESTRATOR_AGENT_ID,
          cwd: cfg.workspace,
          containerName: name,
          containerManager,
          modelRuntime,
          model: sdkModel,
          thinkingLevel: row.thinkingLevel as ThinkingLevel,
          agentSettings: agentSettings(),
          systemPrompt: buildSystemPrompt(eventId, row.instruction),
          extraTools: mgmt,
          extraToolNames: mgmt.map((tool) => tool.name),
          ...(existingSessionId
            ? { resumeFrom: { sessionId: existingSessionId, isJsonl: false } }
            : {}),
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

  /** Discard the current session and start a brand-new one (clean context).
   * The old session's DB rows stay as archived history; the workspace files
   * persist. Delegates to {@link start} with `fresh`. */
  async function newSession(eventId: string): Promise<OrchestratorDetail> {
    return start(eventId, { fresh: true })
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
      let thinkingLevel: ThinkingLevel
      try {
        ;({ target, thinkingLevel } = await applyModelSwitch(
          orch,
          providers(),
          input,
          (t) => queries.getRow(eventId)?.modelId === t.model.id
        ))
      } catch (error) {
        throw new OrchestratorActionError(
          "invalid_state",
          error instanceof Error ? error.message : String(error)
        )
      }
      queries.update(eventId, {
        modelId: target.model.id,
        thinkingLevel,
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
    await Promise.allSettled(locks.values())
    locks.clear()
    await lifecycle.closeAll()
    bus.close()
  }

  /** Absolute path to the orchestrator's data dir (data/orchestrators/<eventId>),
   * the files-browser root — mirrors runService.runDirPath. Deterministic
   * (does not require the dir to exist yet); the files route surfaces an
   * empty directory before first start. */
  function dirPath(eventId: string): string | undefined {
    const ev = db.select().from(events).where(eq(events.id, eventId)).get()
    if (!ev) return undefined
    return orchDir(eventId)
  }

  return {
    bus,
    agentId: ORCHESTRATOR_AGENT_ID,
    getDetail,
    patchConfig,
    listMessages,
    dirPath,
    start,
    newSession,
    stop,
    switchModel,
    closeOrchestrator,
    sendMessage,
    notify,
    recoverOnBoot,
    close,
  }
}
