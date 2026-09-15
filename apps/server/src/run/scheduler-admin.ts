import type { AgentSummary, FlatSettings } from "@aegisx/shared"
import {
  LIVE_AGENT_STATUSES,
  isActiveAgentStatus,
  modelAddress,
} from "@aegisx/shared"
import type { ProviderConnection } from "@aegisx/shared/domain"
import type { SchedulerStatusSnapshot } from "@aegisx/shared/scheduler"
import { and, eq, inArray } from "drizzle-orm"

import type { Database } from "../db"
import { agents, challenges, events, schedulerConfig } from "../db/schema"
import type { Principal } from "../infrastructure/agent-auth"
import {
  getChallengeRemote,
  isTargetCapable,
} from "../platforms/challenge-state"
import type { createPlatformService } from "../platforms/service"
import type { DecisionPointEngine } from "./decision-points/engine"
import { emitDomainEvent, type DomainEventActor } from "./domain-events/store"
import { RunActionError } from "./errors"
import { fenceSnapshot } from "./fence"
import type { AgentKernel } from "./kernel"
import type { ModelResolver } from "./model-resolver"
import type { NoticePublisher } from "./orch-notices"
import { assertMayTouchEvent } from "./principal-scope"
import type { AgentQueries } from "./queries"
import type { QueueService } from "./queue"
import type { SchedulerDigest } from "./scheduler-digest"
import {
  type NextTaskPolicy,
  type SchedulerPolicy,
  schedulerPolicyFor,
} from "./scheduler-policy"
import type { SpawnService } from "./spawn-service"

export type SchedulerAdminDeps = {
  db: Database
  queries: AgentQueries
  getSettings: () => FlatSettings
  now: () => string
  /** Enabled provider connections (the unresolvable-ref error's list). */
  providers: () => ProviderConnection[]
  /** Model-ref resolution (the unresolvable-ref check). */
  modelResolver: ModelResolver
  /** The scheduler lifecycle verbs drive agents through the kernel. */
  kernel: AgentKernel
  /** The launch entry (start / reset spawns the orchestrator through it). */
  spawnService: SpawnService
  engine: DecisionPointEngine
  queue: QueueService
  notices: NoticePublisher
  /** Fleet digest context (see scheduler-digest.ts) — created once by the
   * composition facade (the decision-point engine renders the same one). */
  digest: SchedulerDigest
  platformService: ReturnType<typeof createPlatformService>
  /** Delete one agent (the reset:true path) — the composition facade's
   * delete (settle + channel sweep + the agent.deleted fact). */
  deleteAgent(agentId: string): Promise<void>
}

/**
 * Scheduler policy + status reads and the scheduler-agent lifecycle face
 * (start/pause/resume/close + the event halt/resume levers — moved here
 * from the old service when it dissolved into the composition facade).
 * The digest context is injected (one instance, shared with the
 * decision-point engine); the lifecycle verbs assemble after the kernel
 * they drive.
 */
export function createSchedulerAdmin(deps: SchedulerAdminDeps) {
  const { db, queries, getSettings, now, providers, modelResolver, digest } =
    deps

  /** All model refs addressable right now (enabled providers × enabled
   * models) — the unresolvable-ref error text. Derived from providers(); refs
   * are shown without the optional :effort suffix. */
  function availableModelRefs(): string[] {
    const refs: string[] = []
    for (const provider of providers()) {
      if (!provider.enabled || !provider.apiKey) continue
      for (const model of provider.models) {
        if (model.enabled) refs.push(modelAddress(provider, model))
      }
    }
    return refs
  }

  /** Reject an unresolvable model ref (enqueue/spawn) with an error listing
   * every currently-available ref so the model can correct itself. */
  function assertModelsResolvable(model: string | undefined): void {
    if (!model) return
    if (modelResolver.resolveModelTarget(model)) return
    throw new RunActionError(
      "invalid",
      `Model "${model}" is not available. Available models: ${
        availableModelRefs().join(", ") || "(none)"
      }`
    )
  }

  /** Set / extend / shorten an agent's hard deadline: the agent.deadline_armed
   * fact (its projection persists the deadline). Re-arming the timer is the
   * caller's (service) job. Usable on terminal agents (pre-sets the deadline
   * for the next reopen). */
  function setAgentTimeout(
    agentId: string,
    timeoutMs: number,
    actor: DomainEventActor
  ): AgentSummary {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error("timeoutMs must be positive")
    }
    const row = queries.getAgentRow(agentId)
    if (!row) throw new Error("Agent not found")
    emitDomainEvent(db, {
      type: "agent.deadline_armed",
      eventId: row.eventId,
      challengeId: row.challengeId,
      agentId,
      actor,
      payload: {
        deadlineAt: new Date(Date.now() + timeoutMs).toISOString(),
        timeoutMs,
        at: now(),
      },
    })
    const agent = queries.getAgent(agentId)
    if (!agent) throw new Error("Agent not found")
    return agent
  }

  /** Fence snapshot augmented with active agent details (challenge names). */
  function getStatusSnapshot(eventId: string): SchedulerStatusSnapshot {
    const snap = fenceSnapshot(db, getSettings(), eventId)
    const active = db
      .select({
        id: agents.id,
        challengeId: agents.challengeId,
        status: agents.status,
      })
      .from(agents)
      .where(inArray(agents.status, LIVE_AGENT_STATUSES))
      .all()
    // One prefetch for all challenge names instead of a SELECT per agent.
    const challengeIds = [
      ...new Set(
        active
          .map((row) => row.challengeId)
          .filter((id): id is string => id !== null)
      ),
    ]
    const names = new Map<string, string>()
    if (challengeIds.length > 0) {
      const rows = db
        .select({ id: challenges.id, name: challenges.name })
        .from(challenges)
        .where(inArray(challenges.id, challengeIds))
        .all()
      for (const row of rows) names.set(row.id, row.name)
    }
    const activeAgents = active.map((row) => ({
      id: row.id,
      challengeId: row.challengeId,
      challengeName: row.challengeId ? (names.get(row.challengeId) ?? "") : "",
      status: row.status,
    }))
    return { ...snap, activeAgents }
  }

  /** The scheduler agent row, if any. */
  function getSchedulerAgent(eventId: string): AgentSummary | undefined {
    const row = queries.schedulerAgentRow(eventId)
    return row ? queries.getAgent(row.id) : undefined
  }

  /** Read the event's scheduler policy (defaults if unset). `paused` gates
   * the event's agent-lifecycle events (W3). The policy knobs resolve
   * via schedulerPolicyFor (single source of defaults). */
  function getSchedulerConfig(eventId: string): {
    eventId: string
    modelId: string | null
    instruction: string
    maxConcurrentTargets: number
    paused: boolean
  } & SchedulerPolicy {
    const row = db
      .select()
      .from(schedulerConfig)
      .where(eq(schedulerConfig.eventId, eventId))
      .get()
    return {
      eventId,
      modelId: row?.modelId ?? null,
      instruction: row?.instruction ?? "",
      maxConcurrentTargets: row?.maxConcurrentTargets ?? 1,
      paused: row?.paused ?? false,
      ...schedulerPolicyFor(db, eventId),
    }
  }

  /** Write the paused flag (upsert — also creates a default config row).
   * Writable with no scheduler agent, so pause/resume can preset the next
   * start. */
  function setSchedulerPaused(eventId: string, paused: boolean): void {
    const ts = now()
    const existing = db
      .select()
      .from(schedulerConfig)
      .where(eq(schedulerConfig.eventId, eventId))
      .get()
    if (existing) {
      db.update(schedulerConfig)
        .set({ paused, updatedAt: ts })
        .where(eq(schedulerConfig.eventId, eventId))
        .run()
    } else {
      db.insert(schedulerConfig)
        .values({
          eventId,
          modelId: null,
          instruction: "",
          maxConcurrentTargets: 1,
          paused,
          createdAt: ts,
          updatedAt: ts,
        })
        .run()
    }
  }

  /** Whether the event's scheduler is paused (the agent-event emit gate). */
  function isSchedulerPaused(eventId: string): boolean {
    const row = db
      .select({ paused: schedulerConfig.paused })
      .from(schedulerConfig)
      .where(eq(schedulerConfig.eventId, eventId))
      .get()
    return row?.paused ?? false
  }

  /** Upsert the event's scheduler policy (creates with defaults if missing). */
  function upsertSchedulerConfig(patch: {
    eventId: string
    modelId?: string | null
    instruction?: string
    maxConcurrentTargets?: number
    notifyTeamOnFlag?: boolean
    stopSiblingsOnSolve?: boolean
    stopTargetOnSolve?: boolean
    stopSubmitterOnSolve?: boolean
    nextTaskPolicy?: NextTaskPolicy
    urgentTeamMessages?: boolean
    blockSpawnOnSolved?: boolean
  }) {
    const ts = now()
    const existing = db
      .select()
      .from(schedulerConfig)
      .where(eq(schedulerConfig.eventId, patch.eventId))
      .get()
    if (existing) {
      const update: Partial<typeof schedulerConfig.$inferInsert> = {
        updatedAt: ts,
      }
      if (patch.modelId !== undefined) update.modelId = patch.modelId
      if (patch.instruction !== undefined)
        update.instruction = patch.instruction
      if (patch.maxConcurrentTargets !== undefined) {
        update.maxConcurrentTargets = patch.maxConcurrentTargets
      }
      if (patch.notifyTeamOnFlag !== undefined)
        update.notifyTeamOnFlag = patch.notifyTeamOnFlag
      if (patch.stopSiblingsOnSolve !== undefined)
        update.stopSiblingsOnSolve = patch.stopSiblingsOnSolve
      if (patch.stopTargetOnSolve !== undefined)
        update.stopTargetOnSolve = patch.stopTargetOnSolve
      if (patch.stopSubmitterOnSolve !== undefined)
        update.stopSubmitterOnSolve = patch.stopSubmitterOnSolve
      if (patch.nextTaskPolicy !== undefined)
        update.nextTaskPolicy = patch.nextTaskPolicy
      if (patch.urgentTeamMessages !== undefined)
        update.urgentTeamMessages = patch.urgentTeamMessages
      if (patch.blockSpawnOnSolved !== undefined)
        update.blockSpawnOnSolved = patch.blockSpawnOnSolved
      db.update(schedulerConfig)
        .set(update)
        .where(eq(schedulerConfig.eventId, patch.eventId))
        .run()
    } else {
      db.insert(schedulerConfig)
        .values({
          eventId: patch.eventId,
          modelId: patch.modelId ?? null,
          instruction: patch.instruction ?? "",
          maxConcurrentTargets: patch.maxConcurrentTargets ?? 1,
          notifyTeamOnFlag: patch.notifyTeamOnFlag ?? true,
          stopSiblingsOnSolve: patch.stopSiblingsOnSolve ?? true,
          stopTargetOnSolve: patch.stopTargetOnSolve ?? true,
          stopSubmitterOnSolve: patch.stopSubmitterOnSolve ?? false,
          nextTaskPolicy: patch.nextTaskPolicy ?? "eager",
          urgentTeamMessages: patch.urgentTeamMessages ?? true,
          blockSpawnOnSolved: patch.blockSpawnOnSolved ?? true,
          createdAt: ts,
          updatedAt: ts,
        })
        .run()
    }
    return getSchedulerConfig(patch.eventId)
  }

  // --- scheduler (event orchestrator) lifecycle -------------------------------

  function requireAgent(agentId: string): AgentSummary {
    const agent = queries.getAgent(agentId)
    if (!agent) throw new RunActionError("not_found", "Agent not found")
    return agent
  }

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
    return deps.kernel.chain(`start:${eventId}`, async () => {
      const config = getSchedulerConfig(eventId)
      const existing = getSchedulerAgent(eventId)
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
        setSchedulerPaused(eventId, false)
        deps.engine.trigger(eventId, {
          kind: "user.directive",
          source: "resume",
          revive: true,
        })
        return requireAgent(existing.id)
      }
      if (existing && opts.reset) {
        await deps.deleteAgent(existing.id)
      }
      setSchedulerPaused(eventId, false)
      const agentId = await deps.spawnService.launch({
        eventId,
        challengeId: null,
        role: "orchestrator",
        source: "manual",
        // Orchestrators bypass the spawn fence — the actor only labels the
        // spawn (never a fence.blocked fact).
        model: config.modelId ?? undefined,
        instruction: config.instruction,
        actor: { kind: "system", actorId: "scheduler-admin" },
      })
      return requireAgent(agentId)
    })
  }

  /** Disable the scheduler (W3): set paused=1 (the event gate drops its
   * agent-lifecycle notifications) + abort the current turn (the sandbox
   * stays warm — the scheduler agent stays idle, not terminal). */
  async function pauseScheduler(eventId: string): Promise<AgentSummary | null> {
    setSchedulerPaused(eventId, true)
    const sched = getSchedulerAgent(eventId)
    if (sched && isActiveAgentStatus(sched.status)) {
      await deps.kernel.abort(sched.id)
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
    setSchedulerPaused(eventId, false)
    const sched = getSchedulerAgent(eventId)
    if (sched && isActiveAgentStatus(sched.status)) {
      deps.engine.trigger(eventId, {
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
    const sched = getSchedulerAgent(eventId)
    if (!sched) throw new RunActionError("not_found", "No scheduler agent")
    await deps.kernel.closeAgent(sched.id, {
      kind: "system",
      actorId: "system",
    })
    return requireAgent(sched.id)
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
      await deps.kernel
        .closeAgent(row.id, { kind: "system", actorId: "system" })
        .then(() => {
          closedCount += 1
        })
        .catch(() => undefined)
    }
    const cancelled = deps.queue.cancelPendingForChallenge(
      challenge.eventId,
      challengeId
    )
    if (isTargetCapable(getChallengeRemote(db, challengeId))) {
      void deps.platformService
        .targetAction(challengeId, "stop")
        .catch(() => undefined)
    }
    if (closedCount > 0 || cancelled > 0) {
      deps.notices.publish({
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
      await deps.kernel
        .closeAgent(row.id, { kind: "system", actorId: "system" })
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
    deps.queue.pause(eventId, "manual", principal)
    await pauseScheduler(eventId)
    const solverClosed = await closeEventAgents(eventId, principal)
    const targets = await deps.platformService.stopEventTargets(eventId)
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
    deps.queue.resume(eventId, "manual", principal)
    deps.queue.scheduleDrain()
  }

  return {
    assertModelsResolvable,
    setAgentTimeout,
    getStatusSnapshot,
    getDigestContext: digest.getDigestContext,
    getSchedulerAgent,
    getSchedulerConfig,
    upsertSchedulerConfig,
    setSchedulerPaused,
    isSchedulerPaused,
    startScheduler,
    pauseScheduler,
    resumeScheduler,
    closeScheduler,
    haltChallenge,
    closeEventAgents,
    haltEvent,
    resumeEvent,
  }
}
