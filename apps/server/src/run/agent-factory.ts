import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

import type { FlatSettings, ModelRef } from "@aegisx/shared"
import { get, isActiveAgentStatus, isTerminalAgentStatus } from "@aegisx/shared"
import type { ProviderConnection } from "@aegisx/shared/domain"
import type { Api, Model } from "@earendil-works/pi-ai"
import { and, eq, inArray, ne } from "drizzle-orm"

import type { Database } from "../db"
import {
  agents,
  challengeFlags,
  challenges,
  events,
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
import type { SendOutcome } from "./channels-context"
import type { ContainerManager } from "./container/container-manager"
import { sdkContainerEnv, sdkExecEnv } from "./container/env-contract"
import {
  isLocalExecBackend,
  localContainerWorkspace,
} from "./container/local-manager"
import { emitDomainEvent } from "./domain-events/store"
import type { DomainEventActor } from "./domain-events/store"
import { RunActionError, RunStartError } from "./errors"
import { checkSpawnFence } from "./fence"
import { createAgentHost } from "./host/host"
import type { AgentLoopSettings, HostAgentSession } from "./host/host-session"
import type { LiveBus } from "./host/live"
import type { ModelResolver } from "./model-resolver"
import type { SlotModel } from "./model-resolver"
import {
  createRunModelRuntime,
  type RunModelRuntime,
  resolveRunModel,
} from "./model-runtime"
import type { RunPort } from "./ports"
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
  agentContainerName,
  challengeCacheVolume,
  challengeRoot,
  orchestratorContainerName,
  orchestratorKey,
  orchestratorRoot,
  runtimeDir,
  workspaceDir,
} from "./workspace-resolver"

type PlatformService = ReturnType<typeof createPlatformService>

/** Container env shared by scheduler and solver containers: the SDK ships
 * INSIDE the image (/opt/aegisx-sdk, PYTHONPATH preset); a host bind mount is
 * a dev-only override enabled by AEGISX_SDK_PATH (missing path there is a
 * hard error — it was explicitly requested). AEGISX_API_URL pointing at the
 * host loopback is normalized to host.docker.internal (a 127.0.0.1 value
 * leaks from host-side env and would address the container itself) — except
 * under the local execution backend, where solver bash runs in this same
 * container and the loopback address is the correct one. */
function containerApiUrl(): string {
  const raw = process.env.AEGISX_API_URL ?? "http://host.docker.internal:3000"
  if (isLocalExecBackend()) return raw
  return raw
    .replace("://127.0.0.1", "://host.docker.internal")
    .replace("://localhost", "://host.docker.internal")
}

function sdkDevMount(): { extraBinds: string[]; env: string[] } | undefined {
  const devPath = process.env.AEGISX_SDK_PATH
  if (!devPath) return undefined
  if (!existsSync(devPath)) {
    throw new Error(`AEGISX_SDK_PATH does not exist: ${devPath}`)
  }
  return {
    extraBinds: [`${devPath}:/opt/aegisx-sdk:ro`],
    env: ["PYTHONPATH=/opt/aegisx-sdk"],
  }
}

/** Scheduler container extras: the read-only challenge-workspaces mount (→
 * /challenges/<cid>/workspace — the scheduler reads solver WRITEUP.md /
 * solve.sh / shared/ artifacts directly, live progress included) + the env
 * vars (AEGISX_EVENT_ID / AEGISX_API_URL). */
function schedulerSdkContainerOpts(
  eventId: string,
  dataDir: string
): { extraBinds: string[]; env: string[] } {
  const dev = sdkDevMount()
  return {
    extraBinds: [
      `${resolve(dataDir, "events", eventId, "challenges")}:/challenges:ro`,
      ...(dev?.extraBinds ?? []),
    ],
    env: [...sdkContainerEnv(eventId, containerApiUrl()), ...(dev?.env ?? [])],
  }
}

/** Solver container extras: the same env — but NO /challenges mount (a
 * solver reaches its own challenge workspace at /workspace — other
 * challenges are not its business). Per-agent identity (AEGISX_AGENT_ID +
 * a minted AEGISX_TOKEN) rides the per-exec env provider of the bash tool:
 * it is minted at each execute, never stored. */
function solverSdkContainerOpts(eventId: string): {
  extraBinds: string[]
  env: string[]
} {
  const dev = sdkDevMount()
  return {
    extraBinds: [...(dev?.extraBinds ?? [])],
    env: [...sdkContainerEnv(eventId, containerApiUrl()), ...(dev?.env ?? [])],
  }
}

/** Reusable per-workspace handles shared by every agent on that workspace. */
export type WorkspaceContext = {
  /** challengeId, or `orch:<eventId>` for the scheduler workspace. */
  key: string
  /** Host root of the workspace tree. */
  rootDir: string
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
  /** Who is spawning — the actor recorded on a fence.blocked fact. */
  actor: DomainEventActor
}

export type AgentFactoryDeps = {
  db: Database
  dataDir: string
  containerManager: ContainerManager
  platformService: PlatformService
  providers: () => ProviderConnection[]
  /** Loopback origin of this server — exact-endpoint gateway providers route
   * their models.json baseUrl through /api/llm-relay here. */
  relayOrigin: string
  /** Monotonic config-store version (bumped on every providers/settings
   * mutation). Used to detect whether a workspace's cached ModelRuntime
   * is stale before resolving a model. */
  configVersion: () => number
  modelResolver: ModelResolver
  queries: AgentQueries
  bus: LiveBus
  /** Unified message layer core (derived-key channels). */
  channels: ChannelService
  /** Whether the agent already has a live session mounted (prepare's
   * idempotency guard). */
  hasLiveSession(agentId: string): boolean
  /** Mount a freshly built host session (creates the agent's runtime on
   * first touch). */
  mountSession(agentId: string, session: HostAgentSession): void
  /** Arm the agent's hard-deadline timers (spawn + reopen). */
  armDeadline(agentId: string, deadlineAt: string | null): void
  /** Drive a turn (the spawn's priming prompt). */
  send(agentId: string, text: string): Promise<SendOutcome>
  /** finish_run winner: the agent self-terminates at its turn settle. */
  requestFinish(agentId: string, summary: string): void
  /** finish_run's missing-flag warning, once per agent. */
  hasFinishFlagWarned(agentId: string): boolean
  markFinishFlagWarned(agentId: string): void
  withFence: <T>(op: () => T | Promise<T>) => Promise<T>
  getSettings: () => FlatSettings
  now: () => string
  status: AgentStatus
  /** Late-bound queue port (boot recovery resets running items); bound by the
   * assembly root before any spawn runs. */
  queue: RunPort<QueueService>
  /** Land a failed spawn through the runtime's single terminal path (disposes
   * a session that a late failure already mounted; forgets the runtime).
   * Without a runtime the agent terminalizes straight to `failed` with the
   * launch error recorded (completedAt stays null). */
  settleFailedSpawn(agentId: string, error: string): Promise<void>
  agentSettings: () => AgentLoopSettings
  /** Test seam: override the host-session creation (default = createAgentHost). */
  createHost: typeof createAgentHost
  /** Unattended appliance mode: boot recovery must not force the event queues
   * into `paused` (no human exists to resume them) — a surviving queue_state
   * row is honoured as-is and draining resumes. */
  unattended: boolean
  /** Read the event's scheduler policy (scheduler-admin). */
  getSchedulerConfig(eventId: string): {
    eventId: string
    modelId: string | null
    instruction: string
    maxConcurrentTargets: number
  }
}

export type AgentFactory = ReturnType<typeof createAgentFactory>

/** The fixed solver tool set (no inter-agent communication tools — solvers
 * coordinate via the workspace + channels). */
const SOLVER_TOOLS = (targetSupported: boolean): string[] => [
  "submit_flag",
  "finish_run",
  ...(targetSupported
    ? ["get_target", "start_target", "extend_target", "stop_target"]
    : []),
]

const BOOT_RECOVERY_ACTOR: DomainEventActor = {
  kind: "system",
  actorId: "boot-recovery",
}
const PREPARE_ACTOR: DomainEventActor = { kind: "system", actorId: "prepare" }
const RESUME_ACTOR: DomainEventActor = { kind: "system", actorId: "resume" }

function workspaceKeyOf(row: {
  eventId: string
  challengeId: string | null
}): string {
  return row.challengeId ?? orchestratorKey(row.eventId)
}

/** The agent's own sandbox name: per-agent for solvers, the event's
 * orchestrator container for the scheduler. */
function sandboxNameOf(row: {
  id: string
  eventId: string
  challengeId: string | null
}): string {
  return row.challengeId
    ? agentContainerName(row.id)
    : orchestratorContainerName(row.eventId)
}

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
 * v19 spawn + prepare + reopen orchestration (the execution unit is the
 * agent). One spawn = one agent row + a one-shot per-agent sandbox (prepare
 * creates it, settle destroys it) + the primed first turn. The workspace is
 * a derived path; the model runtime is shared per workspace (single-flighted).
 */
export function createAgentFactory(deps: AgentFactoryDeps) {
  const {
    db,
    dataDir,
    containerManager,
    platformService,
    providers,
    relayOrigin,
    configVersion,
    modelResolver,
    queries,
    bus,
    channels,
    withFence,
    getSettings,
    now,
    status,
    agentSettings,
    createHost,
  } = deps

  /** Scheduler management tools. EMPTY after the SDK convergence: the
   * orchestrator manages via the container-side `aegisx` Python SDK + bash,
   * not native tools. */
  const ORCHESTRATOR_TOOLS: string[] = []

  // --- workspace contexts (per challenge / scheduler, single-flighted) ----

  const contexts = new Map<string, WorkspaceContext>()
  const building = new Map<string, Promise<WorkspaceContext>>()
  /** In-flight sandbox builds per agent id (concurrent prepares of one agent
   * coalesce; different agents build independently). */
  const buildingContainers = new Map<string, Promise<void>>()
  /** In-flight ModelRuntime refreshes per workspace (coalesce concurrent
   * callers onto the pending refresh). */
  const runtimeRefreshes = new Map<string, Promise<void>>()

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
      const containerWorkspace = isLocalExecBackend()
        ? localContainerWorkspace(key)
        : get(settings, "container.workspace")
      mkdirSync(workspaceDir(root), { recursive: true })
      mkdirSync(runtimeDir(root), { recursive: true })
      const modelRuntime = await createRunModelRuntime({
        runtimeDir: runtimeDir(root),
        providers: providers(),
        relayOrigin,
      })
      const ctx: WorkspaceContext = {
        key,
        rootDir: root,
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
      const rtDir = join(ctx.rootDir, "runtime")
      mkdirSync(rtDir, { recursive: true })
      writeFileSync(
        join(rtDir, "models.json"),
        `${JSON.stringify(generateModelsJson(providers(), relayOrigin), null, 2)}\n`
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

  /** Evict a deleted workspace's in-memory state (challenge / event
   * deletion): the cached WorkspaceContext holds a live ModelRuntime
   * pointing at the removed rootDir, and a pending build/refresh would
   * resurrect it. A later spawn on the workspace rebuilds from scratch. */
  function forgetWorkspace(row: {
    eventId: string
    challengeId: string | null
  }): void {
    const key = workspaceKeyOf(row)
    contexts.delete(key)
    building.delete(key)
    runtimeRefreshes.delete(key)
  }

  /** Get-or-create one agent's sandbox. Keyed per agent (in-flight map keeps
   * concurrent prepares of the same agent single-flighted; two agents on one
   * challenge build independent containers). A still-running sandbox is
   * reused — create would remove-first. Slow I/O runs outside every lock. */
  async function ensureContainerFor(
    row: { id: string; eventId: string; challengeId: string | null },
    ctx: WorkspaceContext
  ): Promise<void> {
    const pending = buildingContainers.get(row.id)
    if (pending) return pending
    const promise = (async () => {
      const name = sandboxNameOf(row)
      if (await containerManager.isRunning(name)) return
      const settings = getSettings()
      // Challenge tool caches live on a named docker volume shared by the
      // challenge's agent containers (a plain host dir under the local
      // backend); the scheduler has no cache (it keeps /challenges:ro).
      const cacheSource =
        row.challengeId === null
          ? undefined
          : isLocalExecBackend()
            ? join(ctx.rootDir, "cache")
            : challengeCacheVolume(row.challengeId)
      const sdk = row.challengeId
        ? solverSdkContainerOpts(row.eventId)
        : schedulerSdkContainerOpts(row.eventId, dataDir)
      await containerManager.create({
        name,
        image: get(settings, "container.image"),
        workingDir: ctx.containerWorkspace,
        binds: [
          `${workspaceDir(ctx.rootDir)}:${ctx.containerWorkspace}`,
          ...(cacheSource
            ? [
                `${cacheSource}:/var/cache/apt/archives`,
                `${cacheSource}:/opt/aegisx-cache`,
              ]
            : []),
        ],
        limits: {
          cpus: get(settings, "container.cpus"),
          memoryMb: get(settings, "container.memoryMb"),
          pidsLimit: get(settings, "container.pidsLimit"),
        },
        tmpfsSize: get(settings, "container.tmpfsSize"),
        networkMode: get(settings, "container.networkMode"),
        extraBinds: sdk.extraBinds,
        env: sdk.env,
      })
    })().finally(() => {
      if (buildingContainers.get(row.id) === promise) {
        buildingContainers.delete(row.id)
      }
    })
    buildingContainers.set(row.id, promise)
    return promise
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
        deps.requestFinish(row.id, summary)
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
      finishFlagWarned: () => deps.hasFinishFlagWarned(row.id),
      markFinishFlagWarned: () => {
        deps.markFinishFlagWarned(row.id)
      },
    }
  }

  // --- spawn --------------------------------------------------------------

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
    const timeoutMs =
      input.timeoutMs ?? get(settings, "scheduler.defaultRunTimeoutMs")
    const deadlineAtIso = new Date(Date.now() + timeoutMs).toISOString()
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
          timeoutMs,
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
          containerWorkspace: wsCtx.containerWorkspace,
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
          // Every rejection leaves a trace (the decision log's raw material).
          emitDomainEvent(db, {
            type: "fence.blocked",
            eventId: input.eventId,
            challengeId: input.challengeId,
            actor: input.actor,
            payload: {
              code: decision.code,
              message: decision.message,
              via: "spawn",
            },
          })
          throw new RunActionError("capacity", decision.message)
        }
      }
      // The agents row is the agent.spawned projection.
      emitDomainEvent(db, {
        type: "agent.spawned",
        eventId: input.eventId,
        challengeId: input.challengeId,
        agentId,
        actor: input.actor,
        payload: {
          eventId: input.eventId,
          challengeId: input.challengeId,
          role: input.role,
          name,
          model: slotModel.ref,
          systemPrompt,
          tools,
          prompt: input.prompt ?? null,
          source,
          timeoutMs,
          deadlineAt: deadlineAtIso,
          queueItemId: input.queueItemId ?? null,
          createdAt: ts,
        },
      })
    })

    // Build the container outside the fence lock (slow I/O). On failure the
    // row is landed failed through the single terminal path (it counted live
    // as idle while building). Mark failed + rethrow.
    try {
      await ensureContainerFor({ ...probe, id: agentId }, wsCtx)
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
      await deps.send(agentId, initialPrompt)
      // Onboarding: a fresh agent's channel cursor is 0 — one deliver sweeps
      // the challenge's whole #team history (prior attempts' findings +
      // announce) into the first turn's tail.
      channels.deliver(agentId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // Land through the runtime's single terminal path. A failure after the
      // session was mounted (send / delivery) otherwise strands a runtime
      // entry holding a live session; settling disposes that session and
      // forgets the runtime. Without a runtime this is the plain terminalize
      // (with the launch error recorded, completedAt nulled).
      await deps.settleFailedSpawn(agentId, `Failed to start agent: ${message}`)
      throw new RunActionError("launch_failed", message)
    }

    deps.armDeadline(agentId, deadlineAtIso)
    status.emitAgent(agentId)
    status.emitAgentEvent(agentId, { type: "agent.started", agentId })
    emitDomainEvent(db, {
      type: "agent.started",
      eventId: input.eventId,
      challengeId: input.challengeId,
      agentId,
      actor: input.actor,
      payload: {},
    })
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
    if (deps.hasLiveSession(agentId)) return
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
        containerName: sandboxNameOf(row),
        containerManager,
        modelRuntime: ctx.modelRuntime,
        model: sdkModel,
        thinkingLevel: agentTarget.thinkingLevel,
        agentSettings: agentSettings(),
        systemPrompt: row.systemPrompt,
        extraTools: nativeTools,
        extraToolNames: snapshotTools,
        // Per-agent identity for the container-side `aegisx` SDK (the name
        // contract lives in container/env-contract.ts): the provider mints a
        // fresh short-lived token at every bash execute, so credentials are
        // never stored and never go stale on long-idling agents.
        execEnv: sdkExecEnv(agentId),
        ...(row.sessionFile
          ? { resumeFrom: { sessionId: row.sessionFile } }
          : {}),
        onUsageMaybeChanged: () => status.emitAgent(agentId),
        db,
        bus,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new RunActionError("launch_failed", message)
    }

    // The prepare-boundary fact: session pointer + active tool definitions
    // (no updatedAt bump — preparation is not an activity transition).
    emitDomainEvent(db, {
      type: "agent.session_prepared",
      eventId: row.eventId,
      challengeId: row.challengeId,
      agentId,
      actor: PREPARE_ACTOR,
      payload: {
        sessionId: agentSession.sessionId ?? null,
        toolDefinitions: snapshotActiveToolDefinitions(agentSession.session),
      },
    })
    deps.mountSession(agentId, agentSession)
  }

  /** Reopen a terminal agent (cold resume): container + session rebuilt on
   * demand via prepareAgent, then status → idle, timers re-armed, scheduler
   * notified (`agent.reopened`). A failed prepare leaves the terminal state
   * untouched and rethrows. Invoked from runtime.send's cold-resume hook. */
  async function resumeAgent(agentId: string): Promise<void> {
    const row = queries.getAgentRow(agentId)
    if (!row) throw new RunActionError("not_found", "Agent not found")
    const reopen = isTerminalAgentStatus(row.status)
    await prepareAgent(agentId)
    if (reopen) {
      emitDomainEvent(db, {
        type: "agent.reopened",
        eventId: row.eventId,
        challengeId: row.challengeId,
        agentId,
        actor: RESUME_ACTOR,
        payload: { at: now() },
      })
      status.emitAgent(agentId)
      status.emitAgentEvent(agentId, { type: "agent.reopened", agentId })
    }
    deps.armDeadline(agentId, row.deadlineAt)
  }

  // --- boot recovery ---------------------------------------------------------

  /** Boot recovery: no sandbox survives a crash (all state is rebuildable —
   * workspaces on binds/volumes, sessions in the DB). Live agents flip to
   * idle (a message reopens them and prepare rebuilds the sandbox); every
   * orphan container under our naming prefixes is swept deterministically;
   * running queue items reset to pending; queues with visible items start
   * paused (interactive only — see below). Every event with recovery
   * activity gets a boot.recovered summary fact. */
  async function recoverOnBoot(): Promise<void> {
    const rows = db.select().from(agents).all()
    const ts = now()
    const seenQueueEvents = new Set<string>()
    const stats = new Map<
      string,
      { liveFlipped: number; queuesReset: number; queuesPaused: number }
    >()
    const statOf = (eventId: string) => {
      let s = stats.get(eventId)
      if (!s) {
        s = { liveFlipped: 0, queuesReset: 0, queuesPaused: 0 }
        stats.set(eventId, s)
      }
      return s
    }
    for (const row of rows) {
      if (row.status !== "running" && row.status !== "idle") continue
      if (row.status === "running") {
        emitDomainEvent(db, {
          type: "agent.recovered",
          eventId: row.eventId,
          challengeId: row.challengeId,
          agentId: row.id,
          actor: BOOT_RECOVERY_ACTOR,
          payload: { from: row.status, to: "idle", at: ts },
        })
        statOf(row.eventId).liveFlipped += 1
      }
      if (row.queueItemId && !seenQueueEvents.has(row.eventId)) {
        seenQueueEvents.add(row.eventId)
        deps.queue.get().resetRunning(row.eventId)
        statOf(row.eventId).queuesReset = 1
      }
    }
    // Orphan sweep: list by prefix + remove — replaces the old
    // remove-first-for-live-workspaces gamble with a deterministic clear.
    // Volumes (caches) are kept. The scheduler prefix is included: a restart
    // invalidates every sandbox equally and the scheduler's reopen rebuilds.
    let swept = 0
    for (const prefix of ["aegisx-agent-", "aegisx-orch-"]) {
      const names = await containerManager.list(prefix).catch(() => [])
      for (const name of names) {
        await containerManager.remove(name).catch(() => undefined)
        swept += 1
      }
    }
    if (swept > 0) {
      console.info("boot orphan sandbox sweep", { removed: swept })
    }
    // Events with visible queue items. Interactive: every queue starts paused
    // so the human reviews what the crash left behind before it re-fires —
    // boot never auto-drains. Unattended: nobody can resume, so forcing a
    // pause would strand the queue (and every pending item) for the rest of
    // the run — skip the write and let the surviving queue_state stand: a
    // queue that was running resumes, a queue the scheduler deliberately
    // paused stays paused (drainOnce skips paused events).
    const pendingEvents = db
      .select({ eventId: spawnQueue.eventId })
      .from(spawnQueue)
      .where(inArray(spawnQueue.status, ["pending", "running", "failed"]))
      .groupBy(spawnQueue.eventId)
      .all()
    if (deps.unattended) {
      if (pendingEvents.length > 0) deps.queue.get().scheduleDrain()
    } else {
      for (const { eventId } of pendingEvents) {
        emitDomainEvent(db, {
          type: "queue.paused",
          eventId,
          actor: BOOT_RECOVERY_ACTOR,
          payload: { source: "boot" },
        })
        statOf(eventId).queuesPaused = 1
      }
    }
    for (const [eventId, s] of stats) {
      if (s.liveFlipped === 0 && s.queuesReset === 0 && s.queuesPaused === 0)
        continue
      emitDomainEvent(db, {
        type: "boot.recovered",
        eventId,
        actor: BOOT_RECOVERY_ACTOR,
        payload: s,
      })
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
    sandboxNameOf,
    refreshWorkspaceRuntime,
    ensureWorkspaceRuntimeFresh,
    forgetWorkspace,
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
