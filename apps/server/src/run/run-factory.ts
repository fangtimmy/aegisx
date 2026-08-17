import { existsSync, mkdirSync } from "node:fs"
import { relative, resolve } from "node:path"

import type {
  EnvironmentConfig,
  FlatSettings,
  ModelRef,
  RunPublic,
  SolverSpec,
} from "@aegisx/shared"
import { get } from "@aegisx/shared"
import type { ProviderConnection } from "@aegisx/shared/domain"
import type { ThinkingLevel } from "@aegisx/shared/live-event"
import type { Api, Model } from "@earendil-works/pi-ai"
import { and, eq, inArray } from "drizzle-orm"

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
  runQueue,
  runs,
} from "../db/schema"
import { EventScopeEmitter } from "../orchestration/event-scope"
import {
  loadTemplateMap,
  renderTemplate,
} from "../orchestration/prompt-templates"
import {
  deriveCapabilities,
  type EventScopePayload,
  type PromptContext,
} from "../orchestration/types"
import { getChallengeRemote } from "../platforms/challenge-state"
import type { createPlatformService } from "../platforms/service"
import type { ChannelService } from "./channels"
import type { ContainerManager } from "./container/container-manager"
import { createToolboxContainer } from "./container/container-manager"
import { RunActionError, RunStartError } from "./errors"
import { checkLaunchFence } from "./fence"
import type { ModelResolver } from "./model-resolver"
import type { SlotModel } from "./model-resolver"
import {
  createRunModelRuntime,
  type RunModelRuntime,
  resolveRunModel,
} from "./model-runtime"
import {
  buildEventPromptContext,
  buildPromptContext,
  copyAttachments,
} from "./prompt"
import type { RunQueries } from "./queries"
import type { SchedulerDigest } from "./scheduler-digest"
import type { RunSchedulerToolContext } from "./scheduler-tools"
import { createSchedulerTools } from "./scheduler-tools"
import { createMainTools, type RunToolContext } from "./tools"

type PlatformService = ReturnType<typeof createPlatformService>

/** Host path to the scheduler Python SDK package (mount source). Overridable
 * via AEGISX_SDK_PATH; default = repo apps/sdk/python relative to this file.
 * Absent when the path does not exist (the mount is then skipped). */
function sdkHostPath(): string | undefined {
  const candidate =
    process.env.AEGISX_SDK_PATH ??
    resolve(import.meta.dir, "../../../../apps/sdk/python")
  return existsSync(candidate) ? candidate : undefined
}

/** Event-scope container extras: the read-only SDK mount (→ /opt/aegisx-sdk),
 * the read-only run-workspaces mount (→ /runs/<runId>/workspace — the
 * scheduler reads solver WRITEUP.md / solve.sh directly, live progress too),
 * + the env vars (PYTHONPATH / AEGISX_EVENT_ID / AEGISX_API_URL /
 * AEGISX_ROLE=scheduler). Undefined when the SDK path is absent. */
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
      `${resolve(dataDir, "runs")}:/runs:ro`,
    ],
    env: [
      `AEGISX_EVENT_ID=${eventId}`,
      `AEGISX_API_URL=${process.env.AEGISX_API_URL ?? "http://host.docker.internal:3000"}`,
      "PYTHONPATH=/opt/aegisx-sdk",
      "AEGISX_ROLE=scheduler",
    ],
  }
}

/** Challenge-scope container extras (docs/im-channels.md §四): the SAME
 * read-only SDK mount as the scheduler (solvers post/read/ask/fetch via
 * `aegisx.channels`), the same event/API env — but AEGISX_ROLE=solver (the
 * SDK's client-side management gate) and **NO /runs mount** (a solver never
 * sees other runs' workspaces — injection surface stays minimal). Per-agent
 * identity (AEGISX_AGENT_ID / AEGISX_RUN_ID) is injected per-exec by the bash
 * tool, not container-wide: one run's N solvers share this container. */
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

/** Reusable per-run handles (model runtime, container, the prompt context).
 * Agents carry their own creation snapshot. */
export type RunContext = {
  containerName: string
  workspaceHostPath: string
  containerWorkspace: string
  sessionsDir: string
  modelRuntime: RunModelRuntime
  sdkModel: Model<Api> | undefined
  /** Run default model ref (the entry agent's concrete ref) — spawn children
   * resolve + snapshot it at spawn time. */
  defaultModelRef: ModelRef
  thinkingLevel: ThinkingLevel
  promptContext: PromptContext
  challengeId: string
}

export type CreateRunInput = {
  container: {
    image: string
    cpus: number
    memoryMb: number
    pidsLimit: number
    tmpfsSize: string
    workspace: string
  }
  /** Who started this run. Defaults to 'manual'. */
  source?: "manual" | "scheduler"
  /** Per-run hard deadline (ms). Defaults to scheduler.defaultRunTimeoutMs. */
  timeoutMs?: number
  /** Back-filled when the scheduler drainer launches this run from the queue;
   * stamped on the run row to guard the run→queue done transition. */
  queueItemId?: string
  /** Per-run strategy (the queue/scheduler `prompt`). Never replaces the
   * rendered `initial` template — it is injected as a `strategy` variable that
   * renders a `## Strategy` section (the standard blocks stay). */
  strategy?: string
  /** Per-solver creation specs (v9): array length = solver count (1..MAX);
   *  empty = one solver with all defaults. */
  solvers?: SolverSpec[]
} & (
  | { scopeType: "challenge"; challengeId: string }
  | { scopeType: "event"; eventId: string; instruction: string }
)

export type RunFactoryDeps = {
  db: Database
  dataDir: string
  containerManager: ContainerManager
  platformService: PlatformService
  providers(): ProviderConnection[]
  modelResolver: ModelResolver
  queries: RunQueries
  bus: LiveBus
  /** Reusable per-run handles (entry snapshot lives on the agent row). */
  contexts: Map<string, RunContext>
  /** Per-event run-lifecycle emitters, owned by the event's scheduler run. */
  eventScopes: Map<string, EventScopeEmitter>
  /** Lazy per-event scheduler digest (docs/im-channels.md §三 — the DM:
   * scheduler delivery policy): lifecycle events are posted as system
   * messages into the scheduler DM; the digest policy flushes steers. Created
   * here, torn down with the scheduler run. */
  digestFor(eventId: string, orchestratorAgentId: string): SchedulerDigest
  /** Unified message layer core (channels). */
  channels: ChannelService
  /** Finish winner per agent: the agent whose atomic finishing UPDATE hit. */
  pendingFinish: Map<string, { summary: string; runId: string }>
  /** Runs finish_run already warned about a missing flag (once per run). */
  finishFlagWarned: Set<string>
  lifecycle: SessionLifecycle
  withFence<T>(op: () => T | Promise<T>): Promise<T>
  getSettings(): FlatSettings
  now(): string
  updateRun(runId: string, patch: Partial<typeof runs.$inferInsert>): void
  updateAgent(agentId: string, patch: Partial<typeof agents.$inferInsert>): void
  requireRun(runId: string): RunPublic
  containerName(runId: string): string
  workspaceAbs(runId: string): string
  sessionsAbs(runId: string): string
  runtimeAbs(runId: string): string
  /** Atomic finish claim (run-status module). */
  markFinishing(runId: string): boolean
  teardownRun(
    runId: string,
    opts?: { summary?: string; finished?: boolean }
  ): void
  clearForceKill(runId: string): void
  terminateContainer(runId: string, name: string): void
  armRunTimers(runId: string, deadlineAt: string | null): void
  emitRun(runId: string): void
  emitAgents(runId: string): void
  emitRunEvent(runId: string, payload: EventScopePayload): void
  agentSettings(): AgentLoopSettings
  /** Test seam: override the host-session creation (default = createAgentHost). */
  createHost: typeof createAgentHost
  /** Scheduler-tool context for the event-scope orchestrator (scheduler-admin). */
  buildSchedulerToolContext(
    runId: string,
    agentId: string
  ): RunSchedulerToolContext
  /** Read the event's scheduler policy (scheduler-admin). */
  getSchedulerConfig(eventId: string): {
    eventId: string
    modelId: string | null
    instruction: string
    maxConcurrentTargets: number
  }
}

export type RunFactory = ReturnType<typeof createRunFactory>

/** Fresh-create + cold-restore orchestration (v9: no plugins): the run's
 * model/container/prompt context, direct N-solver creation, the built-in
 * scheduler wake-up wiring, per-agent session preparation, and boot recovery.
 * The shared create/restore tail guarantees a restored run runs the same setup
 * code as a fresh one. */
export function createRunFactory(deps: RunFactoryDeps) {
  const {
    db,
    dataDir,
    containerManager,
    platformService,
    providers,
    modelResolver,
    queries,
    bus,
    contexts,
    eventScopes,
    digestFor,
    channels,
    pendingFinish,
    finishFlagWarned,
    lifecycle,
    withFence,
    getSettings,
    now,
    updateRun,
    updateAgent,
    requireRun,
    containerName,
    workspaceAbs,
    sessionsAbs,
    runtimeAbs,
    agentSettings,
    createHost,
    markFinishing,
    emitRun,
    emitAgents,
  } = deps

  /** v9: at most this many parallel solvers per challenge run. */
  const MAX_SOLVERS_PER_RUN = 4

  /** The fixed solver tool set (no inter-agent communication tools — solvers
   * coordinate via workspace files only). */
  const SOLVER_TOOLS = (targetSupported: boolean): string[] => [
    "submit_flag",
    "finish_run",
    ...(targetSupported
      ? ["get_target", "start_target", "extend_target", "stop_target"]
      : []),
  ]

  /** Scheduler management tools (the 18 native tools). EMPTY after the SDK
   * convergence (docs/scheduler-python-sdk.md): the orchestrator manages via
   * the container-side `aegisx` Python SDK + bash, not native tools. The tool
   * definitions in scheduler-tools.ts stay (HTTP endpoints untouched) but are
   * never granted — new scheduler agents snapshot this empty list, and cold
   * restores intersect the persisted snapshot with it (legacy rows carrying
   * the old 18 names do not resurrect the tools). */
  const ORCHESTRATOR_TOOLS: string[] = []

  /** The per-event run-lifecycle emitter (created lazily). */
  function eventScopeFor(eventId: string): EventScopeEmitter {
    let emitter = eventScopes.get(eventId)
    if (!emitter) {
      emitter = new EventScopeEmitter()
      eventScopes.set(eventId, emitter)
    }
    return emitter
  }

  /** Built-in scheduler wake-up (v9: replaces the scheduler plugin's wire;
   * channels era, docs/im-channels.md §三): the event's scheduler DM channel
   * is ensured, then child-run lifecycle events are posted into it as system
   * messages — the digest policy (run/scheduler-digest.ts) decides when to
   * flush a steer. The emitter's callbacks are already wrapped in try/catch
   * (EventScopeEmitter). */
  function attachSchedulerWakeup(
    eventId: string,
    orchestratorAgentId: string
  ): void {
    const emitter = eventScopeFor(eventId)
    channels.ensureSchedulerDm(eventId, orchestratorAgentId)
    const digest = digestFor(eventId, orchestratorAgentId)
    emitter.on("run.started", (e) => digest.push(e))
    emitter.on("run.idle", (e) => digest.push(e))
    emitter.on("run.flagAccepted", (e) => digest.push(e))
    emitter.on("run.finished", (e) => digest.push(e))
    emitter.on("run.timedOut", (e) => digest.push(e))
    emitter.on("run.resumed", (e) => digest.push(e))
  }

  /** Latest assistant text for an agent (read_run fallback). */
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

  /** Build the per-agent native tool context. */
  function buildAgentToolContext(
    runId: string,
    challengeId: string,
    agentId: string
  ): RunToolContext {
    return {
      runId,
      challengeId,
      agentId,
      submitFlag: (flag, verifyRemote = true) =>
        platformService
          .submitFlag(runId, challengeId, flag, verifyRemote, agentId)
          .then((r) => r ?? null),
      targetAction: (action) =>
        platformService.targetAction(challengeId, action),
      /** Atomic finish claim. Only the agent whose UPDATE hits schedules a
       * teardown (at its turn settle). */
      requestFinish: (summary) => {
        if (markFinishing(runId)) {
          pendingFinish.set(agentId, { summary, runId })
        }
      },
      hasAcceptedFlag: () =>
        Boolean(
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
        ),
      finishFlagWarned: () => finishFlagWarned.has(runId),
      markFinishFlagWarned: () => {
        finishFlagWarned.add(runId)
      },
      lastAssistantText: (id) => lastAssistantText(runId, id),
    }
  }

  /** Insert one agent row with its creation snapshot (system prompt, tools,
   * model ref). Shared by the direct N-solver creation and the event-scope
   * orchestrator creation. Returns the new agent id. */
  function insertAgentRow(input: {
    runId: string
    slot: string
    role: string
    name: string
    isEntry: boolean
    model: ModelRef
    systemPrompt: string
    tools: string[]
  }): string {
    const id = crypto.randomUUID()
    const ts = now()
    db.insert(agents)
      .values({
        id,
        runId: input.runId,
        slot: input.slot,
        role: input.role,
        parentAgentId: null,
        isEntry: input.isEntry,
        model: input.model,
        systemPrompt: input.systemPrompt,
        tools: JSON.stringify(input.tools),
        status: "idle",
        sessionFile: null,
        name: input.name,
        task: null,
        createdAt: ts,
        updatedAt: ts,
      })
      .run()
    return id
  }

  /** Render the i-th solver's first-turn prompt. `override` mode returns the
   * raw prompt verbatim; otherwise the `initial` template renders with the
   * run-level + solver-level strategy joined into one Strategy section. */
  function solverInitial(
    templateMap: Map<string, string>,
    ctx: PromptContext,
    runStrategy: string | undefined,
    spec: SolverSpec
  ): string {
    if (spec.promptMode === "override" && spec.prompt) return spec.prompt
    const strategy = [runStrategy, spec.prompt]
      .filter((part): part is string => Boolean(part))
      .join("\n\n")
    return renderTemplate(templateMap, "initial", {
      ...ctx,
      ...(strategy ? { strategy } : {}),
    })
  }

  /** challenge scope: directly create N solver agent rows and prime each with
   * its own rendered initial prompt (all solvers prime — no lazy agents). */
  async function createSolvers(
    runId: string,
    ctx: PromptContext,
    templateMap: Map<string, string>,
    slotModels: SlotModel[],
    specs: SolverSpec[],
    runStrategy: string | undefined,
    targetSupported: boolean
  ): Promise<void> {
    const tools = SOLVER_TOOLS(targetSupported)
    const capabilities = deriveCapabilities(tools)
    for (let i = 0; i < specs.length; i += 1) {
      const spec = specs[i]!
      const slotModel = slotModels[i]!
      const slot = `solver-${i + 1}`
      const isEntry = i === 0
      const systemPrompt = renderTemplate(templateMap, "mainSystem", {
        ...ctx,
        agent: {
          role: "solver",
          isMain: isEntry,
          name: `Solver ${i + 1}`,
          task: null,
          isEntry,
        },
        capabilities,
        model: {
          provider: slotModel.providerLabel,
          name: slotModel.modelLabel,
          id: slotModel.modelId,
        },
      })
      const agentId = insertAgentRow({
        runId,
        slot,
        role: "solver",
        name: `Solver ${i + 1}`,
        isEntry,
        model: slotModel.ref,
        systemPrompt,
        tools,
      })
      channels.ensureAgentDm(runId, agentId)
      await prepareAgent(runId, agentId)
      await lifecycle.send(
        agentId,
        solverInitial(templateMap, ctx, runStrategy, spec)
      )
      // Onboarding (v17 §11.3): a fresh solver's cursor is 0 — the challenge's
      // ENTIRE group-channel history (prior runs' findings/dead-ends +
      // announce) is unread. One deliver right after the prime sweeps it
      // into the first turn's tail as a single steer (8K cap + overflow
      // folding bound the size); mechanical history intake replaces the old
      // prompt-discipline handoff. Cold restores do NOT pass here (their
      // cursors sit where they left off — only genuinely new messages steer).
      channels.deliver(agentId)
    }
  }

  /** Shared create/restore tail: persist the run-level context (container
   * refs, model, prompt context) and, for the event scope, attach the built-in
   * scheduler wake-up. The differences (fence/slot reservation, the container
   * build, agent creation/priming) stay in the callers. */
  async function buildRunContext(opts: {
    runId: string
    scope: "challenge" | "event"
    eventId: string
    challengeId: string | null
    containerName: string
    containerWorkspace: string
    wsAbs: string
    modelRuntime: RunModelRuntime
    sdkModel: Model<Api> | undefined
    defaultModelRef: ModelRef
    thinkingLevel: ThinkingLevel
    promptContext: PromptContext
    /** event scope only: the orchestrator agent the wake-up events send to. */
    orchestratorAgentId?: string
  }): Promise<void> {
    contexts.set(opts.runId, {
      containerName: opts.containerName,
      workspaceHostPath: opts.wsAbs,
      containerWorkspace: opts.containerWorkspace,
      sessionsDir: sessionsAbs(opts.runId),
      modelRuntime: opts.modelRuntime,
      sdkModel: opts.sdkModel,
      defaultModelRef: opts.defaultModelRef,
      thinkingLevel: opts.thinkingLevel,
      promptContext: opts.promptContext,
      challengeId: opts.challengeId ?? "",
    })
    if (opts.scope === "event") {
      if (!opts.orchestratorAgentId) {
        throw new RunActionError(
          "invalid_state",
          "Event-scope run context requires the orchestrator agent id"
        )
      }
      attachSchedulerWakeup(opts.eventId, opts.orchestratorAgentId)
    }
  }

  async function create(input: CreateRunInput): Promise<RunPublic> {
    const challenge =
      input.scopeType === "challenge"
        ? db
            .select()
            .from(challenges)
            .where(eq(challenges.id, input.challengeId))
            .get()
        : undefined
    if (input.scopeType === "challenge" && !challenge) {
      throw new RunActionError("not_found", "Challenge not found")
    }
    const event =
      input.scopeType === "event"
        ? db.select().from(events).where(eq(events.id, input.eventId)).get()
        : undefined
    if (input.scopeType === "event" && !event) {
      throw new RunActionError("not_found", "Event not found")
    }
    // Scheduler runs are never cold-restored and there is at most one per
    // event: a fresh start replaces any previous closed row (newSession
    // semantics) but never steps on a live one.
    if (input.scopeType === "event") {
      const existing = db
        .select()
        .from(runs)
        .where(and(eq(runs.eventId, event!.id), eq(runs.scopeType, "event")))
        .get()
      if (existing) {
        if (existing.status === "closed") {
          await containerManager
            .remove(containerName(existing.id))
            .catch(() => undefined)
          db.delete(runs).where(eq(runs.id, existing.id)).run()
        } else {
          throw new RunActionError(
            "invalid_state",
            "A scheduler run is already active for this event"
          )
        }
      }
    }

    // v9 direct creation: challenge scope resolves one model per solver spec
    // (spec.model → global default), event scope resolves the scheduler's
    // model (scheduler_config.modelId → global default). Unresolvable refs
    // fail the launch with the ref in the message. The run default model =
    // solver-1's (challenge) / the orchestrator's (event) CONCRETE ref
    // (aliases resolved away).
    let specs: SolverSpec[] = []
    let slotModels: SlotModel[] = []
    let entryModel: SlotModel
    if (input.scopeType === "challenge") {
      specs = input.solvers?.length ? input.solvers : [{}]
      if (specs.length > MAX_SOLVERS_PER_RUN) {
        throw new RunActionError(
          "invalid_state",
          `A run supports at most ${MAX_SOLVERS_PER_RUN} solvers (got ${specs.length})`
        )
      }
      slotModels = specs.map((spec) =>
        modelResolver.resolveSlotModelFromRef(
          spec.model ?? modelResolver.defaultModelRef()
        )
      )
      entryModel = slotModels[0]!
    } else {
      const config = deps.getSchedulerConfig(input.eventId)
      entryModel = modelResolver.resolveSlotModelFromRef(
        config.modelId ?? modelResolver.defaultModelRef()
      )
    }
    const entryTarget = modelResolver.resolveModelTarget(entryModel.ref)
    if (!entryTarget) {
      throw new RunActionError(
        "invalid_state",
        `Configured model "${entryModel.ref}" is unavailable`
      )
    }
    if (!entryTarget.provider.apiKey) {
      throw new RunActionError("invalid_state", "Provider API key is required")
    }

    const runId = crypto.randomUUID()
    const runSource = input.source ?? "manual"
    const runTimeoutMs =
      input.timeoutMs ?? get(getSettings(), "scheduler.defaultRunTimeoutMs")
    const deadlineAtIso = new Date(Date.now() + runTimeoutMs).toISOString()
    const name = containerName(runId)
    const wsAbs = workspaceAbs(runId)
    const sessAbs = sessionsAbs(runId)
    const rtAbs = runtimeAbs(runId)
    mkdirSync(wsAbs, { recursive: true })
    mkdirSync(sessAbs, { recursive: true })
    mkdirSync(rtAbs, { recursive: true })

    const env: EnvironmentConfig = {
      type: "container",
      image: input.container.image,
      cpus: input.container.cpus,
      memoryMb: input.container.memoryMb,
      pidsLimit: input.container.pidsLimit,
    }
    const modelConfig = {
      provider: entryTarget.provider.label,
      modelId: entryTarget.model.modelId,
      modelLabel: entryTarget.model.label,
      thinkingLevel: entryTarget.thinkingLevel,
    }

    const promptContext =
      input.scopeType === "challenge"
        ? buildPromptContext(
            {
              runId,
              challenge: challenge!,
              remote: getChallengeRemote(db, challenge!.id),
              challengeAttachments: copyAttachments(
                db,
                dataDir,
                challenge!.id,
                wsAbs
              ),
              environment: env,
              model: modelConfig,
              multiSolver: specs.length > 1,
            },
            db,
            input.container.workspace
          )
        : buildEventPromptContext(
            {
              runId,
              eventId: event!.id,
              instruction: input.instruction,
              environment: env,
              model: modelConfig,
            },
            db,
            input.container.workspace
          )

    const modelRuntime = await createRunModelRuntime({
      runtimeDir: rtAbs,
      providers: providers(),
    })
    const sdkModel = resolveRunModel(
      modelRuntime,
      entryTarget.provider,
      entryTarget.model.id
    )
    if (!sdkModel)
      throw new RunStartError("Could not resolve the selected model")

    // Reserve the concurrency slot + persist the run row atomically under the
    // global fence. Challenge-scope launches are checked against the caps;
    // scheduler (event-scope) runs neither count nor consume slots.
    const ts = now()
    await withFence(async () => {
      if (input.scopeType === "challenge") {
        const decision = checkLaunchFence(db, getSettings(), {
          scopeType: "challenge",
          eventId: challenge!.eventId,
          challengeId: challenge!.id,
        })
        if (!decision.ok) {
          throw new RunActionError("capacity", decision.message)
        }
      }
      db.insert(runs)
        .values({
          id: runId,
          scopeType: input.scopeType,
          eventId:
            input.scopeType === "challenge" ? challenge!.eventId : event!.id,
          challengeId: challenge?.id ?? null,
          params: "{}",
          status: "running",
          model: entryModel.ref,
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
          queueItemId: input.queueItemId ?? null,
          createdAt: ts,
          startedAt: ts,
          updatedAt: ts,
        })
        .run()
    })

    // Build the container outside the fence lock (slow I/O). On failure drop
    // the reserved row so the slot is freed, then surface a launch error.
    try {
      await createToolboxContainer(containerManager, {
        name,
        image: env.image,
        workspace: input.container.workspace,
        hostWorkspace: wsAbs,
        cpus: env.cpus,
        memoryMb: env.memoryMb,
        pidsLimit: env.pidsLimit,
        tmpfsSize: input.container.tmpfsSize,
        networkMode: get(getSettings(), "container.networkMode"),
        ...(input.scopeType === "event"
          ? schedulerSdkContainerOpts(event!.id, dataDir)
          : solverSdkContainerOpts(challenge!.eventId)),
      })
    } catch (error) {
      db.delete(runs).where(eq(runs.id, runId)).run()
      throw new RunActionError(
        "launch_failed",
        error instanceof Error ? error.message : String(error)
      )
    }

    // Run-level live context (+ the built-in scheduler wake-up on the event
    // scope) — the same shared tail create and cold-restore run. The run row +
    // container exist before it; agents are created directly below.
    const templateMap = loadTemplateMap(db)
    try {
      if (input.scopeType === "challenge") {
        await buildRunContext({
          runId,
          scope: "challenge",
          eventId: challenge!.eventId,
          challengeId: challenge!.id,
          containerName: name,
          containerWorkspace: input.container.workspace,
          wsAbs,
          modelRuntime,
          sdkModel,
          defaultModelRef: entryModel.ref,
          thinkingLevel: entryTarget.thinkingLevel,
          promptContext,
        })
        // Channel tree first (§2.1 + v17 §11.2): the challenge's #team +
        // #announce exist (get-or-create — shared with every other run on
        // this challenge) before any solver can post; each solver's DM is
        // created with its agent row.
        channels.ensureChallengeChannels(runId)
        // Directly create + prime the N solver agents (v9: every solver
        // primes with its own rendered initial prompt).
        await createSolvers(
          runId,
          promptContext,
          templateMap,
          slotModels,
          specs,
          input.strategy,
          promptContext.run?.targetSupported ?? false
        )
      } else {
        // Directly create the orchestrator agent row with its snapshot, then
        // attach the built-in wake-up + prime with schedulerInitial.
        const capabilities = deriveCapabilities(ORCHESTRATOR_TOOLS)
        const systemPrompt = renderTemplate(templateMap, "orchestratorSystem", {
          ...promptContext,
          agent: {
            role: "orchestrator",
            isMain: true,
            name: "Scheduler",
            task: null,
            isEntry: true,
          },
          capabilities,
          model: {
            provider: entryModel.providerLabel,
            name: entryModel.modelLabel,
            id: entryModel.modelId,
          },
        })
        const agentId = insertAgentRow({
          runId,
          slot: "orchestrator",
          role: "orchestrator",
          name: "Scheduler",
          isEntry: true,
          model: entryModel.ref,
          systemPrompt,
          tools: ORCHESTRATOR_TOOLS,
        })
        await buildRunContext({
          runId,
          scope: "event",
          eventId: event!.id,
          challengeId: null,
          containerName: name,
          containerWorkspace: input.container.workspace,
          wsAbs,
          modelRuntime,
          sdkModel,
          defaultModelRef: entryModel.ref,
          thinkingLevel: entryTarget.thinkingLevel,
          promptContext,
          orchestratorAgentId: agentId,
        })
        await prepareAgent(runId, agentId)
        await lifecycle.send(
          agentId,
          renderTemplate(templateMap, "schedulerInitial", promptContext)
        )
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      for (const agent of queries.listAgents(runId)) {
        updateAgent(agent.id, {
          status: "failed",
          error: message,
          completedAt: now(),
          updatedAt: now(),
        })
      }
      deps.teardownRun(runId)
      updateRun(runId, {
        error: `Failed to start agent: ${message}`,
        updatedAt: now(),
      })
      throw new RunActionError("launch_failed", message)
    }

    emitRun(runId)
    emitAgents(runId)
    deps.armRunTimers(runId, deadlineAtIso)
    deps.emitRunEvent(runId, { type: "run.started", runId })
    return requireRun(runId)
  }

  /** Cold-restore a closed run's run-level context: rebuild the container +
   * model runtime + prompt context, re-attach the built-in scheduler wake-up
   * (event scope), re-arm timers, and notify. v9: NO agent rows are created —
   * the persisted agent rows are the whole truth; sessions open lazily per
   * agent in prepareAgent (snapshot priority). */
  async function restoreRunContext(
    runId: string,
    row: typeof runs.$inferSelect
  ): Promise<void> {
    // Scheduler (event-scoped) runs cold-restore like challenge runs: a
    // message to a closed run's agent rebuilds the container + session and
    // re-attaches the wake-up wiring. `start` on a closed scheduler is now a
    // cold-restore too (W3.2 — memory kept); only `start reset:true` goes
    // fresh — create() deletes the closed row first.
    const settings = getSettings()

    // Cold-restoring a closed challenge run occupies a concurrency slot (one
    // of the TWO fence enforcement points — create() for new containers and
    // this restore path; the old onTurnGate fresh-turn gate was removed, so a
    // warm idle run wakes without re-checking). Scheduler runs do not count
    // (same as create). Reserve atomically: check the fence (challenge only) +
    // flip the run row to running so concurrent launches count it. Any later
    // failure reverts to closed (releasing the slot) below.
    //
    // `finishing` is reset here too: a crash between finish_run's atomic claim
    // and its teardown leaves finishing=1 on a closed row (recoverOnBoot only
    // wrote closed). Restoring is a NEW lifecycle — the stale finish intent is
    // void, so the run must be claimable by finish_run again.
    await withFence(async () => {
      if (row.scopeType === "challenge") {
        const decision = checkLaunchFence(db, settings, {
          scopeType: "challenge",
          eventId: row.eventId,
          challengeId: row.challengeId,
        })
        if (!decision.ok) {
          throw new RunActionError("capacity", decision.message)
        }
      }
      updateRun(runId, {
        status: "running",
        finishing: false,
        updatedAt: now(),
      })
    })

    try {
      const wsAbs = workspaceAbs(runId)
      const rtAbs = runtimeAbs(runId)
      // A stale SIGKILL grace timer from the prior close must not fire against
      // the freshly rebuilt container (same name).
      deps.clearForceKill(runId)
      mkdirSync(rtAbs, { recursive: true })

      const modelRuntime = await createRunModelRuntime({
        runtimeDir: rtAbs,
        providers: providers(),
      })
      // Resolve the run default model (stored as a ref string) for spawn
      // children + prompt context. Best-effort: an unresolvable stored ref must
      // not fail the whole restore — prepareAgent resolves each agent's model
      // from its own snapshot.
      const defaultTarget = modelResolver.resolveModelTarget(row.model)
      const sdkModel = defaultTarget
        ? resolveRunModel(
            modelRuntime,
            defaultTarget.provider,
            defaultTarget.model.id
          )
        : undefined

      await createToolboxContainer(containerManager, {
        name: row.containerName,
        image: row.image,
        workspace: settings["container.workspace"],
        hostWorkspace: wsAbs,
        cpus: row.cpus,
        memoryMb: row.memoryMb,
        pidsLimit: row.pidsLimit,
        tmpfsSize: settings["container.tmpfsSize"],
        networkMode: get(settings, "container.networkMode"),
        ...(row.scopeType === "event"
          ? schedulerSdkContainerOpts(row.eventId, dataDir)
          : solverSdkContainerOpts(row.eventId)),
      })

      const modelDisplay = modelResolver.resolveModelDisplay(row.model)
      const environment: EnvironmentConfig = {
        type: "container",
        image: row.image,
        cpus: row.cpus,
        memoryMb: row.memoryMb,
        pidsLimit: row.pidsLimit,
      }
      const model = {
        provider: modelDisplay.provider,
        modelId: modelDisplay.modelId,
        modelLabel: modelDisplay.modelName,
        thinkingLevel: modelDisplay.thinkingLevel,
      }
      // Scope-aware prompt context: challenge runs render the challenge block;
      // scheduler (event-scope) runs render the event + instruction block.
      let promptContext: PromptContext
      if (row.scopeType === "challenge") {
        const challenge = row.challengeId
          ? db
              .select()
              .from(challenges)
              .where(eq(challenges.id, row.challengeId))
              .get()
          : undefined
        if (!challenge) {
          throw new RunActionError(
            "not_found",
            "Challenge not found for restore"
          )
        }
        // multiSolver derives from the persisted solver rows.
        const solverCount = queries
          .listAgents(runId)
          .filter((agent) => agent.role === "solver").length
        promptContext = buildPromptContext(
          {
            runId,
            challenge,
            remote: getChallengeRemote(db, challenge.id),
            challengeAttachments: [],
            environment,
            model,
            multiSolver: solverCount > 1,
          },
          db,
          settings["container.workspace"]
        )
      } else {
        promptContext = buildEventPromptContext(
          {
            runId,
            eventId: row.eventId,
            instruction: deps.getSchedulerConfig(row.eventId).instruction,
            environment,
            model,
          },
          db,
          settings["container.workspace"]
        )
      }

      // Channel backfill for pre-channels (v≤15) runs: the tree is ensured
      // idempotently — a legacy challenge run cold-restored gets the
      // challenge's #team/#announce (v17: created if absent) + a DM per
      // persisted agent so the first post does not 404. Event runs keep
      // their scheduler DM (attached below).
      if (row.scopeType === "challenge") {
        channels.ensureChallengeChannels(runId)
        for (const agent of queries.listAgents(runId)) {
          channels.ensureAgentDm(runId, agent.id)
        }
      }

      // Run-level live context + (event scope) the built-in wake-up — the
      // same shared tail as create(). Agent rows are NOT touched.
      const orchestrator =
        row.scopeType === "event"
          ? queries.listAgents(runId).find((agent) => agent.isEntry)
          : undefined
      await buildRunContext({
        runId,
        scope: row.scopeType === "event" ? "event" : "challenge",
        eventId: row.eventId,
        challengeId: row.challengeId,
        containerName: row.containerName,
        containerWorkspace: settings["container.workspace"],
        wsAbs,
        modelRuntime,
        sdkModel,
        defaultModelRef: row.model,
        thinkingLevel: modelDisplay.thinkingLevel,
        promptContext,
        orchestratorAgentId: orchestrator?.id,
      })
      deps.armRunTimers(runId, row.deadlineAt)
      // The run is live again — notify the event's scheduler so it does not
      // keep deciding on the stale closed state.
      deps.emitRunEvent(runId, { type: "run.resumed", runId })
    } catch (error) {
      // Restore failed after reserving the slot: release it so the fence and
      // run state stay consistent, then surface the error.
      contexts.delete(runId)
      updateRun(runId, { status: "closed", updatedAt: now() })
      if (error instanceof RunActionError) throw error
      throw new RunActionError(
        "launch_failed",
        error instanceof Error ? error.message : String(error)
      )
    }
  }

  /** Per-run cold-restore single-flight: concurrent prepareAgent calls for the
   * same closed run share ONE restore promise, so a second restore never tears
   * down the container the first just built (createToolboxContainer removes
   * the same-named container first). The winner's promise is awaited by all
   * callers; on failure every caller gets the error (restoreRunContext's catch
   * reverts the run to closed). */
  const restoring = new Map<string, Promise<void>>()

  function restoreRunContextOnce(
    runId: string,
    row: typeof runs.$inferSelect
  ): Promise<void> {
    const existing = restoring.get(runId)
    if (existing) return existing
    const promise = restoreRunContext(runId, row).finally(() => {
      if (restoring.get(runId) === promise) restoring.delete(runId)
    })
    restoring.set(runId, promise)
    return promise
  }

  /** Add one more solver to an existing challenge run: slot =
   * max solver index + 1, first turn rendered with the same SolverSpec
   * semantics as create (override = the raw prompt). A closed run is
   * cold-restored first (fence inside restoreRunContextOnce) WITHOUT waking
   * the old solvers — only the new agent is prepared + primed (the same
   * "restore touches only the triggered agent" semantics as messaging a
   * closed run). run.model / the entry agent never change. */
  async function addAgent(
    runId: string,
    spec: {
      model?: string
      prompt: string
      promptMode?: "strategy" | "override"
    }
  ): Promise<RunPublic> {
    const row = queries.getRow(runId)
    if (!row) throw new RunActionError("not_found", "Run not found")
    if (row.scopeType !== "challenge") {
      throw new RunActionError(
        "invalid_state",
        "Only challenge runs can gain solvers"
      )
    }
    // Slot numbering + the cap over the persisted solver rows.
    const solverIndexes = db
      .select({ slot: agents.slot })
      .from(agents)
      .where(and(eq(agents.runId, runId), eq(agents.role, "solver")))
      .all()
      .map(({ slot }) => Number(/^solver-(\d+)$/.exec(slot)?.[1] ?? 0))
    const maxIndex = solverIndexes.reduce((max, n) => Math.max(max, n), 0)
    if (solverIndexes.length >= MAX_SOLVERS_PER_RUN) {
      throw new RunActionError(
        "invalid_state",
        `A run supports at most ${MAX_SOLVERS_PER_RUN} solvers`
      )
    }
    // Closed → cold-restore the run context (fence + container rebuild);
    // running/idle continue on the live context. No old agent is prepared.
    if (row.status === "closed") {
      await restoreRunContextOnce(runId, row)
    }
    const context = contexts.get(runId)
    if (!context) {
      throw new RunActionError("invalid_state", "Run context is not live")
    }
    // The expansion baseline model is the run's stored ref (solver-1's)
    // unless the spec overrides it.
    const slotModel = modelResolver.resolveSlotModelFromRef(
      spec.model ?? row.model
    )
    const templateMap = loadTemplateMap(db)
    const tools = SOLVER_TOOLS(
      context.promptContext.run?.targetSupported ?? false
    )
    const index = maxIndex + 1
    const systemPrompt = renderTemplate(templateMap, "mainSystem", {
      ...context.promptContext,
      // The new solver always has teammates → render the co-solver section
      // regardless of what the (possibly stale) run context captured.
      run: { ...context.promptContext.run!, multiSolver: true },
      agent: {
        role: "solver",
        isMain: false,
        name: `Solver ${index}`,
        task: null,
        isEntry: false,
      },
      capabilities: deriveCapabilities(tools),
      model: {
        provider: slotModel.providerLabel,
        name: slotModel.modelLabel,
        id: slotModel.modelId,
      },
    })
    const agentId = insertAgentRow({
      runId,
      slot: `solver-${index}`,
      role: "solver",
      name: `Solver ${index}`,
      isEntry: false,
      model: slotModel.ref,
      systemPrompt,
      tools,
    })
    // New solver → new DM channel (§2.1, add_agent 增建)。
    channels.ensureAgentDm(runId, agentId)
    emitAgents(runId)
    await prepareAgent(runId, agentId)
    // No run-level strategy is persisted — the spec's prompt is the whole
    // Strategy input for the newcomer.
    await lifecycle.send(
      agentId,
      solverInitial(templateMap, context.promptContext, undefined, spec)
    )
    // Onboarding deliver (v17 §11.3, same as createSolvers): sweep the
    // challenge's group-channel history into the newcomer's first turn.
    channels.deliver(agentId)
    return requireRun(runId)
  }

  /** Prepare one agent's environment: container online (via the run context,
   * built lazily on cold-restore) + this agent's session online. Unified for
   * fresh create (no sessionFile → new session) and cold-restore (sessionFile →
   * open from snapshot). Idempotent; sends nothing. */
  async function prepareAgent(runId: string, agentId: string): Promise<void> {
    if (lifecycle.has(agentId)) return
    const row = queries.getRow(runId)
    if (!row) throw new RunActionError("not_found", "Run not found")
    const agentRow = db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .get()
    if (!agentRow) throw new RunActionError("not_found", "Agent not found")

    // Ensure the run-level context (container + model runtime + setup) exists.
    // Fresh create sets it before prepareAgent; cold-restore builds it here —
    // single-flighted per run so concurrent wakes share one restore.
    if (!contexts.has(runId)) {
      await restoreRunContextOnce(runId, row)
    }
    const ctx = contexts.get(runId)!

    // Resolve this agent's model from its own snapshot ref (per-agent; survives
    // switches). Cold-restore reuses the snapshot verbatim — no re-render.
    const agentTarget = modelResolver.resolveModelTarget(agentRow.model)
    if (!agentTarget) {
      throw new RunStartError("Could not resolve the agent's model for restore")
    }
    const sdkModel = resolveRunModel(
      ctx.modelRuntime,
      agentTarget.provider,
      agentTarget.model.id
    )
    if (!sdkModel) {
      throw new RunStartError("Could not resolve the agent's model for restore")
    }

    const snapshotTools = safeParseTools(agentRow.tools)
    const toolCtx = buildAgentToolContext(runId, ctx.challengeId, agentId)
    // Scheduler tools are gated by the CURRENT ORCHESTRATOR_TOOLS (empty post-
    // SDK-convergence): a legacy agent row whose snapshot still lists the old
    // 18 management names gets the intersection — i.e. no management tools.
    const schedulerTools = snapshotTools.filter((name) =>
      ORCHESTRATOR_TOOLS.includes(name)
    )
    const nativeTools = [
      ...createMainTools(toolCtx, snapshotTools),
      // Scheduler tools are granted only to the event-scope orchestrator;
      // challenge agents never carry their names. Gating here skips the
      // scheduler-tool context (a DB lookup + closures) for every solver.
      ...(row.scopeType === "event"
        ? createSchedulerTools(
            deps.buildSchedulerToolContext(runId, agentId),
            schedulerTools
          )
        : []),
    ]

    let agentSession: HostAgentSession
    try {
      agentSession = await createHost({
        owner: { agentId, runId },
        channel: runId,
        agentId,
        cwd: ctx.containerWorkspace,
        containerName: ctx.containerName,
        containerManager,
        modelRuntime: ctx.modelRuntime,
        model: sdkModel,
        thinkingLevel: agentTarget.thinkingLevel,
        agentSettings: agentSettings(),
        systemPrompt: agentRow.systemPrompt,
        extraTools: nativeTools,
        extraToolNames: snapshotTools,
        // Per-agent identity for the container-side `aegisx` SDK: one run's N
        // solvers share a container, so identity cannot be container-wide env
        // — it rides the per-exec env of the bash tool (docs/im-channels.md
        // §四; accepted boundary: same-run solvers share the workspace and
        // /proc/*/environ anyway).
        execEnv: [`AEGISX_AGENT_ID=${agentId}`, `AEGISX_RUN_ID=${runId}`],
        ...(agentRow.sessionFile
          ? {
              resumeFrom: {
                sessionId: agentRow.sessionFile,
                isJsonl: agentRow.sessionFile.endsWith(".jsonl"),
                sessionsDir: ctx.sessionsDir,
              },
            }
          : {}),
        onUsageMaybeChanged: () => emitRun(runId),
        db,
        bus,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      deps.clearForceKill(runId)
      deps.terminateContainer(runId, ctx.containerName)
      throw new RunActionError("launch_failed", message)
    }

    updateAgent(agentId, {
      sessionFile: agentSession.sessionId ?? null,
      toolDefinitions: snapshotActiveToolDefinitions(agentSession.session),
    })
    lifecycle.set(agentId, agentSession)
  }

  async function recoverOnBoot() {
    const rows = db.select().from(runs).all()
    for (const row of rows) {
      if (row.status === "closed") continue
      // running/idle held live resources that are gone after a crash. Reclaim
      // any orphan container; mark the run closed + its agents idle.
      await containerManager.remove(row.containerName).catch(() => undefined)
      const ts = now()
      // Reset finishing on the closed transition: a crash may have left the
      // flag set between finish_run's atomic claim and its teardown — without
      // this the cold-restored run would stay permanently un-finishable (the
      // finish_run claim WHERE finishing=0 would never match again).
      updateRun(row.id, {
        status: "closed",
        finishing: false,
        updatedAt: ts,
      })
      for (const agent of queries.listAgents(row.id)) {
        updateAgent(agent.id, { status: "idle", updatedAt: ts })
      }
      // Crash-recovery fix: the item stayed `running` forever because boot
      // recovery never tears down (no markDone). Reset it to pending so a
      // future resume re-launches it (the old closed run stays in history).
      if (row.queueItemId) {
        db.update(runQueue)
          .set({ status: "pending", runId: null, updatedAt: ts })
          .where(
            and(
              eq(runQueue.id, row.queueItemId),
              eq(runQueue.status, "running")
            )
          )
          .run()
      }
    }
    // Boot leaves every queue paused: events with visible items (pending /
    // running / failed) get queue_state='paused' and nothing drains until the
    // user resumes. No scheduleDrain here — boot never auto-drains.
    const ts = now()
    const pausedEvents = db
      .select({ eventId: runQueue.eventId })
      .from(runQueue)
      .where(inArray(runQueue.status, ["pending", "running", "failed"]))
      .groupBy(runQueue.eventId)
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
    create,
    addAgent,
    buildRunContext,
    restoreRunContext,
    restoreRunContextOnce,
    prepareAgent,
    recoverOnBoot,
    buildAgentToolContext,
    lastAssistantText,
    eventScopeFor,
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
 * the timeline 工具定义 panel. getAllTools returns every registered tool;
 * filtering by getActiveToolNames keeps the always-on file tools and drops
 * inactive/override duplicates. TypeBox parameters serialize to JSON Schema
 * (symbol-keyed metadata is dropped by JSON.stringify). Defensive: → "[]". */
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
