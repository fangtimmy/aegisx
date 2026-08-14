import { mkdirSync } from "node:fs"
import { relative } from "node:path"

import type {
  EnvironmentConfig,
  FlatSettings,
  ModelRef,
  RunPublic,
} from "@aegisx/shared"
import { formatModelRef, get } from "@aegisx/shared"
import type { ProviderConnection } from "@aegisx/shared/domain"
import type { ThinkingLevel } from "@aegisx/shared/live-event"
import type { Api, Model } from "@earendil-works/pi-ai"
import { and, eq } from "drizzle-orm"

import { createAgentHost } from "../agents/host"
import type {
  AgentLoopSettings,
  HostAgentSession,
} from "../agents/host-session"
import type { SessionLifecycle } from "../agents/lifecycle"
import type { LiveBus } from "../agents/live"
import type { Database } from "../db"
import { agents, challengeFlags, challenges, events, runs } from "../db/schema"
import type { ConfigStore } from "../infrastructure/config-store"
import {
  loadTemplateMap,
  renderTemplate,
} from "../orchestration/prompt-templates"
import {
  challengeOrchestrationCatalog,
  requirePlugin,
} from "../orchestration/registry"
import {
  createRunHandle,
  EventScopeEmitter,
  type FreshAgentInput,
  RunEmitter,
  type RunHandleHost,
} from "../orchestration/run-handle"
import type {
  EventHandle,
  EventScopePayload,
  OrchestrationPlugin,
  PromptContext,
} from "../orchestration/types"
import { getChallengeRemote } from "../platforms/challenge-state"
import type { createPlatformService } from "../platforms/service"
import type { ChildAgentRuntime } from "./child-agents"
import type { ContainerManager } from "./container/container-manager"
import { createToolboxContainer } from "./container/container-manager"
import { RunActionError, RunStartError } from "./errors"
import { checkLaunchFence } from "./fence"
import type { ModelResolver } from "./model-resolver"
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
import type { QueueService } from "./queue"
import type { RunSchedulerToolContext } from "./scheduler-tools"
import { createSchedulerTools } from "./scheduler-tools"
import { createMainTools, type RunToolContext } from "./tools"

type PlatformService = ReturnType<typeof createPlatformService>

/** Reusable per-run handles for spawn children (model runtime, container, the
 * child prompt template). Declared agents carry their own snapshot. */
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
  childTemplate: string
  promptContext: PromptContext
  challengeId: string
}

export type CreateRunInput = {
  /** Orchestration plugin id (challenge runs default to 'classic'). */
  orchestration?: string
  /** Per-slot model overrides (highest precedence), keyed by slot id. Used by
   * the scheduler to apply a per-event model override on top of the global
   * orchestration setting. */
  slotModelOverrides?: Record<string, ModelRef>
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
  /** Overrides the rendered `initial` template as the run's first prompt. Set
   * by the queue (queue.prompt) or the scheduler's start_run; omitted → render
   * the default `initial` template. */
  initialPromptOverride?: string
} & (
  | { scopeType: "challenge"; challengeId: string }
  | { scopeType: "event"; eventId: string; instruction: string }
)

export type RunFactoryDeps = {
  db: Database
  dataDir: string
  containerManager: ContainerManager
  platformService: PlatformService
  configStore: ConfigStore
  providers(): ProviderConnection[]
  modelResolver: ModelResolver
  queries: RunQueries
  bus: LiveBus
  /** Reusable per-run handles (entry snapshot lives on the agent row). */
  contexts: Map<string, RunContext>
  /** Per-run plugin event emitters; close clears, setup rebuilds. */
  emitters: Map<string, RunEmitter>
  /** Per-event run-lifecycle emitters, owned by the event's scheduler run. */
  eventScopes: Map<string, EventScopeEmitter>
  /** Live spawn-child sessions, keyed by child agent id. */
  childSessions: Map<string, HostAgentSession>
  /** Finish winner per agent: the agent whose atomic finishing UPDATE hit. */
  pendingFinish: Map<string, { summary: string; runId: string }>
  /** Runs finish_run already warned about a missing flag (once per run). */
  finishFlagWarned: Set<string>
  lifecycle: SessionLifecycle
  childRuntime: ChildAgentRuntime
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
  /** Scheduler task queue (assigned after construction; read via getter). */
  queue: () => QueueService | undefined
}

export type RunFactory = ReturnType<typeof createRunFactory>

/** Fresh-create + cold-restore orchestration: the run's model/container/prompt
 * context, the plugin-facing handle + wiring, per-agent session preparation,
 * and boot recovery. The shared create/restore tail guarantees a restored run
 * runs the same setup code as a fresh one. */
export function createRunFactory(deps: RunFactoryDeps) {
  const {
    db,
    dataDir,
    containerManager,
    platformService,
    configStore,
    providers,
    modelResolver,
    queries,
    bus,
    contexts,
    emitters,
    eventScopes,
    childSessions,
    pendingFinish,
    finishFlagWarned,
    lifecycle,
    childRuntime,
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

  /** The EventHandle for an event's scheduler run: subscribes to the per-event
   * run-lifecycle emitter (created lazily). */
  function eventHandleFor(eventId: string): EventHandle {
    let emitter = eventScopes.get(eventId)
    if (!emitter) {
      emitter = new EventScopeEmitter()
      eventScopes.set(eventId, emitter)
    }
    return {
      on: (event, cb) => emitter!.on(event, cb),
    }
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

  /** Build the per-agent native tool context. Peer tools resolve within this
   * run only; message_agent refuses spawn children (they run unattended to
   * completion). */
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
          .submitFlag(runId, challengeId, flag, verifyRemote)
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
      spawnChild: (childInput) =>
        childRuntime.spawn(runId, agentId, childInput),
      messageAgent: async (targetId, text) => {
        const target = queries.listAgents(runId).find((a) => a.id === targetId)
        if (!target) return { ok: false, error: "Agent not found in this run" }
        if (target.parentAgentId) {
          return {
            ok: false,
            error: "Child agents run unattended and cannot receive messages",
          }
        }
        await lifecycle.send(targetId, text)
        return { ok: true }
      },
      getAgent: (id) => queries.listAgents(runId).find((a) => a.id === id),
      listAgents: () => queries.listAgents(runId),
      lastAssistantText: (id) => lastAssistantText(runId, id),
    }
  }

  /** Run a plugin's event wiring with scope narrowing (discriminated union on
   * scope): challenge → wire(run); event → wire(run, event) with an EventHandle
   * wired to the event's run-lifecycle emitter. Agent creation is automatic
   * (from the plugin's declared `agents`); this only fires the plugin's
   * optional triggers. */
  async function runSetup(
    plugin: OrchestrationPlugin,
    handle: ReturnType<typeof createRunHandle>,
    eventHandle?: EventHandle
  ): Promise<void> {
    if (plugin.scope === "challenge") {
      await plugin.wire?.(handle)
      return
    }
    if (!eventHandle) {
      throw new Error(
        `Event-scope plugin '${plugin.id}' requires an EventHandle`
      )
    }
    await plugin.wire?.(handle, eventHandle)
  }

  /** Build the {@link RunHandleHost} callback bundle the plugin-facing handle
   * delegates through. All callbacks are per-agentId: no run-level lock leaks.
   * Shared by create() (fresh) and restoreRunContext() (cold). */
  function buildHandleHost(opts: {
    runId: string
    scope: "challenge" | "event"
    plugin: OrchestrationPlugin
    ctx: PromptContext
    initialPrompt: string
    templateMap: Map<string, string>
    emitter: RunEmitter
    slotOverrides?: Record<string, ModelRef>
  }): RunHandleHost {
    const plugin = opts.plugin
    return {
      runId: opts.runId,
      scope: opts.scope,
      ctx: opts.ctx,
      initialPrompt: opts.initialPrompt,
      templateMap: opts.templateMap,
      emitter: opts.emitter,
      agents: plugin.agents,
      findAgentBySlot(slot) {
        return db
          .select()
          .from(agents)
          .where(and(eq(agents.runId, opts.runId), eq(agents.slot, slot)))
          .get()
      },
      createFreshAgent(input: FreshAgentInput) {
        const id = crypto.randomUUID()
        const ts = now()
        db.insert(agents)
          .values({
            id,
            runId: opts.runId,
            slot: input.slot,
            role: input.role,
            parentAgentId: input.parentAgentId ?? null,
            isEntry: input.isEntry,
            model: input.model,
            systemPrompt: input.systemPrompt,
            tools: JSON.stringify(input.tools),
            status: "idle",
            sessionFile: null,
            name: input.name,
            task: input.task ?? null,
            createdAt: ts,
            updatedAt: ts,
          })
          .run()
        return id
      },
      resolveSlotModel(slot) {
        const override = opts.slotOverrides?.[slot]
        return override
          ? modelResolver.resolveSlotModelFromRef(override)
          : modelResolver.resolveSlotModel(plugin.id, slot)
      },
      isAgentStreaming(agentId) {
        if (lifecycle.get(agentId)?.session.isStreaming) return true
        const child = childSessions.get(agentId)
        return !!child?.session.isStreaming
      },
      prepareAgent: (agentId) => prepareAgent(opts.runId, agentId),
      sendToAgent: (agentId, text, deliverAs) =>
        lifecycle.send(agentId, text, deliverAs),
      abortAgent: (agentId) => lifecycle.abort(agentId),
    }
  }

  /** Shared create/restore tail: persist the run-level context (container
   * refs, model, prompt template + child template), build the plugin-facing
   * handle and run its wiring. Returns the handle so fresh creates can reach
   * primeSpecs. The differences (fence/slot reservation, the container build,
   * priming, the initialPrompt override) stay in the callers. */
  async function buildRunContext(opts: {
    runId: string
    scope: "challenge" | "event"
    eventId: string
    challengeId: string | null
    orchestration: string
    containerName: string
    containerWorkspace: string
    wsAbs: string
    modelRuntime: RunModelRuntime
    sdkModel: Model<Api> | undefined
    defaultModelRef: ModelRef
    thinkingLevel: ThinkingLevel
    promptContext: PromptContext
    slotOverrides?: Record<string, ModelRef>
    initialPromptOverride?: string
  }): Promise<ReturnType<typeof createRunHandle>> {
    const plugin = requirePlugin(opts.orchestration)
    const templateMap = loadTemplateMap(db, plugin.id)
    const initialPrompt =
      opts.initialPromptOverride ??
      renderTemplate(templateMap, "initial", opts.promptContext)

    // Run-level live context: prepareAgent (prime) + spawn children reuse it.
    // The child prompt comes from the plugin's spawn template (plugin → builtin
    // resolution; default childSystem).
    contexts.set(opts.runId, {
      containerName: opts.containerName,
      workspaceHostPath: opts.wsAbs,
      containerWorkspace: opts.containerWorkspace,
      sessionsDir: sessionsAbs(opts.runId),
      modelRuntime: opts.modelRuntime,
      sdkModel: opts.sdkModel,
      defaultModelRef: opts.defaultModelRef,
      thinkingLevel: opts.thinkingLevel,
      childTemplate:
        templateMap.get(plugin.spawn?.systemPrompt ?? "childSystem") ?? "",
      promptContext: opts.promptContext,
      challengeId: opts.challengeId ?? "",
    })

    const emitter = new RunEmitter()
    emitters.set(opts.runId, emitter)

    const host = buildHandleHost({
      runId: opts.runId,
      scope: opts.scope,
      plugin,
      ctx: opts.promptContext,
      initialPrompt,
      templateMap,
      emitter,
      slotOverrides: opts.slotOverrides,
    })
    const handle = createRunHandle(host)
    await runSetup(
      plugin,
      handle,
      opts.scope === "event" ? eventHandleFor(opts.eventId) : undefined
    )
    return handle
  }

  async function create(input: CreateRunInput): Promise<RunPublic> {
    const plugin = requirePlugin(input.orchestration ?? "classic")
    if (plugin.scope !== input.scopeType) {
      throw new RunActionError(
        "invalid_state",
        `Plugin '${plugin.id}' is ${plugin.scope}-scoped, not ${input.scopeType}`
      )
    }

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

    // The run default model = the entry agent's configured model (the
    // conversation target the UI shows / switches; spawn children fall back to
    // it). Resolved from the orchestration settings, falling back to the global
    // default; snapshotted as a CONCRETE ref (aliases resolved away).
    const entrySlot =
      plugin.agents.find((agent) => agent.entry) ?? plugin.agents[0]
    if (!entrySlot) {
      throw new RunActionError(
        "invalid_state",
        `Plugin '${plugin.id}' declares no agents`
      )
    }
    const entryConfigured =
      input.slotModelOverrides?.[entrySlot.slot] ??
      configStore.getAgentModels()[plugin.id]?.[entrySlot.slot] ??
      modelResolver.defaultModelRef()
    const entryTarget = modelResolver.resolveModelTarget(entryConfigured)
    if (!entryTarget) {
      throw new RunActionError(
        "invalid_state",
        entryConfigured
          ? `Configured model "${entryConfigured}" is unavailable`
          : "No enabled default model is configured"
      )
    }
    if (!entryTarget.provider.apiKey) {
      throw new RunActionError("invalid_state", "Provider API key is required")
    }
    const entryModelRef = formatModelRef(
      entryTarget.provider,
      entryTarget.model,
      entryTarget.thinkingLevel
    )

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
              orchestrations: challengeOrchestrationCatalog(),
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
          orchestration: plugin.id,
          params: "{}",
          status: "running",
          model: entryModelRef,
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
      })
    } catch (error) {
      db.delete(runs).where(eq(runs.id, runId)).run()
      throw new RunActionError(
        "launch_failed",
        error instanceof Error ? error.message : String(error)
      )
    }

    // Run-level live context + plugin wiring: contexts.set + emitter + handle
    // + setup are the same code create and cold-restore run — see
    // buildRunContext. The run row + container exist before setup runs; agents
    // are declared by the plugin's setup.
    const handle = await buildRunContext({
      runId,
      scope: input.scopeType,
      eventId: input.scopeType === "challenge" ? challenge!.eventId : event!.id,
      challengeId: challenge?.id ?? null,
      orchestration: plugin.id,
      containerName: name,
      containerWorkspace: input.container.workspace,
      wsAbs,
      modelRuntime,
      sdkModel,
      defaultModelRef: entryModelRef,
      thinkingLevel: entryTarget.thinkingLevel,
      promptContext,
      slotOverrides: input.slotModelOverrides,
      initialPromptOverride: input.initialPromptOverride,
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      deps.teardownRun(runId)
      updateRun(runId, {
        error: `Plugin setup failed: ${message}`,
        updatedAt: now(),
      })
      throw new RunActionError("launch_failed", message)
    })

    // System auto-prime: for a fresh run, prepare()+send(prime) each prime
    // agent. classic primes the solver with run.initialPrompt.
    try {
      for (const spec of handle.primeSpecs) {
        await prepareAgent(runId, spec.agentId)
        await lifecycle.send(spec.agentId, spec.prime)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      for (const spec of handle.primeSpecs) {
        updateAgent(spec.agentId, {
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
   * model runtime + prompt context, then re-run the plugin's setup (create and
   * resume run the same code). createAgent reuses existing agent rows (slot
   * idempotent, snapshot priority) and on() re-wires triggers; prime is ignored
   * on restore. Does NOT create sessions — prepareAgent does, lazily per agent. */
  async function restoreRunContext(
    runId: string,
    row: typeof runs.$inferSelect
  ): Promise<void> {
    // Scheduler (event-scoped) runs cold-restore like challenge runs: a
    // message to a closed run's agent rebuilds the container + session and
    // re-runs the plugin wiring. A manual `start` remains a fresh (newSession)
    // replacement — create() deletes the closed row first.
    const settings = getSettings()

    // Cold-restoring a closed challenge run occupies a concurrency slot
    // (third fence enforcement point); scheduler runs do not count (same as
    // create). Reserve atomically: check the fence (challenge only) + flip the
    // run row to running so concurrent launches count it. Any later failure
    // reverts to closed (releasing the slot) below.
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
        promptContext = buildPromptContext(
          {
            runId,
            challenge,
            remote: getChallengeRemote(db, challenge.id),
            challengeAttachments: [],
            environment,
            model,
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
            orchestrations: challengeOrchestrationCatalog(),
          },
          db,
          settings["container.workspace"]
        )
      }

      // Run-level live context + plugin wiring — the same shared tail as
      // create(); primeSpecs are ignored on restore.
      await buildRunContext({
        runId,
        scope: row.scopeType === "event" ? "event" : "challenge",
        eventId: row.eventId,
        challengeId: row.challengeId,
        orchestration: row.orchestration,
        containerName: row.containerName,
        containerWorkspace: settings["container.workspace"],
        wsAbs,
        modelRuntime,
        sdkModel,
        defaultModelRef: row.model,
        thinkingLevel: modelDisplay.thinkingLevel,
        promptContext,
      })
      deps.armRunTimers(runId, row.deadlineAt)
      // The run is live again — notify the event's scheduler so it does not
      // keep deciding on the stale closed state.
      deps.emitRunEvent(runId, { type: "run.resumed", runId })
    } catch (error) {
      // Restore failed after reserving the slot: release it so the fence and
      // run state stay consistent, then surface the error.
      contexts.delete(runId)
      emitters.get(runId)?.close()
      emitters.delete(runId)
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
    const nativeTools = [
      ...createMainTools(toolCtx, snapshotTools),
      // Scheduler tools are granted only to the event-scope orchestrator;
      // challenge agents never carry their names. Gating here skips the
      // scheduler-tool context (a DB lookup + closures) for every solver.
      ...(row.scopeType === "event"
        ? createSchedulerTools(
            deps.buildSchedulerToolContext(runId, agentId),
            snapshotTools
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
    }
    // Boot closed every live run; pending queue items may now find capacity —
    // kick a drain (debounced, fires after recoverOnBoot returns).
    deps.queue()?.scheduleDrain()
  }

  return {
    create,
    runSetup,
    buildRunContext,
    buildHandleHost,
    restoreRunContext,
    restoreRunContextOnce,
    prepareAgent,
    recoverOnBoot,
    buildAgentToolContext,
    lastAssistantText,
    eventHandleFor,
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
