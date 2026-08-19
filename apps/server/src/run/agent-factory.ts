import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

import type { FlatSettings, ModelRef } from "@aegisx/shared"
import { get, isActiveAgentStatus } from "@aegisx/shared"
import type { ProviderConnection } from "@aegisx/shared/domain"
import type { Api, Model } from "@earendil-works/pi-ai"
import { and, eq, inArray, ne } from "drizzle-orm"

import { createAgentHost } from "../agents/host"
import type {
  AgentLoopSettings,
  HostAgentSession,
} from "../agents/host-session"
import type { SessionLifecycle } from "../agents/lifecycle"
import type { LiveBus } from "../agents/live"
import type { Database } from "../db"
import {
  agents,
  challengeFlags,
  challenges,
  events,
  queueState,
  spawnQueue,
} from "../db/schema"
import {
  loadTemplateMap,
  renderTemplate,
} from "../orchestration/prompt-templates"
import { type Capabilities, deriveCapabilities } from "../orchestration/types"
import { getChallengeRemote } from "../platforms/challenge-state"
import type { createPlatformService } from "../platforms/service"
import { generateModelsJson } from "../providers/models-json"
import type { AgentStatus } from "./agent-status"
import type { ChannelService } from "./channels"
import type { ContainerLifecycle } from "./container-lifecycle"
import type { ContainerManager } from "./container/container-manager"
import { createToolboxContainer } from "./container/container-manager"
import type { AgentDeadlines } from "./deadlines"
import { RunActionError, RunStartError } from "./errors"
import { checkSpawnFence } from "./fence"
import type { ModelResolver } from "./model-resolver"
import type { SlotModel } from "./model-resolver"
import {
  createRunModelRuntime,
  type RunModelRuntime,
  resolveRunModel,
} from "./model-runtime"
import {
  buildSchedulerPromptContext,
  buildSolverPromptContext,
  copyAttachments,
} from "./prompt"
import type { AgentQueries } from "./queries"
import type { QueueService } from "./queue"
import { createMainTools, type AgentToolContext } from "./tools"
import {
  agentContainerDir,
  challengeContainerName,
  challengeRoot,
  orchestratorContainerName,
  orchestratorKey,
  orchestratorRoot,
  runtimeDir,
  sessionsDir,
  workspaceDir,
} from "./workspace-resolver"

type PlatformService = ReturnType<typeof createPlatformService>

/** Host path to the Python SDK package (mount source). Overridable via
 * AEGISX_SDK_PATH; default = repo apps/sdk/python relative to this file.
 * Absent when the path does not exist (the mount is then skipped). */
function sdkHostPath(): string | undefined {
  const candidate =
    process.env.AEGISX_SDK_PATH ??
    resolve(import.meta.dir, "../../../../apps/sdk/python")
  return existsSync(candidate) ? candidate : undefined
}

/** Scheduler container extras: the read-only SDK mount (→ /opt/aegisx-sdk),
 * the read-only challenge-workspaces mount (→
 * /challenges/<cid>/workspace — the scheduler reads solver WRITEUP.md /
 * solve.sh / shared/ artifacts directly, live progress included), + the env
 * vars (PYTHONPATH / AEGISX_EVENT_ID / AEGISX_API_URL / AEGISX_ROLE). */
function schedulerSdkContainerOpts(
  eventId: string,
  dataDir: string
): { extraBinds: string[]; env: string[] } | undefined {
  const path = sdkHostPath()
  if (!path) {
    console.warn("aegisx SDK not found on host — skipping scheduler SDK mount")
    return undefined
  }
  return {
    extraBinds: [
      `${path}:/opt/aegisx-sdk:ro`,
      `${resolve(dataDir, "events", eventId, "challenges")}:/challenges:ro`,
    ],
    env: [
      `AEGISX_EVENT_ID=${eventId}`,
      `AEGISX_API_URL=${process.env.AEGISX_API_URL ?? "http://host.docker.internal:3000"}`,
      "PYTHONPATH=/opt/aegisx-sdk",
      "AEGISX_ROLE=scheduler",
    ],
  }
}

/** Solver container extras: the SAME read-only SDK mount as the scheduler
 * (solvers post/read/ask via `aegisx.channels`), the same event/API env —
 * but AEGISX_ROLE=solver (the SDK's client-side management gate) and NO
 * /challenges mount (a solver reaches its own challenge workspace at
 * /workspace — other challenges are not its business). Per-agent identity
 * (AEGISX_AGENT_ID) rides the per-exec env of the bash tool: one
 * challenge's N agents share this container. */
function solverSdkContainerOpts(
  eventId: string
): { extraBinds: string[]; env: string[] } | undefined {
  const path = sdkHostPath()
  if (!path) {
    console.warn("aegisx SDK not found on host — skipping solver SDK mount")
    return undefined
  }
  return {
    extraBinds: [`${path}:/opt/aegisx-sdk:ro`],
    env: [
      `AEGISX_EVENT_ID=${eventId}`,
      `AEGISX_API_URL=${process.env.AEGISX_API_URL ?? "http://host.docker.internal:3000"}`,
      "PYTHONPATH=/opt/aegisx-sdk",
      "AEGISX_ROLE=solver",
    ],
  }
}

/** Reusable per-workspace handles shared by every agent on that workspace. */
export type WorkspaceContext = {
  /** challengeId, or `orch:<eventId>` for the scheduler workspace. */
  key: string
  /** Host root of the workspace tree. */
  rootDir: string
  containerName: string
  containerWorkspace: string
  modelRuntime: RunModelRuntime
  /** `configStore.configVersion` at the last ModelRuntime refresh — 0 at
   * build time. prepare/switch compare against the current version to
   * decide whether the cached runtime needs refreshing. */
  lastRefreshVersion: number
}

export type SpawnAgentInput = {
  eventId: string
  /** Null = the event's scheduler agent. */
  challengeId: string | null
  role: "solver" | "orchestrator"
  model?: string
  /** The spawn prompt (strategy input for the first turn). */
  prompt?: string
  /** 'strategy' (default) appends to the initial template; 'override'
   * replaces the first prompt entirely. */
  promptMode?: "strategy" | "override"
  timeoutMs?: number
  source: "manual" | "scheduler"
  /** Back-filled when the queue drainer spawns this agent. */
  queueItemId?: string
}

export type AgentFactoryDeps = {
  db: Database
  dataDir: string
  containerManager: ContainerManager
  containerLifecycle: ContainerLifecycle
  platformService: PlatformService
  providers: () => ProviderConnection[]
  /** Monotonic config-store version (bumped on every providers/settings
   * mutation). Used to detect whether a workspace's cached ModelRuntime
   * is stale before resolving a model. */
  configVersion: () => number
  modelResolver: ModelResolver
  queries: AgentQueries
  bus: LiveBus
  /** Unified message layer core (derived-key channels). */
  channels: ChannelService
  /** finish_run winners: agentId → summary (consumed at turn settle). */
  pendingFinish: Map<string, string>
  /** Agents finish_run already warned about a missing flag (once each). */
  finishFlagWarned: Set<string>
  lifecycle: SessionLifecycle
  withFence: <T>(op: () => T | Promise<T>) => Promise<T>
  getSettings: () => FlatSettings
  now: () => string
  updateAgent: (
    agentId: string,
    patch: Partial<typeof agents.$inferInsert>
  ) => void
  status: AgentStatus
  /** Late-bound deadline timers (settle/timeout wiring). */
  deadlines(): AgentDeadlines
  /** Late-bound queue (boot recovery resets running items). */
  queue: () => QueueService | undefined
  agentSettings: () => AgentLoopSettings
  /** Test seam: override the host-session creation (default = createAgentHost). */
  createHost: typeof createAgentHost
  /** Read the event's scheduler policy (scheduler-admin). */
  getSchedulerConfig(eventId: string): {
    eventId: string
    modelId: string | null
    instruction: string
    maxConcurrentTargets: number
  }
  /** Test seam: timeout grace between deadline-abort and a forced dispose. */
  timeoutGraceMs?: number
}

export type AgentFactory = ReturnType<typeof createAgentFactory>

/**
 * v19 spawn + prepare + reopen orchestration (the execution unit is the
 * agent). One spawn = one agent row + a lazily-managed per-challenge
 * container + the primed first turn. The workspace is a derived path; the
 * model runtime is shared per workspace (single-flighted).
 */
export function createAgentFactory(deps: AgentFactoryDeps) {
  const {
    db,
    dataDir,
    containerManager,
    containerLifecycle,
    platformService,
    providers,
    configVersion,
    modelResolver,
    queries,
    bus,
    channels,
    pendingFinish,
    finishFlagWarned,
    lifecycle,
    withFence,
    getSettings,
    now,
    updateAgent,
    status,
    agentSettings,
    createHost,
  } = deps

  /** The fixed solver tool set (no inter-agent communication tools — solvers
   * coordinate via the workspace + channels). */
  const SOLVER_TOOLS = (targetSupported: boolean): string[] => [
    "submit_flag",
    "finish_run",
    ...(targetSupported
      ? ["get_target", "start_target", "extend_target", "stop_target"]
      : []),
  ]

  /** Scheduler management tools. EMPTY after the SDK convergence: the
   * orchestrator manages via the container-side `aegisx` Python SDK + bash,
   * not native tools. */
  const ORCHESTRATOR_TOOLS: string[] = []

  // --- workspace contexts (per challenge / scheduler, single-flighted) ----

  const contexts = new Map<string, WorkspaceContext>()
  const building = new Map<string, Promise<WorkspaceContext>>()
  /** In-flight ModelRuntime refreshes per workspace (coalesce concurrent
   * callers onto the pending refresh). */
  const runtimeRefreshes = new Map<string, Promise<void>>()

  function workspaceKeyOf(row: {
    eventId: string
    challengeId: string | null
  }): string {
    return row.challengeId ?? orchestratorKey(row.eventId)
  }

  function rootDirOf(row: {
    eventId: string
    challengeId: string | null
  }): string {
    return row.challengeId
      ? challengeRoot(dataDir, row.eventId, row.challengeId)
      : orchestratorRoot(dataDir, row.eventId)
  }

  function buildWorkspaceContext(row: {
    eventId: string
    challengeId: string | null
  }): Promise<WorkspaceContext> {
    return (async () => {
      const key = workspaceKeyOf(row)
      const root = rootDirOf(row)
      const settings = getSettings()
      const containerWorkspace = get(settings, "container.workspace")
      mkdirSync(workspaceDir(root), { recursive: true })
      mkdirSync(sessionsDir(root), { recursive: true })
      mkdirSync(runtimeDir(root), { recursive: true })
      const modelRuntime = await createRunModelRuntime({
        runtimeDir: runtimeDir(root),
        providers: providers(),
      })
      const ctx: WorkspaceContext = {
        key,
        rootDir: root,
        containerName: row.challengeId
          ? challengeContainerName(row.challengeId)
          : orchestratorContainerName(row.eventId),
        containerWorkspace,
        modelRuntime,
        lastRefreshVersion: configVersion(),
      }
      contexts.set(key, ctx)
      return ctx
    })()
  }

  function ensureWorkspaceContext(row: {
    eventId: string
    challengeId: string | null
  }): Promise<WorkspaceContext> {
    const key = workspaceKeyOf(row)
    const existing = contexts.get(key)
    if (existing) return Promise.resolve(existing)
    const pending = building.get(key)
    if (pending) return pending
    const promise = buildWorkspaceContext(row).finally(() => {
      if (building.get(key) === promise) building.delete(key)
    })
    building.set(key, promise)
    return promise
  }

  /** Regenerate models.json from the current providers and hot-reload the
   * workspace's ModelRuntime. Single-flighted per workspace. No-op (after
   * coalescing) when the workspace has no context yet. */
  function refreshWorkspaceRuntime(workspaceKey: string): Promise<void> {
    const existing = runtimeRefreshes.get(workspaceKey)
    if (existing) return existing
    const pending = (async () => {
      const ctx = contexts.get(workspaceKey)
      if (!ctx) return
      const runtimeDir = join(ctx.rootDir, "runtime")
      mkdirSync(runtimeDir, { recursive: true })
      writeFileSync(
        join(runtimeDir, "models.json"),
        `${JSON.stringify(generateModelsJson(providers()), null, 2)}\n`
      )
      await ctx.modelRuntime.refresh({ allowNetwork: false })
      ctx.lastRefreshVersion = configVersion()
    })().finally(() => {
      runtimeRefreshes.delete(workspaceKey)
    })
    runtimeRefreshes.set(workspaceKey, pending)
    return pending
  }

  /** Refresh the workspace's ModelRuntime only when the config-store version
   * advanced since its last refresh. Called at prepare/switch boundaries so a
   * cached runtime picks up provider/apiKey/metadata edits without a server
   * restart. */
  function ensureWorkspaceRuntimeFresh(workspaceKey: string): Promise<void> {
    const ctx = contexts.get(workspaceKey)
    if (ctx && ctx.lastRefreshVersion >= configVersion()) {
      return Promise.resolve()
    }
    return refreshWorkspaceRuntime(workspaceKey)
  }

  /** Get-or-create the workspace's container (registry + isRunning check
   * inside; slow I/O runs outside every lock). */
  async function ensureContainerFor(
    row: { eventId: string; challengeId: string | null },
    ctx: WorkspaceContext
  ): Promise<void> {
    const settings = getSettings()
    await containerLifecycle.ensureContainer(
      {
        key: ctx.key,
        containerName: ctx.containerName,
        sweepable: row.challengeId !== null,
      },
      async () => {
        await createToolboxContainer(containerManager, {
          name: ctx.containerName,
          image: get(settings, "container.image"),
          workspace: ctx.containerWorkspace,
          hostWorkspace: workspaceDir(ctx.rootDir),
          cpus: get(settings, "container.cpus"),
          memoryMb: get(settings, "container.memoryMb"),
          pidsLimit: get(settings, "container.pidsLimit"),
          tmpfsSize: get(settings, "container.tmpfsSize"),
          networkMode: get(settings, "container.networkMode"),
          ...(row.challengeId
            ? solverSdkContainerOpts(row.eventId)
            : schedulerSdkContainerOpts(row.eventId, dataDir)),
        })
      }
    )
  }

  // --- native tool context --------------------------------------------------

  function buildAgentToolContext(row: {
    id: string
    challengeId: string | null
  }): AgentToolContext {
    return {
      agentId: row.id,
      challengeId: row.challengeId,
      submitFlag: (flag, verifyRemote = true) =>
        platformService
          .submitFlag(row.challengeId!, row.id, flag, verifyRemote)
          .then((r) => r ?? null),
      targetAction: (action) =>
        platformService.targetAction(row.challengeId!, action),
      /** No atomic run flag in v19: the agent self-terminates at its turn
       * settle (completed + summary). */
      requestFinish: (summary) => {
        pendingFinish.set(row.id, summary)
      },
      /** Challenge-level: any accepted flag on the agent's challenge. */
      hasAcceptedFlag: () =>
        Boolean(
          db
            .select({ id: challengeFlags.id })
            .from(challengeFlags)
            .where(
              and(
                eq(challengeFlags.challengeId, row.challengeId!),
                eq(challengeFlags.status, "accepted")
              )
            )
            .get()
        ),
      /** finish_run's stop-target guard: true when no other running/idle
       * agent shares this challenge — the shared target is then this
       * agent's to stop; otherwise teammates keep it. */
      isLastLiveAgent: () => {
        if (!row.challengeId) return true
        const siblings = db
          .select({ status: agents.status })
          .from(agents)
          .where(
            and(eq(agents.challengeId, row.challengeId), ne(agents.id, row.id))
          )
          .all()
        return !siblings.some((sibling) => isActiveAgentStatus(sibling.status))
      },
      finishFlagWarned: () => finishFlagWarned.has(row.id),
      markFinishFlagWarned: () => {
        finishFlagWarned.add(row.id)
      },
    }
  }

  // --- spawn --------------------------------------------------------------

  /** Render the solver's first-turn prompt. `override` mode returns the raw
   * prompt verbatim; otherwise the `initial` template renders with the
   * spawn prompt as the Strategy section. `capabilities` are the same
   * tool-list-derived values the system prompt rendered with. */
  function solverInitialPrompt(
    templateMap: Map<string, string>,
    promptContext: ReturnType<typeof buildSolverPromptContext>,
    capabilities: Capabilities,
    spawnPrompt: string | undefined,
    promptMode: "strategy" | "override" | undefined
  ): string {
    if (promptMode === "override" && spawnPrompt) return spawnPrompt
    return renderTemplate(templateMap, "initial", {
      ...promptContext,
      capabilities,
      ...(spawnPrompt ? { strategy: spawnPrompt } : {}),
    })
  }

  /**
   * Spawn one agent: fence check (solver), model resolution, prompt
   * rendering, agent row insert (snapshot), lazy container, workspace
   * preparation, session prepare, and the primed first turn.
   */
  async function spawnAgent(input: SpawnAgentInput): Promise<string> {
    const settings = getSettings()
    const templateMap = loadTemplateMap(db)

    let challenge: typeof challenges.$inferSelect | undefined
    if (input.role === "solver") {
      if (!input.challengeId) {
        throw new RunActionError("invalid", "Solver agents need a challenge")
      }
      challenge = db
        .select()
        .from(challenges)
        .where(eq(challenges.id, input.challengeId))
        .get()
      if (!challenge)
        throw new RunActionError("not_found", "Challenge not found")
      if (challenge.eventId !== input.eventId) {
        throw new RunActionError(
          "invalid",
          "Challenge does not belong to this event"
        )
      }
    } else {
      const event = db
        .select()
        .from(events)
        .where(eq(events.id, input.eventId))
        .get()
      if (!event) throw new RunActionError("not_found", "Event not found")
      const existing = db
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(
            eq(agents.eventId, input.eventId),
            eq(agents.role, "orchestrator")
          )
        )
        .get()
      if (existing) {
        throw new RunActionError(
          "invalid_state",
          "A scheduler agent already exists for this event"
        )
      }
    }

    // Model resolution: solver → input.model → global default; scheduler →
    // scheduler_config.modelId → global default. Unresolvable refs fail the
    // launch with the ref in the message.
    const modelRef: ModelRef | null =
      input.role === "solver"
        ? (input.model ?? modelResolver.defaultModelRef())
        : (deps.getSchedulerConfig(input.eventId).modelId ??
          modelResolver.defaultModelRef())
    const slotModel: SlotModel = modelResolver.resolveSlotModelFromRef(modelRef)
    const target = modelResolver.resolveModelTarget(slotModel.ref)
    if (!target) {
      throw new RunActionError(
        "invalid_state",
        `Configured model "${slotModel.ref}" is unavailable`
      )
    }
    if (!target.provider.apiKey) {
      throw new RunActionError("invalid_state", "Provider API key is required")
    }

    const agentId = crypto.randomUUID()
    const isSolver = input.role === "solver"
    const name = isSolver ? `agent-${agentId.slice(0, 8)}` : "Scheduler"

    // Workspace context (dirs + model runtime) — needed before prompt
    // rendering (attachments copy + workspace block).
    const probe = {
      eventId: input.eventId,
      challengeId: input.challengeId,
    }
    const wsCtx = await ensureWorkspaceContext(probe)

    // Prompt context + snapshots.
    const env = {
      type: "container" as const,
      image: get(settings, "container.image"),
      cpus: get(settings, "container.cpus"),
      memoryMb: get(settings, "container.memoryMb"),
      pidsLimit: get(settings, "container.pidsLimit"),
    }
    const modelConfig = {
      provider: target.provider.label,
      modelId: target.model.modelId,
      modelLabel: target.model.label,
      thinkingLevel: target.thinkingLevel,
    }
    let systemPrompt: string
    let initialPrompt: string
    let tools: string[]
    if (isSolver) {
      const remote = getChallengeRemote(db, challenge!.id)
      const targetSupported = challengeSupported(challenge)
      tools = SOLVER_TOOLS(targetSupported)
      const promptContext = buildSolverPromptContext(
        {
          challenge: challenge!,
          remote,
          challengeAttachments: copyAttachments(
            db,
            dataDir,
            challenge!.id,
            workspaceDir(wsCtx.rootDir)
          ),
          environment: env,
          model: modelConfig,
          agentId,
          containerWorkspace: wsCtx.containerWorkspace,
        },
        db
      )
      const capabilities = deriveCapabilities(tools)
      systemPrompt = renderTemplate(templateMap, "mainSystem", {
        ...promptContext,
        agent: { role: "solver", name },
        capabilities,
        model: {
          provider: slotModel.providerLabel,
          name: slotModel.modelLabel,
          id: slotModel.modelId,
        },
      })
      initialPrompt = solverInitialPrompt(
        templateMap,
        promptContext,
        capabilities,
        input.prompt,
        input.promptMode
      )
    } else {
      tools = ORCHESTRATOR_TOOLS
      const promptContext = buildSchedulerPromptContext(
        {
          eventId: input.eventId,
          instruction: deps.getSchedulerConfig(input.eventId).instruction,
          model: modelConfig,
        },
        db
      )
      const capabilities = deriveCapabilities(ORCHESTRATOR_TOOLS)
      systemPrompt = renderTemplate(templateMap, "orchestratorSystem", {
        ...promptContext,
        agent: { role: "orchestrator", name },
        capabilities,
        model: {
          provider: slotModel.providerLabel,
          name: slotModel.modelLabel,
          id: slotModel.modelId,
        },
      })
      initialPrompt = renderTemplate(
        templateMap,
        "schedulerInitial",
        promptContext
      )
    }

    const timeoutMs =
      input.timeoutMs ?? get(settings, "scheduler.defaultRunTimeoutMs")
    const deadlineAtIso = new Date(Date.now() + timeoutMs).toISOString()
    const ts = now()
    const source = input.source

    // Reserve the concurrency slot + persist the agent row atomically under
    // the global fence (solvers only — the scheduler never counts).
    await withFence(async () => {
      if (isSolver) {
        const decision = checkSpawnFence(db, settings, {
          eventId: input.eventId,
          challengeId: input.challengeId!,
        })
        if (!decision.ok) {
          throw new RunActionError("capacity", decision.message)
        }
      }
      db.insert(agents)
        .values({
          id: agentId,
          eventId: input.eventId,
          challengeId: input.challengeId,
          role: input.role,
          name,
          model: slotModel.ref,
          systemPrompt,
          tools: JSON.stringify(tools),
          status: "idle",
          sessionFile: null,
          prompt: input.prompt ?? null,
          source,
          timeoutMs,
          deadlineAt: deadlineAtIso,
          queueItemId: input.queueItemId ?? null,
          createdAt: ts,
          startedAt: ts,
          updatedAt: ts,
        })
        .run()
    })

    // Build the container outside the fence lock (slow I/O). On failure the
    // row stays as a failed attempt (it never counted live — status idle →
    // hmm, idle counts). Mark failed + rethrow.
    try {
      await ensureContainerFor(probe, wsCtx)
      // The agent's own directory (host side; the container sees it via the
      // workspace bind).
      if (isSolver) {
        mkdirSync(
          join(workspaceDir(wsCtx.rootDir), "agents", agentId.slice(0, 8)),
          {
            recursive: true,
          }
        )
      }
      await prepareAgent(agentId)
      await lifecycle.send(agentId, initialPrompt)
      // Onboarding: a fresh agent's channel cursor is 0 — one deliver sweeps
      // the challenge's whole #team history (prior attempts' findings +
      // announce) into the first turn's tail.
      channels.deliver(agentId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      status.terminalizeAgent(agentId, { status: "failed" })
      updateAgent(agentId, {
        error: `Failed to start agent: ${message}`,
        completedAt: null,
      })
      throw new RunActionError("launch_failed", message)
    }

    deps.deadlines().armAgentTimers(agentId, deadlineAtIso)
    status.emitAgent(agentId)
    status.emitAgentEvent(agentId, { type: "agent.started", agentId })
    return agentId
  }

  function challengeSupported(
    challenge: typeof challenges.$inferSelect | undefined
  ): boolean {
    if (!challenge) return false
    const remote = getChallengeRemote(db, challenge.id)
    return Boolean(
      remote?.available && remote.targetSupported && !remote.targetIgnored
    )
  }

  // --- prepare / resume ------------------------------------------------------

  /** Prepare one agent's environment: workspace context + container online +
   * this agent's session online. Unified for fresh spawn (no sessionFile →
   * new session) and reopen (sessionFile → open from snapshot). Idempotent;
   * sends nothing. */
  async function prepareAgent(agentId: string): Promise<void> {
    if (lifecycle.has(agentId)) return
    const row = queries.getAgentRow(agentId)
    if (!row) throw new RunActionError("not_found", "Agent not found")

    const ctx = await ensureWorkspaceContext(row)
    await ensureContainerFor(row, ctx)

    // Pick up provider/apiKey/metadata edits since the runtime was last
    // built/refreshed before resolving the snapshot model (covers reopen +
    // spawn-on-existing-workspace drift).
    await ensureWorkspaceRuntimeFresh(ctx.key)

    // Resolve this agent's model from its own snapshot ref (survives
    // switches). Cold-restore reuses the snapshot verbatim — no re-render.
    const agentTarget = modelResolver.resolveModelTarget(row.model)
    if (!agentTarget) {
      throw new RunStartError("Could not resolve the agent's model for restore")
    }
    const sdkModel: Model<Api> | undefined = resolveRunModel(
      ctx.modelRuntime,
      agentTarget.provider,
      agentTarget.model.id
    )
    if (!sdkModel) {
      throw new RunStartError("Could not resolve the agent's model for restore")
    }

    const snapshotTools = safeParseTools(row.tools)
    const toolCtx = buildAgentToolContext(row)
    const nativeTools = createMainTools(toolCtx, snapshotTools)
    // Solver agents work inside their own directory; the scheduler at the
    // workspace root (bash cwd + host file-tool root).
    const cwd =
      row.challengeId !== null
        ? agentContainerDir(ctx.containerWorkspace, agentId)
        : ctx.containerWorkspace

    let agentSession: HostAgentSession
    try {
      agentSession = await createHost({
        owner: { agentId },
        channel: agentId,
        agentId,
        cwd,
        containerName: ctx.containerName,
        containerManager,
        modelRuntime: ctx.modelRuntime,
        model: sdkModel,
        thinkingLevel: agentTarget.thinkingLevel,
        agentSettings: agentSettings(),
        systemPrompt: row.systemPrompt,
        extraTools: nativeTools,
        extraToolNames: snapshotTools,
        // Per-agent identity for the container-side `aegisx` SDK: one
        // challenge's N agents share a container, so identity cannot be
        // container-wide env — it rides the per-exec env of the bash tool.
        execEnv: [`AEGISX_AGENT_ID=${agentId}`],
        ...(row.sessionFile
          ? {
              resumeFrom: {
                sessionId: row.sessionFile,
                isJsonl: row.sessionFile.endsWith(".jsonl"),
                sessionsDir: sessionsDir(ctx.rootDir),
              },
            }
          : {}),
        onUsageMaybeChanged: () => status.emitAgent(agentId),
        db,
        bus,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new RunActionError("launch_failed", message)
    }

    updateAgent(agentId, {
      sessionFile: agentSession.sessionId ?? null,
      toolDefinitions: snapshotActiveToolDefinitions(agentSession.session),
    })
    lifecycle.set(agentId, agentSession)
  }

  /** Reopen a terminal agent (cold resume): status → idle, container +
   * session rebuilt on demand via prepareAgent, timers re-armed, scheduler
   * notified (`agent.reopened`). Invoked from lifecycle.send → onResume. */
  async function resumeAgent(agentId: string): Promise<void> {
    const row = queries.getAgentRow(agentId)
    if (!row) throw new RunActionError("not_found", "Agent not found")
    if (
      row.status === "completed" ||
      row.status === "aborted" ||
      row.status === "failed"
    ) {
      updateAgent(agentId, { status: "idle", updatedAt: now() })
      status.emitAgent(agentId)
      status.emitAgentEvent(agentId, { type: "agent.reopened", agentId })
    }
    await prepareAgent(agentId)
    deps.deadlines().armAgentTimers(agentId, row.deadlineAt)
  }

  // --- boot recovery ---------------------------------------------------------

  /** Boot recovery: no registry survives a crash (process memory). Live
   * agents flip to idle (files persist; a message reopens on demand and
   * rebuilds the container). Orphan containers under our naming scheme are
   * removed best-effort; running queue items reset to pending; queues with
   * visible items start paused. */
  async function recoverOnBoot(): Promise<void> {
    const rows = db.select().from(agents).all()
    const ts = now()
    const seenWorkspaces = new Set<string>()
    const seenQueueEvents = new Set<string>()
    for (const row of rows) {
      if (row.status !== "running" && row.status !== "idle") continue
      if (row.status === "running") {
        updateAgent(row.id, { status: "idle", updatedAt: ts })
      }
      const key = workspaceKeyOf(row)
      if (seenWorkspaces.has(key)) continue
      seenWorkspaces.add(key)
      const name = row.challengeId
        ? challengeContainerName(row.challengeId)
        : orchestratorContainerName(row.eventId)
      await containerManager.remove(name).catch(() => undefined)
      if (row.queueItemId && !seenQueueEvents.has(row.eventId)) {
        seenQueueEvents.add(row.eventId)
        deps.queue()?.resetRunning(row.eventId, ts)
      }
    }
    // Boot leaves every queue paused: events with visible items (pending /
    // running / failed) get queue_state='paused' and nothing drains until
    // the user resumes. No scheduleDrain here — boot never auto-drains.
    const pausedEvents = db
      .select({ eventId: spawnQueue.eventId })
      .from(spawnQueue)
      .where(inArray(spawnQueue.status, ["pending", "running", "failed"]))
      .groupBy(spawnQueue.eventId)
      .all()
    for (const { eventId } of pausedEvents) {
      db.insert(queueState)
        .values({ eventId, status: "paused", updatedAt: ts })
        .onConflictDoUpdate({
          target: queueState.eventId,
          set: { status: "paused", updatedAt: ts },
        })
        .run()
    }
  }

  return {
    spawnAgent,
    prepareAgent,
    resumeAgent,
    recoverOnBoot,
    buildAgentToolContext,
    contexts,
    ensureWorkspaceContext,
    ensureContainerFor,
    refreshWorkspaceRuntime,
    ensureWorkspaceRuntimeFresh,
    workspaceKeyOf,
    rootDirOf,
  }
}

function safeParseTools(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((t): t is string => typeof t === "string")
      : []
  } catch {
    return []
  }
}

/** Snapshot the active tools' definitions (name/description/JSON-schema) for
 * the timeline 工具定义 panel. Filtering by getActiveToolNames keeps the
 * always-on file tools and drops inactive/override duplicates. TypeBox
 * parameters serialize to JSON Schema (symbol-keyed metadata is dropped by
 * JSON.stringify). Defensive: → "[]". */
function snapshotActiveToolDefinitions(
  session: HostAgentSession["session"]
): string {
  try {
    const active = new Set(session.getActiveToolNames())
    return JSON.stringify(
      session
        .getAllTools()
        .filter((tool) => active.has(tool.name))
        .map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          ...(tool.promptGuidelines
            ? { promptGuidelines: tool.promptGuidelines }
            : {}),
        }))
    )
  } catch {
    return "[]"
  }
}
