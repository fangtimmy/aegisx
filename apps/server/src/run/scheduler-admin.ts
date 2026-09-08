import type { AgentSummary } from "@aegisx/shared"
import {
  LIVE_AGENT_STATUSES,
  modelAddress,
  type FlatSettings,
} from "@aegisx/shared"
import type { ProviderConnection } from "@aegisx/shared/domain"
import type { SchedulerStatusSnapshot } from "@aegisx/shared/scheduler"
import { and, eq, inArray } from "drizzle-orm"

import { usageTotalsSql } from "../agents/session-queries"
import type { Database } from "../db"
import {
  agents,
  challengeFlags,
  challengeRemote,
  challenges,
  queueState,
  schedulerConfig,
  sessionEntries,
  spawnQueue,
} from "../db/schema"
import type { SchedulerDigestContext } from "../orchestration/prompt-templates"
import { fenceSnapshot } from "./fence"
import type { ModelResolver } from "./model-resolver"
import { collapseToAttempts, type AgentQueries } from "./queries"
import {
  type NextTaskPolicy,
  type SchedulerPolicy,
  schedulerPolicyFor,
} from "./scheduler-policy"

export type SchedulerAdminDeps = {
  db: Database
  queries: AgentQueries
  getSettings: () => FlatSettings
  now: () => string
  /** Enabled provider connections (the unresolvable-ref error's list). */
  providers: () => ProviderConnection[]
  /** Model-ref resolution (the unresolvable-ref check). */
  modelResolver: ModelResolver
}

export type SchedulerAdmin = ReturnType<typeof createSchedulerAdmin>

/**
 * Scheduler policy + status reads (what the HTTP routes and the spawn paths
 * call). The scheduler agent's lifecycle actions (start/pause/resume/close)
 * live in the service, which owns the factory/status/lifecycle wiring.
 */
export function createSchedulerAdmin(deps: SchedulerAdminDeps) {
  const { db, queries, getSettings, now, providers, modelResolver } = deps

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
    throw new Error(
      `Model "${model}" is not available. Available models: ${
        availableModelRefs().join(", ") || "(none)"
      }`
    )
  }

  /** Set / extend / shorten an agent's hard deadline. Persists the new
   * deadline; re-arming the timer is the caller's (service) job. Usable on
   * terminal agents (pre-sets the deadline for the next reopen). */
  function setAgentTimeout(
    agentId: string,
    timeoutMs: number,
    updateAgent: (
      agentId: string,
      patch: Partial<typeof agents.$inferInsert>
    ) => void
  ): AgentSummary {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error("timeoutMs must be positive")
    }
    const deadlineAt = new Date(Date.now() + timeoutMs).toISOString()
    updateAgent(agentId, { timeoutMs, deadlineAt, updatedAt: now() })
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

  /** Fleet digest context for scheduler deliveries (schedulerDigest
   * template): caps, queue, and one line per challenge with live agents /
   * pending items plus the invested attempts / cumulative tokens (the
   * value-per-effort inputs for diversity decisions). Advisory snapshot
   * rendered at delivery time — derive, don't cache. */
  function getDigestContext(eventId: string): SchedulerDigestContext {
    const snap = fenceSnapshot(db, getSettings(), eventId)

    const liveByChallenge = new Map<string, { live: number; running: number }>()
    for (const row of db
      .select({ challengeId: agents.challengeId, status: agents.status })
      .from(agents)
      .where(
        and(
          eq(agents.eventId, eventId),
          inArray(agents.status, LIVE_AGENT_STATUSES)
        )
      )
      .all()) {
      if (!row.challengeId) continue
      const entry = liveByChallenge.get(row.challengeId) ?? {
        live: 0,
        running: 0,
      }
      entry.live += 1
      if (row.status === "running") entry.running += 1
      liveByChallenge.set(row.challengeId, entry)
    }

    const pendingByChallenge = new Map<string, number>()
    let queueRunning = 0
    for (const row of db
      .select({
        challengeId: spawnQueue.challengeId,
        status: spawnQueue.status,
      })
      .from(spawnQueue)
      .where(eq(spawnQueue.eventId, eventId))
      .all()) {
      if (row.status === "running") queueRunning += 1
      if (row.status !== "pending") continue
      pendingByChallenge.set(
        row.challengeId,
        (pendingByChallenge.get(row.challengeId) ?? 0) + 1
      )
    }

    const acceptedByChallenge = new Map<string, number>()
    for (const row of db
      .select({ challengeId: challengeFlags.challengeId })
      .from(challengeFlags)
      .where(eq(challengeFlags.status, "accepted"))
      .all()) {
      acceptedByChallenge.set(
        row.challengeId,
        (acceptedByChallenge.get(row.challengeId) ?? 0) + 1
      )
    }

    // Real dispatch attempts per challenge (queue-item replays collapsed)
    // and the agents to bill each challenge's tokens to.
    const attemptsByChallenge = new Map<string, number>()
    const agentsByChallenge = new Map<string, string[]>()
    for (const row of collapseToAttempts(
      db.select().from(agents).where(eq(agents.eventId, eventId)).all()
    )) {
      if (!row.challengeId) continue
      attemptsByChallenge.set(
        row.challengeId,
        (attemptsByChallenge.get(row.challengeId) ?? 0) + 1
      )
      const ids = agentsByChallenge.get(row.challengeId) ?? []
      ids.push(row.id)
      agentsByChallenge.set(row.challengeId, ids)
    }

    const rows = db
      .select({
        id: challenges.id,
        name: challenges.name,
        points: challenges.points,
        manualSolveState: challenges.manualSolveState,
        remoteSolved: challengeRemote.solved,
      })
      .from(challenges)
      .leftJoin(challengeRemote, eq(challengeRemote.challengeId, challenges.id))
      .where(eq(challenges.eventId, eventId))
      .all()

    const digestChallenges = rows.flatMap((row) => {
      const live = liveByChallenge.get(row.id)
      const pending = pendingByChallenge.get(row.id) ?? 0
      if (!live && pending === 0) return []
      const manual = row.manualSolveState
      const solvedLabel =
        manual !== "unsolved"
          ? manual === "solved"
            ? "已解"
            : "部分"
          : row.remoteSolved || (acceptedByChallenge.get(row.id) ?? 0) > 0
            ? "已解"
            : "未解"
      return [
        {
          name: row.name,
          points: row.points,
          solvedLabel,
          live: live?.live ?? 0,
          running: live?.running ?? 0,
          pending,
          attempts: attemptsByChallenge.get(row.id) ?? 0,
          tokens: tokensOfChallenge(agentsByChallenge.get(row.id) ?? []),
        },
      ]
    })

    const paused =
      db
        .select({ status: queueState.status })
        .from(queueState)
        .where(eq(queueState.eventId, eventId))
        .get()?.status === "paused"

    return {
      agents: { live: snap.liveAgentCount, max: snap.maxConcurrentAgents },
      targets: {
        used: snap.activeTargetChallenges.length,
        max: snap.maxConcurrentTargets,
      },
      queue: {
        pending: [...pendingByChallenge.values()].reduce(
          (sum, count) => sum + count,
          0
        ),
        running: queueRunning,
        paused,
      },
      challenges: digestChallenges,
    }
  }

  /** Cumulative tokens spent on a challenge's agents, compact-formatted
   * ("" when nothing was spent — the digest line omits the segment). */
  function tokensOfChallenge(agentIds: string[]): string {
    if (agentIds.length === 0) return ""
    const totals = usageTotalsSql(db, inArray(sessionEntries.agentId, agentIds))
    if (totals.totalTokens <= 0) return ""
    if (totals.totalTokens >= 1_000_000) {
      return `${(totals.totalTokens / 1_000_000).toFixed(1)}M`
    }
    if (totals.totalTokens >= 1_000) {
      return `${Math.round(totals.totalTokens / 1_000)}K`
    }
    return `${Math.round(totals.totalTokens)}`
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

  /** Delete the event's scheduler agent row (reset semantics: cascade its
   * sessions). The container removal + channel sweep are the caller's job. */
  function deleteSchedulerAgent(eventId: string): void {
    db.delete(agents)
      .where(and(eq(agents.eventId, eventId), eq(agents.role, "orchestrator")))
      .run()
  }

  return {
    assertModelsResolvable,
    setAgentTimeout,
    getStatusSnapshot,
    getDigestContext,
    getSchedulerAgent,
    getSchedulerConfig,
    upsertSchedulerConfig,
    setSchedulerPaused,
    isSchedulerPaused,
    deleteSchedulerAgent,
  }
}
