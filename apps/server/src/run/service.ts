import type {
  AgentDetail,
  AgentSummary,
  FleetInfo,
  Plan,
  SwitchModelInput,
  WorkspaceInfo,
} from "@aegisx/shared"
import { get, isActiveAgentStatus, LIVE_AGENT_STATUSES } from "@aegisx/shared"
import type { ProviderConnection } from "@aegisx/shared/domain"
import type { ToolDefinition } from "@earendil-works/pi-coding-agent"
import { and, eq, inArray } from "drizzle-orm"

import type { Database } from "../db"
import { agents, challenges } from "../db/schema"
import type { Principal } from "../infrastructure/agent-auth"
import type { ConfigStore } from "../infrastructure/config-store"
import { logEvent } from "../lib/log"
import {
  DEFAULT_SCHEDULER_DIGEST_TEMPLATE,
  NOTICE_TEMPLATE_DEFAULTS,
} from "../orchestration/prompt-defaults"
import {
  loadTemplateMap,
  renderTemplateBody,
  seedBuiltinTemplates,
} from "../orchestration/prompt-templates"
import type { createPlatformService } from "../platforms/service"
import { getProviderConnections } from "../providers/public"
import { createChannelService, type ChannelService } from "./channels"
import type { Clock } from "./clock"
import { systemClock } from "./clock"
import type { ContainerManager } from "./container/container-manager"
import {
  createDecisionPointEngine,
  type DecisionTimings,
} from "./decision-points/engine"
import {
  actorFromPrincipal,
  actorLabel,
  emitDomainEvent,
} from "./domain-events/store"
import { RunActionError } from "./errors"
import { checkSpawnFence } from "./fence"
import { createFlagHooks } from "./flag-hooks"
import { createFleetWatchdog } from "./fleet-watchdog"
import { createAgentHost } from "./host/host"
import type { AgentLoopSettings } from "./host/host-session"
import { createLiveBus } from "./host/live"
import { createAgentKernel, type SpawnAdmission } from "./kernel"
import {
  createAgentEventPoster,
  createLifecycleReactor,
} from "./lifecycle-reactor"
import { chainLock } from "./locks"
import { createModelResolver } from "./model-resolver"
import { createNoticePublisher } from "./orch-notices"
import { createPlanApplier } from "./plan/applier"
import { createSubmitPlanTool } from "./plan/tool"
import {
  assertMayTouchAgent,
  assertMayTouchChallenge,
  assertMayTouchEvent,
} from "./principal-scope"
import { parseAgentToolDefinitions, parseAgentTools } from "./public"
import { createAgentQueries } from "./queries"
import {
  createQueueService,
  parseSpawnQueueParams,
  type QueueService,
} from "./queue"
import { createSchedulerAdmin } from "./scheduler-admin"
import { createSchedulerDigest } from "./scheduler-digest"
import { schedulerPausedFor } from "./scheduler-policy"
import { createSpawnService } from "./spawn-service"
import { createWorkspaceFace } from "./workspace-face"
import {
  agentContainerName,
  challengeRoot,
  orchestratorContainerName,
  workspaceDir as workspaceDirOf,
} from "./workspace-resolver"

type PlatformService = ReturnType<typeof createPlatformService>

export type AgentServiceOptions = {
  db: Database
  dataDir: string
  containerManager: ContainerManager
  platformService: PlatformService
  configStore: ConfigStore
  /** Loopback origin of this server (computed from HOST/PORT) — exact-endpoint
   * gateway providers route their models.json baseUrl through the server's
   * /api/llm-relay route. */
  relayOrigin: string
  getSettings(): import("@aegisx/shared").FlatSettings
  /** Test seam: override the host-session creation (default = createAgentHost). */
  createHost?: typeof createAgentHost
  /** Test seam: grace between deadline-abort and a forced dispose. */
  timeoutGraceMs?: number
  /** Test seam: bound on `session.abort()` inside close paths (default 5s). */
  closeAbortGraceMs?: number
  /** Test seam: channel flush tick interval (default 5min). */
  flushIntervalMs?: number
  /** Test seam: solved write-up wrap-up bound (default 5min). */
  solvedWrapupMs?: number
  /** Test seam overrides for the decision-point engine's timings. */
  decisionTimings?: Partial<DecisionTimings>
  /** Time layer (default: the system clock) — every runtime timer (flush
   * tick, sweep, drainer, deadlines, watchdog, decision points) reads and
   * schedules through it; tests inject a fake clock for deterministic time. */
  clock?: Clock
  /** Unattended appliance mode (`AEGISX_UNATTENDED=1`): there is no human to
   * review a restart or resume a paused queue, so boot recovery must not pause
   * the event queues and the fleet watchdog must treat parked (idle) solvers
   * as no progress. Off by default — the interactive flow keeps its
   * review-before-refire gate. */
  unattended?: boolean
}

export type SendMessageInput = {
  text: string
  /** Only meaningful while the agent is streaming (steer/followUp). */
  deliverAs?: "steer" | "followUp"
}

export type AgentService = ReturnType<typeof createAgentService>

/**
 * The composition root (L4): constructs the L2 agent kernel, binds the
 * spawn-fence admission hook into its critical section, then assembles the
 * L3 control plane (channels → notices → decision engine → poster →
 * spawn-service → queue → lifecycle reactor → scheduler admin → plan
 * applier → flag hooks → fleet watchdog → workspace face) around it and
 * registers the reactor as the kernel's single L2→L3 channel. Everything
 * past this point is wiring and scope-asserting forwarding — no behavior
 * of its own.
 */
export function createAgentService(options: AgentServiceOptions) {
  const {
    db,
    dataDir,
    containerManager,
    platformService,
    configStore,
    relayOrigin,
  } = options
  const createHost = options.createHost ?? createAgentHost
  const getSettings = () => options.getSettings()
  const closeAbortGraceMs = options.closeAbortGraceMs ?? 5_000
  const clock = options.clock ?? systemClock
  const unattended = options.unattended ?? false
  let closed = false

  function providers(): ProviderConnection[] {
    return getProviderConnections(configStore)
  }

  const modelResolver = createModelResolver({
    getSettings,
    providers,
  })
  const queries = createAgentQueries({ db })
  const bus = createLiveBus()

  // Seed the built-in prompt templates (idempotent) so the service is
  // self-sufficient — any agent spawned here renders.
  seedBuiltinTemplates(db)
  // Idempotent guard: plugin-owned template rows (a pre-v9 concept) must
  // never come back — re-delete any who got re-seeded.
  db.run(`DELETE FROM prompt_templates WHERE plugin != 'builtin'`)

  /** Monotonic timestamp: never returns the same value twice, so agents
   * declared within one millisecond still get a strictly-ordered `createdAt`. */
  let lastNowMs = 0
  const now = () => {
    let ms = clock.now()
    if (ms <= lastNowMs) ms = lastNowMs + 1
    lastNowMs = ms
    return new Date(ms).toISOString()
  }

  function requireAgent(agentId: string): AgentSummary {
    const agent = queries.getAgent(agentId)
    if (!agent) throw new RunActionError("not_found", "Agent not found")
    return agent
  }

  /** Host root of a challenge's workspace tree (attachment copy target +
   * the reactor's recycle scope). */
  const challengeWorkspaceRoot = (eventId: string, challengeId: string) =>
    workspaceDirOf(challengeRoot(dataDir, eventId, challengeId))

  function agentSettings(): AgentLoopSettings {
    const s = getSettings()
    return {
      compaction: { enabled: get(s, "agent.compactionEnabled") },
      retry: {
        enabled: get(s, "agent.retryEnabled"),
        maxRetries: get(s, "agent.retryMaxRetries"),
      },
    }
  }

  // --- admission: the fence policy, bound into the kernel's spawn -----------
  //     critical section (the kernel knows the hook, never the fence).
  //
  /** Global fence lock: serializes fence check + slot reservation across all
   * spawns so the concurrency caps hold under interleaving. Holds only
   * the quick DB op (row insert); container builds and setup run outside.
   *
   * Lock order: every fence critical section (spawn) runs OUTSIDE any agent
   * lock — no fence section ever acquires an agent lock, so the order is
   * acyclic (no deadlock). */
  const fenceLocks = new Map<string, Promise<unknown>>()
  async function withFence<T>(op: () => T | Promise<T>): Promise<T> {
    return chainLock(fenceLocks, "global-fence", op)
  }

  const admission: SpawnAdmission = (candidate, insert) =>
    withFence(async () => {
      // Solvers only — the scheduler never counts (challengeId set).
      if (candidate.challengeId) {
        const decision = checkSpawnFence(db, getSettings(), {
          eventId: candidate.eventId,
          challengeId: candidate.challengeId,
        })
        if (!decision.ok) {
          // Every rejection leaves a trace (the decision log's raw material).
          emitDomainEvent(db, {
            type: "fence.blocked",
            eventId: candidate.eventId,
            challengeId: candidate.challengeId,
            actor: candidate.actor,
            payload: {
              code: decision.code,
              message: decision.message,
              via: "spawn",
            },
          })
          throw new RunActionError("capacity", decision.message)
        }
      }
      insert()
    })

  // --- L2: the agent kernel ---------------------------------------------------

  /** The scheduler's role-based native tools (B 批): the ONE management
   * write, the in-process submit_plan tool. Built per orchestrator session
   * (spawn AND reopen) from the L3 applier + engine; the closure reads the
   * consts declared further below — every call happens long after
   * assembly. */
  function orchestratorTools(row: {
    id: string
    eventId: string
  }): ToolDefinition[] {
    return [
      createSubmitPlanTool(
        {
          submitPlan: (eventId, plan, principal) =>
            planApplier.submitPlan(eventId, plan, principal),
          turnGenerationOf: (agentId) => kernel.turnGenerationOf(agentId),
          registerPlan: (registration) =>
            decisionEngine.registerPlan(registration),
        },
        { agentId: row.id, eventId: row.eventId }
      ),
    ]
  }

  const kernel = createAgentKernel({
    db,
    dataDir,
    containerManager,
    platform: platformService,
    providers,
    relayOrigin,
    configVersion: () => configStore.configVersion,
    modelResolver,
    queries,
    bus,
    getSettings,
    clock,
    now,
    closeAbortGraceMs,
    ...(options.timeoutGraceMs !== undefined
      ? { timeoutGraceMs: options.timeoutGraceMs }
      : {}),
    agentSettings,
    createHost,
    admission,
    orchestratorTools,
    unattended,
  })

  // --- L3: the control plane --------------------------------------------------

  const channels: ChannelService = createChannelService({
    db,
    dataDir,
    bus,
    // Deliveries push through the kernel's send verb (steer/followUp/fresh
    // turn/cold resume).
    send: (agentId, text, deliverAs, opts) =>
      kernel.send(agentId, text, deliverAs, opts),
    now,
    challengeWorkspaceRoot,
    clock,
    // Scheduler-directed content (solver asks, user posts on orch, user DMs
    // to the scheduler) opens a decision point — the delivery engine keeps
    // NO scheduler face (§3.6).
    onSchedulerInbox: (post) => {
      const preview = post.body.trim().slice(0, 120)
      if (post.kind === "dm") {
        decisionEngine.trigger(post.eventId, {
          kind: "user.directive",
          source: "dm",
          preview,
        })
      } else if (post.authorType === "user") {
        decisionEngine.trigger(post.eventId, {
          kind: "user.directive",
          source: "orch",
          preview,
        })
      } else {
        decisionEngine.trigger(post.eventId, {
          kind: "solver.asked",
          ...(post.authorAgentId ? { authorAgentId: post.authorAgentId } : {}),
          preview,
        })
      }
    },
    ...(options.flushIntervalMs !== undefined
      ? { flushIntervalMs: options.flushIntervalMs }
      : {}),
  })

  // System→agent notice bodies: the stored (user-editable) template row when
  // present, else the shipped default. Shared by the typed notice publisher,
  // the lifecycle poster and the decision payload renderer — a few local
  // rows read per message, no cache to invalidate.
  const noticeTemplateBody = (key: keyof typeof NOTICE_TEMPLATE_DEFAULTS) =>
    loadTemplateMap(db).get(key) ?? NOTICE_TEMPLATE_DEFAULTS[key]

  // Every system→scheduler/team notice is a typed event (run/orch-notices)
  // rendered through its (user-editable) template.
  const notices = createNoticePublisher({
    templateBody: noticeTemplateBody,
    post: (input, principal) => channels.post(input, principal),
    isSchedulerPaused: (eventId) => schedulerPausedFor(db, eventId),
  })

  // The fleet digest (scheduler-digest) — the decision-point payload's
  // [调度快照] block, rendered per open against the current DB state.
  const schedulerDigest = createSchedulerDigest({ db, getSettings, now })

  // The decision-point engine (§3.6): the ONE deterministic wake path for
  // every scheduler.
  const decisionEngine = createDecisionPointEngine({
    db,
    clock,
    now,
    send: (agentId, text) => kernel.send(agentId, text),
    digestOf: (eventId) => {
      try {
        const context = schedulerDigest.getDigestContext(eventId)
        const body =
          loadTemplateMap(db).get("schedulerDigest") ??
          DEFAULT_SCHEDULER_DIGEST_TEMPLATE
        return {
          digest: renderTemplateBody(body, context),
          // Wall-clock-independent fingerprint for the periodic skip: the
          // fleet's structural state (clock/elapsed/last-flag ages excluded —
          // they always change; token burn excluded — a working fleet needs
          // no nudge).
          fingerprint: JSON.stringify({
            agents: context.agents,
            targets: context.targets,
            queue: context.queue,
            board: context.board,
            challenges: context.challenges.map((c) => [
              c.name,
              c.earned,
              c.flagProgress,
              c.solvedLabel,
              c.live,
              c.running,
              c.pending,
              c.attempts,
            ]),
          }),
        }
      } catch {
        return { digest: "", fingerprint: "" }
      }
    },
    isSchedulerPaused: (eventId) => schedulerPausedFor(db, eventId),
    // Both escalation alarms land on the same urgent orch channel — the
    // unattended appliance's pager.
    escalateNotice: (eventId, escalation) =>
      notices.publish(
        escalation.reason === "scheduler_violation"
          ? {
              type: "schedulerViolation",
              eventId,
              decisionPointId: escalation.decisionPointId,
              consecutive: escalation.consecutive,
            }
          : {
              type: "schedulerStalled",
              eventId,
              decisionPointId: escalation.decisionPointId,
              stalledMs: escalation.stalledMs,
            }
      ),
    ...(options.decisionTimings ? { timings: options.decisionTimings } : {}),
  })

  // The agent-lifecycle poster (the orch event lines) — consumed by the
  // reactor, the spawn-service (started) and the flag hooks (flagAccepted).
  const poster = createAgentEventPoster({
    db,
    queries,
    channels,
    isSchedulerPaused: (eventId) => schedulerPausedFor(db, eventId),
    templateBody: noticeTemplateBody,
  })

  // The L3 launch entry — queue drainer and user routes spawn through it.
  const spawnService = createSpawnService({
    db,
    kernel,
    channels,
    poster,
  })

  // The queue's drainer launches one agent per item from the item's snapshot.
  const queue: QueueService = createQueueService({
    db,
    getSettings,
    isDisposed: () => closed,
    clock,
    launch: (item) => {
      const params = parseSpawnQueueParams(item.params)
      return spawnService.launch({
        eventId: item.eventId,
        challengeId: item.challengeId,
        role: "solver",
        model: params.model,
        prompt: item.prompt || undefined,
        promptMode: params.promptMode,
        timeoutMs: item.timeoutMs ?? undefined,
        source: item.source,
        queueItemId: item.id,
        actor: { kind: "system", actorId: "drainer" },
      })
    },
    // The launch lost the cancel race (full-solve cleanup cancelled the item
    // mid-launch): settle the just-spawned agent with the timeout-path
    // semantics — no abort (the turn may be mid-flight), dispose and land
    // aborted (the sandbox goes with the settle's destroy step).
    onSupersededLaunch: (agentId) => {
      void kernel.settle(agentId, {
        abort: false,
        status: "aborted",
        by: { kind: "system", actorId: "drainer" },
      })
    },
    onQueueEmergency: (event) => {
      notices.publish(event)
      // The launch failure is an URGENT decision-point trigger (§3.6) —
      // the notice is the ledger line, the trigger is the wake.
      if (event.type === "launchFailed") {
        decisionEngine.trigger(event.eventId, {
          kind: "launch.failed",
          challengeName: event.challengeName,
          error: event.error,
        })
      }
    },
    onQueueNotice: (event) => {
      notices.publish(event)
      // Pause/resume are queue.changed triggers; the engine's own gate
      // drops the paused half (a paused queue stays silent until resume).
      if (event.type === "queueStateChanged") {
        decisionEngine.trigger(event.eventId, {
          kind: "queue.changed",
          reason: event.action === "paused" ? "paused" : "resumed",
        })
      }
    },
    // Queue growth and the low-water edge feed the engine (§3.6) — the old
    // starved-edge mechanism, collapsed into a coalesced trigger.
    onQueueChanged: (eventId, change) => {
      decisionEngine.trigger(eventId, { kind: "queue.changed", ...change })
    },
  })

  // The lifecycle reactor — the kernel's outbound L3 reactions. The callback
  // order inside is kernel contract (bus.forget → markDone → scheduleDrain →
  // onAgentTerminal → notice).
  kernel.registerLifecycle(
    createLifecycleReactor({
      db,
      queries,
      queue,
      engine: decisionEngine,
      poster,
      platformService,
      challengeWorkspaceRoot,
    })
  )

  // Scheduler policy + status reads and the scheduler-agent lifecycle face.
  const schedulerAdmin = createSchedulerAdmin({
    db,
    queries,
    getSettings,
    now,
    providers,
    modelResolver,
    kernel,
    spawnService,
    engine: decisionEngine,
    queue,
    notices,
    digest: schedulerDigest,
    platformService,
    deleteAgent: (agentId) => deleteAgent(agentId, { kind: "system" }),
  })

  // The scheduler's typed-plan surface: validates + proposes + applies fast
  // actions inline, defers slow ones on the per-event chain (run/plan).
  const planApplier = createPlanApplier({
    db,
    clock,
    modelResolver,
    queue,
    stopAgentBounded,
    closeAgent,
    finishAgent,
    sendMessage,
    setAgentTimeout,
    now,
  })

  // Flag hooks (L3): the control plane's reaction to platform facts.
  const flagHooks = createFlagHooks({
    db,
    queries,
    clock,
    now,
    ...(options.solvedWrapupMs !== undefined
      ? { solvedWrapupMs: options.solvedWrapupMs }
      : {}),
    engine: decisionEngine,
    notices,
    queue,
    poster,
    platformService,
    closeAgent: (agentId, by) => kernel.closeAgent(agentId, by),
    armDeadline: (agentId, deadlineAt) =>
      kernel.armDeadline(agentId, deadlineAt),
  })

  // Event-level vital signs: pending work with no live solver and no drain
  // progress → ONE escalation per episode (watchdog.escalated fact + the
  // urgent eventStalled notice + a fleet.stalled decision point). The wake
  // duty belongs to the engine; the watchdog is the stuck-machinery alarm.
  const fleetWatchdog = createFleetWatchdog({
    db,
    clock,
    unattended,
    isSchedulerPaused: (eventId) => schedulerAdmin.isSchedulerPaused(eventId),
    onStalled: (stall) => {
      logEvent("fleet", "event_stalled", { ...stall })
      emitDomainEvent(db, {
        type: "watchdog.escalated",
        eventId: stall.eventId,
        actor: { kind: "system", actorId: "fleet-watchdog" },
        payload: {
          reason: "fleet_stalled",
          detail: { pending: stall.pending, stalledMs: stall.stalledMs },
          at: now(),
        },
      })
      notices.publish({ type: "eventStalled", ...stall })
      decisionEngine.trigger(stall.eventId, {
        kind: "fleet.stalled",
        pending: stall.pending,
        stalledMs: stall.stalledMs,
      })
    },
  })
  fleetWatchdog.start()

  // The workspace file face (L4): trees as files + deletion sweeps.
  const workspaceFace = createWorkspaceFace({
    db,
    dataDir,
    containerManager,
    kernel,
  })

  // --- scope-asserting public verbs ------------------------------------------
  // Thin forwarders onto the kernel / L3 modules. Scope assertions are the
  // facade's job (the layers beneath take actors, not principals).

  /** Spawn one solver agent (the direct path — fence full → capacity
   * error). The queue's drainer goes through the same spawn-service. */
  async function spawn(
    input: {
      eventId: string
      challengeId: string
      model?: string
      prompt?: string
      promptMode?: "strategy" | "override"
      timeoutMs?: number
      source?: "manual" | "scheduler"
    },
    principal: Principal
  ): Promise<AgentSummary> {
    assertMayTouchChallenge(db, principal, input.challengeId)
    const agentId = await spawnService.launch({
      eventId: input.eventId,
      challengeId: input.challengeId,
      role: "solver",
      model: input.model,
      prompt: input.prompt,
      promptMode: input.promptMode,
      timeoutMs: input.timeoutMs,
      source: input.source ?? "manual",
      actor: actorFromPrincipal(principal),
    })
    return requireAgent(agentId)
  }

  /** Per-agent stop: abort the current turn; it settles to idle (the
   * sandbox stays warm). */
  async function stopAgent(
    agentId: string,
    principal: Principal
  ): Promise<AgentSummary> {
    assertMayTouchAgent(principal, requireAgent(agentId))
    await kernel.abort(agentId)
    return requireAgent(agentId)
  }

  /** Plan-path stop (run/plan): pi's abort does not interrupt an in-flight
   * tool call, so the abort wait is BOUNDED — on expiry the agent force-
   * disposes through the standard settle path (the close semantics), never
   * hanging the plan application chain. */
  async function stopAgentBounded(
    agentId: string,
    principal: Principal
  ): Promise<void> {
    return kernel.stopBounded(agentId, actorFromPrincipal(principal))
  }

  /** Terminal close (user/scheduler): abort + dispose the session, land
   * aborted. Files and the DB session survive (reopen on demand). */
  async function closeAgent(
    agentId: string,
    principal: Principal
  ): Promise<AgentSummary> {
    assertMayTouchAgent(principal, requireAgent(agentId))
    await kernel.closeAgent(agentId, actorFromPrincipal(principal))
    return requireAgent(agentId)
  }

  /** Force-finish (HTTP /finish): the sanctioned terminal transition with a
   * summary. Idempotent on an already-completed agent. `actor` labels who
   * called it (user vs the event's scheduler) on the finished event. */
  async function finishAgent(
    agentId: string,
    summary: string,
    actor: "user" | "scheduler",
    principal: Principal
  ): Promise<AgentSummary> {
    assertMayTouchAgent(principal, requireAgent(agentId))
    return kernel.finishAgent(
      agentId,
      summary,
      actor,
      actorFromPrincipal(principal)
    )
  }

  /** Per-agent message — a DIRECT runtime send (no channel row, no double
   * bookkeeping). Three-state semantics: streaming → steer at turn end,
   * idle → fresh turn, terminal → onResume reopen. */
  async function sendMessage(
    agentId: string,
    input: SendMessageInput,
    principal: Principal
  ): Promise<AgentSummary> {
    assertMayTouchAgent(principal, requireAgent(agentId))
    await kernel.send(agentId, input.text, input.deliverAs)
    return requireAgent(agentId)
  }

  /** Per-agent model switch: takes effect next turn; persists the snapshot
   * on the agent row. Serialized on the agent's lock against its turns. */
  async function switchAgentModel(
    agentId: string,
    input: SwitchModelInput,
    principal: Principal
  ): Promise<AgentSummary> {
    assertMayTouchAgent(principal, requireAgent(agentId))
    return kernel.switchModel(
      agentId,
      input.model,
      actorFromPrincipal(principal)
    )
  }

  /** Replace an agent's steer/followUp queue. Serialized against its turns;
   * uses the SDK queue API directly. */
  async function setQueue(
    agentId: string,
    input: { steering: string[]; followUp: string[] },
    principal: Principal
  ): Promise<void> {
    assertMayTouchAgent(principal, requireAgent(agentId))
    return kernel.setQueue(agentId, input)
  }

  /** Manually compact an agent's context (pi SDK `session.compact()`). */
  async function compactAgent(
    agentId: string,
    principal: Principal
  ): Promise<AgentSummary> {
    assertMayTouchAgent(principal, requireAgent(agentId))
    await kernel.compactAgent(agentId)
    return requireAgent(agentId)
  }

  /** Set / extend / shorten an agent's hard deadline; re-arms the live
   * timer. Usable on terminal agents (pre-sets the next reopen). */
  function setAgentTimeout(
    agentId: string,
    timeoutMs: number,
    principal: Principal
  ): AgentSummary {
    assertMayTouchAgent(principal, requireAgent(agentId))
    const agent = schedulerAdmin.setAgentTimeout(
      agentId,
      timeoutMs,
      actorFromPrincipal(principal)
    )
    const row = queries.getAgentRow(agentId)
    if (row && isActiveAgentStatus(row.status)) {
      kernel.armDeadline(agentId, row.deadlineAt)
    }
    kernel.emitAgent(agentId)
    return agent
  }

  /** Full agent detail (the AgentDialog view). */
  async function getAgentDetail(
    agentId: string,
    principal: Principal
  ): Promise<AgentDetail | undefined> {
    const row = queries.getAgentRow(agentId)
    if (!row) return undefined
    assertMayTouchAgent(principal, row)
    const agent = requireAgent(agentId)
    const workspace = await workspaceInfoOf(row)
    return {
      agent,
      tools: parseAgentTools(row.tools),
      toolDefinitions: parseAgentToolDefinitions(row.toolDefinitions),
      systemPrompt: row.systemPrompt,
      sessionFile: row.sessionFile,
      usage: queries.usageOfAgent(agentId),
      workspace,
    }
  }

  /** Committed message history (agent-management face): assert the
   * principal's scope, then delegate to the raw query. */
  function listMessages(
    agentId: string,
    opts: { after?: number; sessionId?: string },
    principal: Principal
  ) {
    const row = queries.getAgentRow(agentId)
    if (row) assertMayTouchAgent(principal, row)
    return queries.listMessages(agentId, opts)
  }

  async function workspaceInfoOf(
    row: typeof agents.$inferSelect
  ): Promise<WorkspaceInfo> {
    const s = getSettings()
    // containerRunning is inherently async (docker inspect) — the fleet
    // polls every few seconds and a stale answer is acceptable; the probe
    // asks the manager directly about the agent's own sandbox.
    const name = row.challengeId
      ? agentContainerName(row.id)
      : orchestratorContainerName(row.eventId)
    return {
      containerRunning: await containerManager
        .isRunning(name)
        .catch(() => false),
      liveAgentCount: liveAgentCountOf(row.challengeId),
      image: get(s, "container.image"),
      cpus: get(s, "container.cpus"),
      memoryMb: get(s, "container.memoryMb"),
      pidsLimit: get(s, "container.pidsLimit"),
    }
  }

  function liveAgentCountOf(challengeId: string | null): number {
    if (!challengeId) {
      const row = db
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(
            eq(agents.role, "orchestrator"),
            inArray(agents.status, LIVE_AGENT_STATUSES)
          )
        )
        .get()
      return row ? 1 : 0
    }
    return db
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.challengeId, challengeId),
          inArray(agents.status, LIVE_AGENT_STATUSES)
        )
      )
      .all().length
  }

  /** The fleet view: challenges + per-challenge agents + scheduler agent +
   * config/status (the event overview's single poll). */
  function fleet(eventId: string, principal: Principal): FleetInfo {
    assertMayTouchEvent(principal, eventId)
    const challengeRows = db
      .select({
        id: challenges.id,
        name: challenges.name,
        category: challenges.category,
      })
      .from(challenges)
      .where(eq(challenges.eventId, eventId))
      .all()
    const solverAgents = queries.listAgents({ eventId, role: "solver" })
    const agentsByChallenge: Record<string, AgentSummary[]> = {}
    for (const agent of solverAgents) {
      if (!agent.challengeId) continue
      const list = agentsByChallenge[agent.challengeId] ?? []
      list.push(agent)
      agentsByChallenge[agent.challengeId] = list
    }
    return {
      challenges: challengeRows,
      agentsByChallenge,
      schedulerAgent: schedulerAdmin.getSchedulerAgent(eventId) ?? null,
      config: schedulerAdmin.getSchedulerConfig(eventId),
      status: schedulerAdmin.getStatusSnapshot(eventId),
    }
  }

  /** Delete one agent: dispose its live session, terminalize first so a
   * queue-launched agent's running item settles done (the row is about to
   * vanish — a skipped markDone would stick it running forever), drop the
   * row (cascades its sessions), sweep its dm channel data. Workspaces
   * persist (challenge property). */
  async function deleteAgent(
    agentId: string,
    principal: Principal
  ): Promise<void> {
    await kernel.withLock(agentId, async () => {
      const row = queries.getAgentRow(agentId)
      if (!row) throw new RunActionError("not_found", "Agent not found")
      assertMayTouchAgent(principal, row)
      await kernel.settle(agentId, {
        abort: true,
        status: "aborted",
        by: actorFromPrincipal(principal),
        afterSettle: () => {
          channels.cleanupAgentChannels(agentId)
          // The agent's sandbox went with settle's destroy step; the row
          // vanishes below (cascading its sessions and queue reference).
          emitDomainEvent(db, {
            type: "agent.deleted",
            eventId: row.eventId,
            challengeId: row.challengeId,
            agentId,
            actor: actorFromPrincipal(principal),
            payload: {
              role: row.role,
              actor: actorLabel(actorFromPrincipal(principal)),
            },
          })
        },
      })
    })
  }

  /** Event-settings bulk purge: delete every agent of the event in scope —
   * the scheduler agent first (scope=all) so it stops reacting to the
   * teardowns that follow. Challenge workspaces persist (challenge
   * property; delete the challenges to clear them). */
  async function deleteAgentsForEvent(
    eventId: string,
    scope: "solver" | "all"
  ): Promise<void> {
    const rows = db
      .select({ id: agents.id, role: agents.role })
      .from(agents)
      .where(
        scope === "all"
          ? eq(agents.eventId, eventId)
          : and(eq(agents.eventId, eventId), eq(agents.role, "solver"))
      )
      .all()
    const ordered = [
      ...rows.filter((row) => row.role === "orchestrator"),
      ...rows.filter((row) => row.role !== "orchestrator"),
    ]
    for (const row of ordered) {
      await deleteAgent(row.id, { kind: "system" })
    }
  }

  async function close(): Promise<void> {
    closed = true
    decisionEngine.close()
    await kernel.close()
    fleetWatchdog.close()
    queue.cancelDrain()
    planApplier.close()
    await kernel.disposeRuntimes()
    channels.close()
    bus.close()
  }

  /** Boot recovery + restart re-entry. The kernel flips every live agent
   * idle (no auto-resume) and reports the events whose scheduler was
   * RUNNING before the restart; the decision engine then sends a
   * boot.resync ONLY where it is owed — those interrupted schedulers, plus
   * the events whose hydrated decision_state carried unfinished business
   * (§3.7/C 批 — replaces run/boot-reentry). Quiet idle events restart at
   * zero LLM cost; events without a scheduler are left to bootstrap / the
   * user. */
  async function recoverOnBoot(): Promise<void> {
    const interrupted = await kernel.recoverOnBoot()
    decisionEngine.bootResync(interrupted)
  }

  return {
    spawn,
    getAgent: queries.getAgent,
    getAgentDetail,
    listAgents: queries.listAgents,
    fleet,
    stopAgent,
    closeAgent,
    haltChallenge: (challengeId: string) =>
      schedulerAdmin.haltChallenge(challengeId),
    closeEventAgents: (eventId: string, principal: Principal) =>
      schedulerAdmin.closeEventAgents(eventId, principal),
    haltEvent: (eventId: string, principal: Principal) =>
      schedulerAdmin.haltEvent(eventId, principal),
    resumeEvent: (eventId: string, principal: Principal) =>
      schedulerAdmin.resumeEvent(eventId, principal),
    finishAgent,
    sendMessage,
    switchAgentModel,
    compactAgent,
    setQueue,
    setAgentTimeout,
    submitPlan: (eventId: string, plan: Plan, principal: Principal) =>
      planApplier.submitPlan(eventId, plan, principal),
    listAgentSessions: (agentId: string, principal: Principal) => {
      assertMayTouchAgent(principal, requireAgent(agentId))
      return kernel.listSessions(agentId)
    },
    createAgentSession: async (agentId: string, principal: Principal) => {
      assertMayTouchAgent(principal, requireAgent(agentId))
      return kernel.createSession(agentId, actorFromPrincipal(principal))
    },
    activateAgentSession: async (
      agentId: string,
      sessionId: string,
      principal: Principal
    ) => {
      assertMayTouchAgent(principal, requireAgent(agentId))
      return kernel.activateSession(
        agentId,
        sessionId,
        actorFromPrincipal(principal)
      )
    },
    backtrackAgent: async (
      agentId: string,
      seq: number,
      principal: Principal
    ) => {
      assertMayTouchAgent(principal, requireAgent(agentId))
      return kernel.backtrack(agentId, seq)
    },
    delete: deleteAgent,
    deleteAgentsForEvent,
    getStatus: (eventId: string, principal: Principal) => {
      assertMayTouchEvent(principal, eventId)
      return schedulerAdmin.getStatusSnapshot(eventId)
    },
    getSchedulerAgent: (eventId: string, principal: Principal) => {
      assertMayTouchEvent(principal, eventId)
      return schedulerAdmin.getSchedulerAgent(eventId)
    },
    inboxSnapshot: channels.inboxSnapshot,
    forgetEventState: (eventId: string) => decisionEngine.forget(eventId),
    assertModelsResolvable: schedulerAdmin.assertModelsResolvable,
    getSchedulerConfig: (eventId: string, principal: Principal) => {
      assertMayTouchEvent(principal, eventId)
      return schedulerAdmin.getSchedulerConfig(eventId)
    },
    upsertSchedulerConfig: schedulerAdmin.upsertSchedulerConfig,
    startScheduler: schedulerAdmin.startScheduler,
    pauseScheduler: schedulerAdmin.pauseScheduler,
    resumeScheduler: schedulerAdmin.resumeScheduler,
    closeScheduler: schedulerAdmin.closeScheduler,
    queue: () => queue,
    refresh: queries.getAgent,
    recoverOnBoot,
    close,
    listMessages,
    usageOfAgent: queries.usageOfAgent,
    usageForEvent: queries.usageForEvent,
    agentFlags: queries.agentFlags,
    bus,
    channels,
    notifyFlagAccepted: flagHooks.notifyFlagAccepted,
    notifyFlagPartial: flagHooks.notifyFlagPartial,
    submitFlag: (
      challengeId: string,
      agentId: string,
      flag: string | undefined,
      principal: Principal
    ) => {
      const row = queries.getAgentRow(agentId)
      if (row) assertMayTouchAgent(principal, row)
      return platformService.submitFlag(challengeId, agentId, flag)
    },
    targetAction: platformService.targetAction,
    workspaceFiles: workspaceFace.workspaceFiles,
    workspaceDownloadPath: workspaceFace.workspaceDownloadPath,
    deleteChallengeWorkspace: workspaceFace.deleteChallengeWorkspace,
    deleteSchedulerWorkspace: workspaceFace.deleteSchedulerWorkspace,
    deleteEventWorkspaces: workspaceFace.deleteEventWorkspaces,
  }
}
