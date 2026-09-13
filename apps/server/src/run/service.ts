import { rmSync } from "node:fs"
import { join } from "node:path"

import type {
  AgentDetail,
  AgentSummary,
  FleetInfo,
  Plan,
  SwitchModelInput,
  WorkspaceFile,
  WorkspaceInfo,
} from "@aegisx/shared"
import {
  formatModelRef,
  get,
  isActiveAgentStatus,
  isTerminalAgentStatus,
  LIVE_AGENT_STATUSES,
} from "@aegisx/shared"
import type { ProviderConnection } from "@aegisx/shared/domain"
import { and, desc, eq, inArray, ne } from "drizzle-orm"

import type { Database } from "../db"
import { agents, challengeFlags, challenges, events } from "../db/schema"
import type { Principal } from "../infrastructure/agent-auth"
import type { ConfigStore } from "../infrastructure/config-store"
import {
  readWorkspacePath,
  workspaceDownload,
} from "../infrastructure/workspace-files"
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
import {
  getChallengeRemote,
  isTargetCapable,
} from "../platforms/challenge-state"
import type { FlagAcceptOutcome } from "../platforms/flags"
import type { createPlatformService } from "../platforms/service"
import { getProviderConnections } from "../providers/public"
import { createAgentFactory, type AgentFactory } from "./agent-factory"
import {
  createAgentRuntime,
  type AgentRuntime,
  type AgentRuntimeDeps,
  type SettleOptions,
} from "./agent-runtime"
import { createAgentSessionOps } from "./agent-session-ops"
import { createAgentStatus, type AgentStatus } from "./agent-status"
import { createChannelService, type ChannelService } from "./channels"
import type { SendOutcome } from "./channels-context"
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
import { createFleetWatchdog } from "./fleet-watchdog"
import { applyModelSwitch } from "./host/agent-ops"
import { createAgentHost } from "./host/host"
import type { AgentLoopSettings } from "./host/host-session"
import { createLiveBus, type LiveBus } from "./host/live"
import { chainLock } from "./locks"
import { createModelResolver } from "./model-resolver"
import { createNoticePublisher } from "./orch-notices"
import { createPlanApplier } from "./plan/applier"
import { createRunPort } from "./ports"
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
import { createSchedulerAdmin, type SchedulerAdmin } from "./scheduler-admin"
import { type SchedulerPolicy, schedulerPolicyFor } from "./scheduler-policy"
import {
  agentContainerName,
  agentId8,
  challengeCacheVolume,
  challengeRoot,
  orchestratorContainerName,
  orchestratorRoot,
  workspaceDir as workspaceDirOf,
} from "./workspace-resolver"

type PlatformService = ReturnType<typeof createPlatformService>

/** Write-up wrap-up bound after a full solve: the surviving submitter's
 * deadline is pulled to this horizon (code constant; measured wrap-up p90
 * is ~2.3min, so 5min only cuts the pathological tail). */
const SOLVED_WRAPUP_MS = 5 * 60_000

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
  /** Test seam: solved write-up wrap-up bound (default SOLVED_WRAPUP_MS). */
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

  function providers(): ProviderConnection[] {
    return getProviderConnections(configStore)
  }

  /** Model-ref resolution, factored out of the service (model-resolver.ts). */
  const modelResolver = createModelResolver({
    getSettings,
    providers,
  })
  const queries = createAgentQueries({ db })
  const bus: LiveBus = createLiveBus()

  // Seed the built-in prompt templates (idempotent) so the service is
  // self-sufficient — any agent spawned here renders.
  seedBuiltinTemplates(db)
  // Idempotent guard: plugin-owned template rows (a pre-v9 concept) must
  // never come back — re-delete any who got re-seeded.
  db.run(`DELETE FROM prompt_templates WHERE plugin != 'builtin'`)

  /** Live agents' in-process resources: one runtime per touched agent (the
   * mounted session, deadline/grace timers, finish_run bookkeeping,
   * turn generation). The ONLY per-agent registry — settle() is the single
   * path that empties an entry. Cold-restored idle/terminal agents have no
   * entry (the DB row is their state; a message rebuilds the runtime). */
  const runtimes = new Map<string, AgentRuntime>()
  /** Per-agent promise-chaining locks (the only concurrency mechanism). */
  const locks = new Map<string, Promise<unknown>>()
  /** Global fence lock: serializes fence check + slot reservation across all
   * spawns so the concurrency caps hold under interleaving. */
  const fenceLocks = new Map<string, Promise<unknown>>()
  let closed = false
  /** Monotonic timestamp: never returns the same value twice, so agents
   * declared within one millisecond still get a strictly-ordered `createdAt`. */
  let lastNowMs = 0
  const now = () => {
    let ms = clock.now()
    if (ms <= lastNowMs) ms = lastNowMs + 1
    lastNowMs = ms
    return new Date(ms).toISOString()
  }

  function withLock<T>(agentId: string, op: () => T | Promise<T>): Promise<T> {
    if (closed) {
      return Promise.reject(
        new RunActionError("invalid_state", "Agent service is closed")
      )
    }
    return chainLock(locks, agentId, op)
  }

  /** Global fence critical section. Serializes the fence check + slot
   * reservation so concurrent spawns can't overshoot the caps. Holds only
   * the quick DB op (row insert); container builds and setup run outside.
   *
   * Lock order: every fence critical section (spawn) runs OUTSIDE any agent
   * lock — no fence section ever acquires an agent lock, so the order is
   * acyclic (no deadlock). */
  async function withFence<T>(op: () => T | Promise<T>): Promise<T> {
    return chainLock(fenceLocks, "global-fence", op)
  }

  // Late-bound sibling modules (run/ports.ts): the factories below reference
  // each other, so construction is a cyclic graph that cannot be closed with
  // plain consts. Each port is bound exactly once, in the construction order
  // at the bottom of this function, and read only after the service is wired.
  const factoryPort = createRunPort<AgentFactory>("factory")
  const schedulerAdminPort = createRunPort<SchedulerAdmin>("schedulerAdmin")
  const queuePort = createRunPort<QueueService>("queue")

  const challengeWorkspaceRoot = (eventId: string, challengeId: string) =>
    workspaceDirOf(challengeRoot(dataDir, eventId, challengeId))

  function requireAgent(agentId: string): AgentSummary {
    const agent = queries.getAgent(agentId)
    if (!agent) throw new RunActionError("not_found", "Agent not found")
    return agent
  }

  // --- unified message layer ------------------------------------------------

  const channels: ChannelService = createChannelService({
    db,
    dataDir,
    bus,
    // Deliveries push through the agent's runtime (steer/followUp/fresh
    // turn/cold resume — late-bound: channels exist before any runtime).
    send: (agentId, text, deliverAs, opts) =>
      sendToAgent(agentId, text, deliverAs, opts),
    now,
    challengeWorkspaceRoot,
    clock,
    // Scheduler-directed content (solver asks, user posts on orch, user DMs
    // to the scheduler) opens a decision point — the delivery engine keeps
    // NO scheduler face (§3.6). Late-bound over the engine defined below.
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
  // the agent lifecycle lines and the direct scheduler wakes — a few local
  // rows read per message, no cache to invalidate.
  const noticeTemplateBody = (key: keyof typeof NOTICE_TEMPLATE_DEFAULTS) =>
    loadTemplateMap(db).get(key) ?? NOTICE_TEMPLATE_DEFAULTS[key]

  // Every system→scheduler/team notice is a typed event (run/orch-notices)
  // rendered through its (user-editable) template.
  const notices = createNoticePublisher({
    templateBody: noticeTemplateBody,
    post: (input, principal) => channels.post(input, principal),
    isSchedulerPaused: (eventId) =>
      schedulerAdminPort.get().isSchedulerPaused(eventId),
  })

  // The decision-point engine (§3.6): the ONE deterministic wake path for
  // every scheduler. All deps are late-bound closures — the ports and the
  // send path resolve at first trigger, not at construction.
  const decisionEngine = createDecisionPointEngine({
    db,
    clock,
    now,
    send: async (agentId, text) => sendToAgent(agentId, text),
    // The fleet digest moved here from the delivery face (§3.7): every
    // decision-point payload ends with the [调度快照] block, rendered per
    // open against the current DB state (a render failure degrades to an
    // empty block, the payload itself must not fail).
    digestOf: (eventId) => {
      try {
        const context = schedulerAdminPort.get().getDigestContext(eventId)
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
    isSchedulerPaused: (eventId) =>
      schedulerAdminPort.get().isSchedulerPaused(eventId),
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

  const status: AgentStatus = createAgentStatus({
    db,
    queries,
    bus,
    channels,
    templateBody: noticeTemplateBody,
    isSchedulerPaused: (eventId) =>
      schedulerAdminPort.get().isSchedulerPaused(eventId),
    // The target-slot fence counts a challenge as occupying a slot while it
    // has a live agent; the platform counts a running instance. Release the
    // instance when the last live agent leaves, or the two views diverge and
    // the fence keeps admitting spawns the platform cannot serve.
    onAgentTerminal: (agentId) => {
      decisionEngine.onAgentTerminal(agentId)
      const row = queries.getAgentRow(agentId)
      if (!row?.challengeId) return
      const challengeId = row.challengeId
      // An aborted/failed attempt leaves no curated artifacts (a completed
      // attempt's WRITEUP.md is kept); recycle its directory eagerly or one
      // long-fought challenge accumulates dozens of stale trees that then
      // mislead every later spawn reading the workspace.
      if (row.status === "aborted" || row.status === "failed") {
        rmSync(
          join(
            challengeWorkspaceRoot(row.eventId, challengeId),
            "agents",
            agentId8(agentId)
          ),
          { recursive: true, force: true }
        )
      }
      if (!schedulerPolicyFor(db, row.eventId).stopTargetOnSolve) return
      const live = db
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(
            eq(agents.challengeId, challengeId),
            inArray(agents.status, LIVE_AGENT_STATUSES)
          )
        )
        .get()
      if (live || !isTargetCapable(getChallengeRemote(db, challengeId))) return
      void platformService
        .targetAction(challengeId, "stop")
        .catch(() => undefined)
    },
    now,
    queue: queuePort,
    // Decision-point engine feeds: every solver turn settle is an
    // agent.settled trigger; the scheduler's own settle correlates its open
    // decision point; a deadline fire is the urgent agent.timedOut trigger.
    onTurnSettled: (agentId, error) =>
      decisionEngine.onTurnSettled(agentId, error),
    onAgentTimedOut: (agentId, outcome) => {
      const row = queries.getAgentRow(agentId)
      if (!row) return
      decisionEngine.trigger(row.eventId, {
        kind: "agent.timedOut",
        agentId,
        outcome,
      })
    },
  })

  /** The runtime deps are per-agent-invariant: every runtime shares them,
   * only the agentId differs (passed to createAgentRuntime). */
  const runtimeDeps: AgentRuntimeDeps = {
    db,
    status,
    clock,
    closeAbortGraceMs,
    ...(options.timeoutGraceMs !== undefined
      ? { timeoutGraceMs: options.timeoutGraceMs }
      : {}),
    withLock,
    now,
    forget: (agentId) => runtimes.delete(agentId),
    destroySandbox,
    resumeAgent: (agentId) => factoryPort.get().resumeAgent(agentId),
  }

  /** Get-or-create the agent's runtime — created on first touch (session
   * mount, deadline arm, finish bookkeeping, send), removed ONLY by settle
   * or service close. */
  function runtimeOf(agentId: string): AgentRuntime {
    let runtime = runtimes.get(agentId)
    if (!runtime) {
      runtime = createAgentRuntime(agentId, runtimeDeps)
      runtimes.set(agentId, runtime)
    }
    return runtime
  }

  /** Deliver a message through the agent's runtime (steer / followUp while
   * streaming, fresh turn otherwise, cold resume when session-less). */
  function sendToAgent(
    agentId: string,
    text: string,
    deliverAs?: "steer" | "followUp",
    opts?: { assertLive?: (id: string) => boolean }
  ): Promise<SendOutcome> {
    return runtimeOf(agentId).send(text, deliverAs, opts)
  }

  /** The ONE terminal-settle path (timeout force-abort, finish_run
   * self-termination, close, finish, delete, superseded launch). Agents with
   * a runtime settle through it (bounded abort → dispose → timers + finish
   * bookkeeping → terminalize incl. the live-bus forget → sandbox destroy →
   * delete-only teardown); agents without one (never prepared — e.g. a spawn
   * that failed before its session mounted) land straight terminal, and the
   * destroy here reclaims a sandbox the failed prepare may have built. */
  async function settleAgent(
    agentId: string,
    opts: SettleOptions
  ): Promise<void> {
    const runtime = runtimes.get(agentId)
    if (runtime) {
      await runtime.settle(opts)
      return
    }
    destroySandbox(agentId)
    status.terminalizeAgent(agentId, {
      status: opts.status,
      summary: opts.summary,
      error: opts.error,
      event: opts.event,
      actor: opts.actor,
      by: opts.by,
    })
    opts.afterSettle?.()
  }

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

  /** Destroy one agent's sandbox container: ONE `remove(force)` (pid1 is
   * `sleep infinity`, nothing to flush — no grace timer, which could only
   * murder a same-name successor). Fire-and-forget; the name derives from
   * the agent row (the scheduler rides its per-event orchestrator container).
   * Idempotent: missing rows/containers are no-ops. */
  function destroySandbox(agentId: string): void {
    const row = queries.getAgentRow(agentId)
    if (!row) return
    const name = row.challengeId
      ? agentContainerName(agentId)
      : orchestratorContainerName(row.eventId)
    void containerManager.remove(name).catch((error) => {
      console.error("sandbox destroy failed", {
        agentId,
        name,
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }

  // --- multi-session + flat backtrack (v12) --------------------------------
  const sessionOps = createAgentSessionOps({
    db,
    sessionOf: (agentId) => runtimes.get(agentId)?.session(),
    detachSession: (agentId) => {
      runtimes.get(agentId)?.unmountSession()
    },
    withLock,
    prepareAgent: (agentId) => factoryPort.get().prepareAgent(agentId),
    resumeAgent: (agentId) => factoryPort.get().resumeAgent(agentId),
    emitAgent: status.emitAgent,
    requireAgent,
    now,
  })

  // --- agent facade (routes-facing) -----------------------------------------

  /** Spawn one solver agent (the direct path — fence full → capacity
   * error). The queue's drainer calls the factory directly. */
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
    const agentId = await factoryPort.get().spawnAgent({
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

  /** Per-agent stop: abort the current turn; it settles to idle (the shared
   * container stays warm). */
  async function stopAgent(
    agentId: string,
    principal: Principal
  ): Promise<AgentSummary> {
    assertMayTouchAgent(principal, requireAgent(agentId))
    await runtimes
      .get(agentId)
      ?.abort()
      .catch(() => undefined)
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
    const runtime = runtimes.get(agentId)
    if (!runtime) return
    let aborted = false
    await Promise.race([
      runtime
        .abort()
        .catch(() => undefined)
        .then(() => {
          aborted = true
        }),
      clock.sleep(closeAbortGraceMs),
    ])
    if (aborted) return
    const current = runtime.session()
    if (current?.session.isStreaming) {
      await settleAgent(agentId, {
        abort: false,
        status: "aborted",
        by: actorFromPrincipal(principal),
      })
    }
  }

  /** Terminal close (user/scheduler): abort + dispose the session, land
   * aborted. Files and the DB session survive (reopen on demand). */
  async function closeAgent(
    agentId: string,
    principal: Principal
  ): Promise<AgentSummary> {
    const agent = requireAgent(agentId)
    assertMayTouchAgent(principal, agent)
    if (isTerminalAgentStatus(agent.status)) {
      throw new RunActionError("invalid_state", "Agent is already closed")
    }
    await withLock(agentId, async () => {
      const current = queries.getAgentRow(agentId)
      if (current && isTerminalAgentStatus(current.status)) {
        throw new RunActionError("invalid_state", "Agent is already closed")
      }
      await settleAgent(agentId, {
        abort: true,
        status: "aborted",
        by: actorFromPrincipal(principal),
      })
    })
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
    const agent = requireAgent(agentId)
    assertMayTouchAgent(principal, agent)
    if (agent.status === "completed") return agent
    if (isTerminalAgentStatus(agent.status)) {
      throw new RunActionError("invalid_state", "Agent is already closed")
    }
    return withLock(agentId, async () => {
      const current = queries.getAgentRow(agentId)
      if (current?.status === "completed") return requireAgent(agentId)
      if (current && isTerminalAgentStatus(current.status)) {
        throw new RunActionError("invalid_state", "Agent is already closed")
      }
      await settleAgent(agentId, {
        abort: true,
        status: "completed",
        summary,
        event: "agent.finished",
        actor,
        by: actorFromPrincipal(principal),
      })
      return requireAgent(agentId)
    })
  }

  /** Manual challenge halt: close every live agent + cancel the challenge's
   * pending queue items + best-effort stop the platform target — the
   * human-triggered counterpart of the solve cleanup (stopOthersOnSolved).
   * A running queue item settles via its agent's terminal close (markDone). */
  async function haltChallenge(challengeId: string): Promise<{
    closed: number
    cancelled: number
  }> {
    const challenge = queries.getChallengeMeta(challengeId)
    if (!challenge) throw new RunActionError("not_found", "Challenge not found")
    const live = db
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.challengeId, challengeId),
          inArray(agents.status, LIVE_AGENT_STATUSES)
        )
      )
      .all()
    let closedCount = 0
    for (const row of live) {
      await closeAgent(row.id, { kind: "system" })
        .then(() => {
          closedCount += 1
        })
        .catch(() => undefined)
    }
    const cancelled = queuePort
      .get()
      .cancelPendingForChallenge(challenge.eventId, challengeId)
    if (isTargetCapable(getChallengeRemote(db, challengeId))) {
      void platformService
        .targetAction(challengeId, "stop")
        .catch(() => undefined)
    }
    if (closedCount > 0 || cancelled > 0) {
      notices.publish({
        type: "challengeHalt",
        eventId: challenge.eventId,
        challengeName: challenge.name,
        closed: closedCount,
        cancelled,
      })
    }
    return { closed: closedCount, cancelled }
  }

  /** Close every live solver agent of the event (terminal aborted — rows,
   * sessions and files survive). The scheduler agent is untouched: pausing,
   * not closing, is how the scheduler is held (resume stays one click and
   * its memory stays warm). */
  async function closeEventAgents(
    eventId: string,
    principal: Principal
  ): Promise<number> {
    assertMayTouchEvent(principal, eventId)
    const live = db
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.eventId, eventId),
          eq(agents.role, "solver"),
          inArray(agents.status, LIVE_AGENT_STATUSES)
        )
      )
      .all()
    let closedCount = 0
    for (const row of live) {
      await closeAgent(row.id, { kind: "system" })
        .then(() => {
          closedCount += 1
        })
        .catch(() => undefined)
    }
    return closedCount
  }

  /** Event-level emergency halt — every lever, one click, all reversible:
   * freeze the queue, pause the scheduler (the engine's two gates — no
   * decision points, no notices, no violation escalation), close all live
   * solvers and stop all platform targets. The scheduler cannot be woken
   * while halted because BOTH of the engine's gates are closed; no inbox
   * hold exists anymore (the delivery engine has no scheduler face). */
  async function haltEvent(
    eventId: string,
    principal: Principal
  ): Promise<{
    closed: number
    targetsStopped: number
    targetFailures: number
  }> {
    const event = db
      .select({ id: events.id })
      .from(events)
      .where(eq(events.id, eventId))
      .get()
    if (!event) throw new RunActionError("not_found", "Event not found")
    queuePort.get().pause(eventId, "manual", principal)
    await pauseScheduler(eventId)
    const solverClosed = await closeEventAgents(eventId, principal)
    const targets = await platformService.stopEventTargets(eventId)
    return {
      closed: solverClosed,
      targetsStopped: targets.stopped,
      targetFailures: targets.failures.length,
    }
  }

  /** Counterpart of {@link haltEvent}: resume the scheduler (a decision
   * point re-syncs it) and unfreeze the queue. */
  async function resumeEvent(
    eventId: string,
    principal: Principal
  ): Promise<void> {
    const event = db
      .select({ id: events.id })
      .from(events)
      .where(eq(events.id, eventId))
      .get()
    if (!event) throw new RunActionError("not_found", "Event not found")
    await resumeScheduler(eventId)
    queuePort.get().resume(eventId, "manual", principal)
    queuePort.get().scheduleDrain()
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
    await sendToAgent(agentId, input.text, input.deliverAs)
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
    return withLock(agentId, async () => {
      const session = runtimes.get(agentId)?.session()
      if (!session) {
        throw new RunActionError(
          "invalid_state",
          "Agent has no live session; send it a message first"
        )
      }
      const agentRow = queries.getAgentRow(agentId)
      // Proactively refresh the workspace's ModelRuntime when the config
      // changed since it was last refreshed, so the resolved target carries
      // the current provider/apiKey/metadata — not a frozen snapshot. (This
      // also makes models added while live resolvable, so there is no longer
      // a miss-then-retry fallback.)
      await factoryPort
        .get()
        .ensureWorkspaceRuntimeFresh(
          factoryPort
            .get()
            .workspaceKeyOf(agentRow ?? { eventId: "", challengeId: null })
        )
      let result: Awaited<ReturnType<typeof applyModelSwitch>>
      try {
        result = await applyModelSwitch(
          session,
          providers(),
          input.model,
          agentRow?.model ?? null
        )
      } catch (error) {
        throw new RunActionError(
          "invalid_state",
          error instanceof Error ? error.message : String(error)
        )
      }
      const { target } = result
      // Persist the ACTUAL (SDK-clamped) thinking level so the agent
      // snapshot matches runtime reality.
      const to = formatModelRef(
        target.provider,
        target.model,
        result.thinkingLevel
      )
      emitDomainEvent(db, {
        type: "agent.model_switched",
        eventId: agentRow?.eventId ?? null,
        challengeId: agentRow?.challengeId ?? null,
        agentId,
        actor: actorFromPrincipal(principal),
        payload: {
          from: agentRow?.model ?? null,
          to,
          thinkingLevel: result.thinkingLevel,
          at: now(),
        },
      })
      status.emitAgent(agentId)
      return requireAgent(agentId)
    })
  }

  /** Replace an agent's steer/followUp queue. Serialized against its turns;
   * uses the SDK queue API directly. */
  async function setQueue(
    agentId: string,
    input: { steering: string[]; followUp: string[] },
    principal: Principal
  ): Promise<void> {
    assertMayTouchAgent(principal, requireAgent(agentId))
    return withLock(agentId, async () => {
      const session = runtimes.get(agentId)?.session()
      if (!session) return
      session.session.clearQueue()
      for (const text of input.steering) {
        const trimmed = text.trim()
        if (trimmed) await session.session.steer(trimmed)
      }
      for (const text of input.followUp) {
        const trimmed = text.trim()
        if (trimmed) await session.session.followUp(trimmed)
      }
    })
  }

  /** Manually compact an agent's context (pi SDK `session.compact()`). */
  async function compactAgent(
    agentId: string,
    principal: Principal
  ): Promise<AgentSummary> {
    assertMayTouchAgent(principal, requireAgent(agentId))
    await withLock(agentId, async () => {
      const session = runtimes.get(agentId)?.session()
      if (!session) {
        throw new RunActionError(
          "invalid_state",
          "Agent session is not active — send a message first"
        )
      }
      if (session.session.isStreaming) {
        throw new RunActionError(
          "invalid_state",
          "Cannot compact while a turn is running — stop it first"
        )
      }
      await session.session.compact()
    })
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
    const agent = schedulerAdminPort
      .get()
      .setAgentTimeout(agentId, timeoutMs, actorFromPrincipal(principal))
    const row = queries.getAgentRow(agentId)
    if (row && isActiveAgentStatus(row.status)) {
      runtimeOf(agentId).armDeadline(row.deadlineAt)
    }
    status.emitAgent(agentId)
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
    const scheduler = schedulerAdminPort.get()
    return {
      challenges: challengeRows,
      agentsByChallenge,
      schedulerAgent: scheduler.getSchedulerAgent(eventId) ?? null,
      config: scheduler.getSchedulerConfig(eventId),
      status: scheduler.getStatusSnapshot(eventId),
    }
  }

  /** Challenge workspace file tree (agents/ shared/ attachments/ visible). */
  function workspaceFiles(
    eventId: string,
    challengeId: string,
    path: string
  ): WorkspaceFile {
    return readWorkspacePath(challengeWorkspaceRoot(eventId, challengeId), path)
  }

  function workspaceDownloadPath(
    eventId: string,
    challengeId: string,
    path: string
  ) {
    return workspaceDownload(challengeWorkspaceRoot(eventId, challengeId), path)
  }

  // --- agent deletion ---------------------------------------------------------

  /** Delete one agent: dispose its live session, terminalize first so a
   * queue-launched agent's running item settles done (the row is about to
   * vanish — a skipped markDone would stick it running forever), drop the
   * row (cascades its sessions), sweep its dm channel data. Workspaces
   * persist (challenge property). */
  async function deleteAgent(
    agentId: string,
    principal: Principal
  ): Promise<void> {
    await withLock(agentId, async () => {
      const row = queries.getAgentRow(agentId)
      if (!row) throw new RunActionError("not_found", "Agent not found")
      assertMayTouchAgent(principal, row)
      await settleAgent(agentId, {
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

  // --- flag hooks -------------------------------------------------------------

  /** Platform-side hook: a flag was accepted. Tiered by outcome — "first"
   * (the challenge's initial solve): open an URGENT decision point + a #team
   * notice (policy-gated), run the full-solve cleanup under the event's
   * policy; "extra" (a new flag value on an already-solved challenge): light
   * #team notice only; "repeat" (a duplicate of an accepted value):
   * submitter event only. */
  function notifyFlagAccepted(
    challengeId: string,
    submitterAgentId?: string,
    outcome: FlagAcceptOutcome = "first"
  ): void {
    if (submitterAgentId) {
      status.emitAgentEvent(submitterAgentId, {
        type: "agent.flagAccepted",
        agentId: submitterAgentId,
      })
    }
    if (outcome === "repeat") return
    const meta = queries.getChallengeMeta(challengeId)
    if (!meta) return
    const { eventId, name } = meta
    const policy = schedulerPolicyFor(db, eventId)
    if (outcome === "extra") {
      decisionEngine.trigger(eventId, {
        kind: "flag.accepted",
        challengeName: name,
        tier: "extra",
      })
      if (policy.notifyTeamOnFlag) {
        notices.publish({
          type: "flagAccepted",
          tier: "extra",
          eventId,
          challengeId,
          challengeName: name,
          flag: latestAcceptedFlag(challengeId),
          submitterAgentId,
        })
      }
      return
    }
    decisionEngine.trigger(eventId, {
      kind: "flag.accepted",
      challengeName: name,
      tier: "first",
    })
    if (policy.notifyTeamOnFlag) {
      notices.publish({
        type: "flagAccepted",
        tier: "first",
        eventId,
        challengeId,
        challengeName: name,
        flag: latestAcceptedFlag(challengeId),
        submitterAgentId,
        stopSiblings: policy.stopSiblingsOnSolve,
      })
    }
    stopOthersOnSolved(challengeId, submitterAgentId, policy)
  }

  /** The challenge's most recently updated accepted flag, if any. */
  function latestAcceptedFlag(challengeId: string): string | undefined {
    return db
      .select({ flag: challengeFlags.flag })
      .from(challengeFlags)
      .where(
        and(
          eq(challengeFlags.challengeId, challengeId),
          eq(challengeFlags.status, "accepted")
        )
      )
      .orderBy(desc(challengeFlags.updatedAt))
      .get()?.flag
  }

  /** The challenge's accepted flag values (the partial-solve progress list). */
  function acceptedFlagsOf(challengeId: string): string[] {
    return db
      .select({ flag: challengeFlags.flag })
      .from(challengeFlags)
      .where(
        and(
          eq(challengeFlags.challengeId, challengeId),
          eq(challengeFlags.status, "accepted")
        )
      )
      .all()
      .map((f) => f.flag)
  }

  /** Platform-side hook: a correct-but-incomplete multi-flag submission
   * (a multi-flag partial — the challenge is NOT fully solved). ONE
   * non-urgent decision-point trigger (flag.accepted/partial) + a
   * non-urgent system post into the challenge's #team (policy-gated) + a
   * non-urgent orch notice. The submitter rides in meta so delivery can
   * skip its own notice. */
  function notifyFlagPartial(
    challengeId: string,
    message: string | null,
    submitterAgentId?: string
  ): void {
    const meta = queries.getChallengeMeta(challengeId)
    if (!meta) return
    decisionEngine.trigger(meta.eventId, {
      kind: "flag.accepted",
      challengeName: meta.name,
      tier: "partial",
    })
    if (schedulerPolicyFor(db, meta.eventId).notifyTeamOnFlag) {
      notices.publish({
        type: "flagAccepted",
        tier: "partial",
        eventId: meta.eventId,
        challengeId,
        challengeName: meta.name,
        message,
        confirmedFlags: acceptedFlagsOf(challengeId),
        submitterAgentId,
      })
    }
    notices.publish({
      type: "flagPartialProgress",
      eventId: meta.eventId,
      challengeName: meta.name,
      message,
    })
  }

  /** Full-solve cleanup (see notifyFlagAccepted), shaped by the event's
   * policy: siblings stopped / target stopped / submitter stopped are each
   * skippable; the challenge's pending queue items are always cancelled.
   * The surviving submitter gets its deadline pulled to the wrap-up bound.
   * The target stop is AWAITED before the closes land, so the slot release
   * the drainer reacts to has actually happened on the platform (no
   * capacity-rejection race with the next spawn's start_target). */
  function stopOthersOnSolved(
    challengeId: string,
    submitterAgentId: string | undefined,
    policy: SchedulerPolicy
  ): void {
    const meta = queries.getChallengeMeta(challengeId)
    if (!meta) return
    const { eventId, name } = meta
    // Live agents on the challenge to close: siblings (policy) and, in
    // evaluation mode (stopSubmitterOnSolve), the submitter itself — no
    // write-up wrap-up. Otherwise the submitter keeps its session to
    // finish via finish_run, bounded by the wrap-up deadline below.
    const stopSubmitter =
      policy.stopSubmitterOnSolve && submitterAgentId !== undefined
    const closing = policy.stopSiblingsOnSolve || stopSubmitter
    const siblings = closing
      ? db
          .select({ id: agents.id })
          .from(agents)
          .where(
            and(
              eq(agents.challengeId, challengeId),
              inArray(agents.status, LIVE_AGENT_STATUSES),
              !stopSubmitter && submitterAgentId
                ? ne(agents.id, submitterAgentId)
                : undefined
            )
          )
          .all()
      : []
    const cancelled = queuePort
      .get()
      .cancelPendingForChallenge(eventId, challengeId)
    if (submitterAgentId && !stopSubmitter) {
      armSolvedWrapup(submitterAgentId)
    }
    void (async () => {
      // Orphaned platform target: the challenge is fully solved — its
      // target is no longer needed. Awaited BEFORE the closes below: their
      // terminal drains launch the next queued agent, whose start_target
      // must not race an instance that is still shutting down.
      if (
        policy.stopTargetOnSolve &&
        isTargetCapable(getChallengeRemote(db, challengeId))
      ) {
        await platformService
          .targetAction(challengeId, "stop")
          .catch(() => undefined)
      }
      // Close siblings and count the ones that actually terminalized — a
      // close can still lose a race (already closed). The notice posts once
      // the closes settle, so it never claims a stop that didn't land.
      const stopped = (
        await Promise.all(
          siblings.map((sibling) =>
            closeAgent(sibling.id, { kind: "system" })
              .then(() => 1)
              .catch(() => 0)
          )
        )
      ).reduce<number>((sum, stopped_) => sum + stopped_, 0)
      // The freed target slot may admit a queued item even when no sibling
      // closed — wake the drainer explicitly (nothing else would).
      queuePort.get().scheduleDrain()
      if (stopped > 0 || cancelled > 0) {
        notices.publish({
          type: "solveCleanup",
          eventId,
          challengeName: name,
          stopped,
          cancelled,
        })
      }
    })()
  }

  /** Pull a surviving submitter's hard deadline to the wrap-up bound so a
   * solved challenge cannot hold an agent slot indefinitely. Only ever
   * shortens — an existing earlier deadline keeps precedence. */
  function armSolvedWrapup(agentId: string): void {
    const row = queries.getAgentRow(agentId)
    if (!row || !isActiveAgentStatus(row.status)) return
    const ms = options.solvedWrapupMs ?? SOLVED_WRAPUP_MS
    const horizon = clock.now() + ms
    if (row.deadlineAt && Date.parse(row.deadlineAt) <= horizon) return
    const iso = new Date(horizon).toISOString()
    emitDomainEvent(db, {
      type: "agent.deadline_armed",
      eventId: row.eventId,
      challengeId: row.challengeId,
      agentId,
      actor: { kind: "system", actorId: "solve-cleanup" },
      payload: { deadlineAt: iso, at: now() },
    })
    runtimeOf(agentId).armDeadline(iso)
  }

  // --- scheduler (event orchestrator) lifecycle -------------------------------

  /** Start (or restart) the event's scheduler agent from its config. The
   * orchestrator's model is the per-event `scheduler_config.modelId`
   * override when set, else the global default.
   *
   *  - live scheduler agent: paused → resume (un-pause + re-sync decision
   *    point); else error.
   *  - terminal scheduler agent: reopen — a user-directive decision point
   *    cold-resumes it (container + session rebuilt, memory kept).
   *    `reset: true` deletes the row and spawns fresh.
   *  - no scheduler agent: fresh spawn (also clears paused). */
  async function startScheduler(
    eventId: string,
    opts: { reset?: boolean } = {}
  ): Promise<AgentSummary> {
    // Per-event start lock: two racing starts would both read "no active
    // orchestrator" and double-spawn (orchestrators bypass the spawn fence,
    // which only serializes quick DB ops, not container builds). The
    // existing/config checks rerun inside the critical section.
    return chainLock(locks, `start:${eventId}`, async () => {
      const admin = schedulerAdminPort.get()
      const config = admin.getSchedulerConfig(eventId)
      const existing = admin.getSchedulerAgent(eventId)
      if (existing && isActiveAgentStatus(existing.status)) {
        if (config.paused) {
          await resumeScheduler(eventId)
          return requireAgent(existing.id)
        }
        throw new RunActionError(
          "invalid_state",
          "A scheduler agent is already active for this event"
        )
      }
      if (existing && !opts.reset) {
        // Reopen keeps memory — the user-directive decision point cold-
        // resumes the orchestrator (the engine's runtime send rebuilds the
        // container + session and drives the re-sync turn).
        admin.setSchedulerPaused(eventId, false)
        decisionEngine.trigger(eventId, {
          kind: "user.directive",
          source: "resume",
          revive: true,
        })
        return requireAgent(existing.id)
      }
      if (existing && opts.reset) {
        await deleteAgent(existing.id, { kind: "system" })
      }
      admin.setSchedulerPaused(eventId, false)
      const agentId = await factoryPort.get().spawnAgent({
        eventId,
        challengeId: null,
        role: "orchestrator",
        source: "manual",
        // Orchestrators bypass the spawn fence — the actor only labels the
        // spawn (never a fence.blocked fact).
        actor: { kind: "system", actorId: "scheduler-admin" },
      })
      return requireAgent(agentId)
    })
  }

  /** Disable the scheduler (W3): set paused=1 (the event gate drops its
   * agent-lifecycle notifications) + abort the current turn (the container
   * stays warm — scheduler containers are lifecycle-managed, never swept). */
  async function pauseScheduler(eventId: string): Promise<AgentSummary | null> {
    const admin = schedulerAdminPort.get()
    admin.setSchedulerPaused(eventId, true)
    const sched = admin.getSchedulerAgent(eventId)
    if (sched && isActiveAgentStatus(sched.status)) {
      await stopAgent(sched.id, { kind: "system" })
      return requireAgent(sched.id)
    }
    return null
  }

  /** Re-enable the scheduler (W3): set paused=0 + open a user-directive
   * decision point so the orchestrator re-syncs before acting. No trigger
   * when absent/terminal (the flag is still written). */
  async function resumeScheduler(
    eventId: string
  ): Promise<AgentSummary | null> {
    const admin = schedulerAdminPort.get()
    admin.setSchedulerPaused(eventId, false)
    const sched = admin.getSchedulerAgent(eventId)
    if (sched && isActiveAgentStatus(sched.status)) {
      decisionEngine.trigger(eventId, {
        kind: "user.directive",
        source: "resume",
      })
      return requireAgent(sched.id)
    }
    return null
  }

  /** Close the scheduler agent (terminal aborted). Its sandbox goes with
   * the settle's destroy step. */
  async function closeScheduler(eventId: string): Promise<AgentSummary> {
    const sched = schedulerAdminPort.get().getSchedulerAgent(eventId)
    if (!sched) throw new RunActionError("not_found", "No scheduler agent")
    return closeAgent(sched.id, { kind: "system" })
  }

  // --- construction of the factory + queue -------------------------------------

  const factory = createAgentFactory({
    db,
    dataDir,
    containerManager,
    platformService,
    providers,
    relayOrigin,
    configVersion: () => configStore.configVersion,
    modelResolver,
    queries,
    bus,
    channels,
    withFence,
    getSettings,
    now,
    status,
    queue: queuePort,
    agentSettings,
    createHost,
    unattended,
    settleFailedSpawn: (agentId, error) =>
      settleAgent(agentId, {
        abort: false,
        status: "failed",
        error,
        by: { kind: "system", actorId: "spawn-failure" },
      }),
    getSchedulerConfig: (eventId) =>
      schedulerAdminPort.get().getSchedulerConfig(eventId),
    hasLiveSession: (agentId) => runtimes.get(agentId)?.hasSession() ?? false,
    mountSession: (agentId, session) =>
      runtimeOf(agentId).mountSession(session),
    armDeadline: (agentId, deadlineAt) =>
      runtimeOf(agentId).armDeadline(deadlineAt),
    send: (agentId, text) => sendToAgent(agentId, text),
    requestFinish: (agentId, summary) =>
      runtimeOf(agentId).requestFinish(summary),
    hasFinishFlagWarned: (agentId) =>
      runtimes.get(agentId)?.hasFinishFlagWarned() ?? false,
    markFinishFlagWarned: (agentId) =>
      runtimeOf(agentId).markFinishFlagWarned(),
  })
  factoryPort.bind(factory)

  const schedulerAdmin = createSchedulerAdmin({
    db,
    queries,
    getSettings,
    now,
    providers,
    modelResolver,
  })
  schedulerAdminPort.bind(schedulerAdmin)

  // The queue's drainer spawns one agent per item from the item's snapshot.
  const queue = createQueueService({
    db,
    getSettings,
    isDisposed: () => closed,
    clock,
    launch: async (item) => {
      const params = parseSpawnQueueParams(item.params)
      return factory.spawnAgent({
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
      void settleAgent(agentId, {
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
  queuePort.bind(queue)

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

  async function close(): Promise<void> {
    closed = true
    decisionEngine.close()
    await Promise.allSettled(locks.values())
    locks.clear()
    fleetWatchdog.close()
    queue.cancelDrain()
    planApplier.close()
    // Each runtime owns its agent's timers (deadline/grace), finish
    // bookkeeping and session: disposing them releases every per-agent
    // resource in one sweep — there is no other registry to clear.
    await Promise.allSettled([...runtimes.values()].map((rt) => rt.dispose()))
    runtimes.clear()
    channels.close()
    bus.close()
  }

  /** Boot recovery + restart re-entry. `factory.recoverOnBoot` flips every
   * live agent idle (no auto-resume); each event with a surviving live
   * scheduler then gets ONE boot.resync decision point to re-sync and decide
   * whether to re-dispatch (§3.7 — replaces run/boot-reentry). Events
   * without a scheduler are left to bootstrap / the user. */
  async function recoverOnBoot(): Promise<void> {
    await factory.recoverOnBoot()
    decisionEngine.bootResync()
  }

  /** Remove a challenge's workspace tree (agents/ shared/ attachments/
   * sessions/ runtime/) + its cache volume — called on challenge deletion.
   * The deletion routes refuse while live agents exist on the challenge, so
   * evicting the cached workspace context alongside the tree is safe (the
   * last agent's settle already destroyed its sandbox). */
  function deleteChallengeWorkspace(
    eventId: string,
    challengeId: string
  ): void {
    factory.forgetWorkspace({ eventId, challengeId })
    void containerManager
      .removeVolume(challengeCacheVolume(challengeId))
      .catch(() => undefined)
    rmSync(challengeRoot(dataDir, eventId, challengeId), {
      recursive: true,
      force: true,
    })
  }

  /** Remove the orchestrator workspace tree — called on event deletion. */
  function deleteSchedulerWorkspace(eventId: string): void {
    factory.forgetWorkspace({ eventId, challengeId: null })
    rmSync(orchestratorRoot(dataDir, eventId), {
      recursive: true,
      force: true,
    })
  }

  /** Remove every challenge workspace + the orchestrator workspace of the
   * event on event deletion. Idempotent per directory. */
  function deleteEventWorkspaces(eventId: string): void {
    const challengeRows = db
      .select({ id: challenges.id })
      .from(challenges)
      .where(eq(challenges.eventId, eventId))
      .all()
    for (const { id } of challengeRows) {
      deleteChallengeWorkspace(eventId, id)
    }
    deleteSchedulerWorkspace(eventId)
  }

  return {
    spawn,
    getAgent: queries.getAgent,
    getAgentDetail,
    listAgents: queries.listAgents,
    fleet,
    stopAgent,
    closeAgent,
    haltChallenge,
    closeEventAgents,
    haltEvent,
    resumeEvent,
    finishAgent,
    sendMessage,
    switchAgentModel,
    compactAgent,
    setQueue,
    setAgentTimeout,
    submitPlan: (eventId: string, plan: Plan, principal: Principal) =>
      planApplier.submitPlan(eventId, plan, principal),
    listAgentSessions: sessionOps.listAgentSessions,
    createAgentSession: sessionOps.createAgentSession,
    activateAgentSession: sessionOps.activateAgentSession,
    backtrackAgent: sessionOps.backtrackAgent,
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
    startScheduler,
    pauseScheduler,
    resumeScheduler,
    closeScheduler,
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
    notifyFlagAccepted,
    notifyFlagPartial,
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
    workspaceFiles,
    workspaceDownloadPath,
    deleteChallengeWorkspace,
    deleteSchedulerWorkspace,
    deleteEventWorkspaces,
  }
}
