import { get, LIVE_AGENT_STATUSES, type FlatSettings } from "@aegisx/shared"
import type { NextTaskPolicy } from "@aegisx/shared/scheduler"
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm"

import type { Database } from "../db"
import {
  agents,
  challengeFlags,
  challengeRemote,
  challenges,
  schedulerConfig,
} from "../db/schema"
import { fullySolved } from "../platforms/challenge-state"
import { schedulerPolicyFor } from "./scheduler-policy"

export type FenceDecision =
  | { ok: true }
  | {
      ok: false
      code: "global_capacity" | "target_slots" | "challenge_solved"
      message: string
    }

/** Default per-event target cap when no scheduler_config row exists. */
const DEFAULT_MAX_CONCURRENT_TARGETS = 1

/** Read the global live-solver-agent cap from settings. */
export function maxConcurrentAgentsSetting(settings: FlatSettings): number {
  return get(settings, "scheduler.maxConcurrentAgents")
}

/** A read-only snapshot of the fence state for one event (the scheduler's
 * status tool + the status route). `liveAgentCount` is global; the target
 * figures are per-event. */
export function fenceSnapshot(
  db: Database,
  settings: FlatSettings,
  eventId: string
): {
  maxConcurrentAgents: number
  liveAgentCount: number
  maxConcurrentTargets: number
  nextTaskPolicy: NextTaskPolicy
  activeTargetChallenges: string[]
} {
  const policy = schedulerPolicyFor(db, eventId)
  return {
    maxConcurrentAgents: maxConcurrentAgentsSetting(settings),
    liveAgentCount: liveSolverAgentCount(db),
    maxConcurrentTargets: maxConcurrentTargetsFor(db, eventId),
    nextTaskPolicy: policy.nextTaskPolicy,
    activeTargetChallenges: [
      ...activeTargetSlots(db, eventId, policy.nextTaskPolicy === "drained"),
    ],
  }
}

/** Count live solver agents (running + idle, challengeId set). Idle keeps a
 * warm session and its target may still run on the platform, so it consumes
 * a concurrency slot until terminal. The scheduler agent never counts. */
function liveSolverAgentCount(db: Database): number {
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(agents)
    .where(
      and(
        isNotNull(agents.challengeId),
        inArray(agents.status, LIVE_AGENT_STATUSES)
      )
    )
    .get()
  return row?.n ?? 0
}

/** Distinct target-capable challenges with a LIVE agent in this event,
 * under the event's next-task policy. 'eager' (default): a solved challenge
 * frees its slot at flag acceptance, so solved/flagged challenges are
 * excluded. 'drained': a solved challenge HOLDS its slot until its last
 * agent goes terminal (strict serialization). The same challenge attacked
 * by several agents shares one slot (DISTINCT). */
function activeTargetSlots(
  db: Database,
  eventId: string,
  drained: boolean
): Set<string> {
  const rows = db
    .select({ challengeId: agents.challengeId })
    .from(agents)
    .innerJoin(challenges, eq(challenges.id, agents.challengeId))
    .innerJoin(challengeRemote, eq(challengeRemote.challengeId, challenges.id))
    .where(
      and(
        eq(agents.eventId, eventId),
        inArray(agents.status, LIVE_AGENT_STATUSES),
        eq(challengeRemote.available, true),
        eq(challengeRemote.targetSupported, true),
        eq(challengeRemote.targetIgnored, false),
        ...(drained
          ? []
          : [
              eq(challengeRemote.solved, false),
              eq(challenges.manualSolveState, "unsolved"),
              // No accepted flag → still unsolved.
              sql`NOT EXISTS (SELECT 1 FROM ${challengeFlags} WHERE ${challengeFlags.challengeId} = ${challenges.id} AND ${challengeFlags.status} = 'accepted')`,
            ])
      )
    )
    .all()
  return new Set(
    rows.map((row) => row.challengeId).filter((v): v is string => !!v)
  )
}

/** Per-event target-slot cap from scheduler_config (default when unset). */
function maxConcurrentTargetsFor(db: Database, eventId: string): number {
  const row = db
    .select({ max: schedulerConfig.maxConcurrentTargets })
    .from(schedulerConfig)
    .where(eq(schedulerConfig.eventId, eventId))
    .get()
  return row?.max ?? DEFAULT_MAX_CONCURRENT_TARGETS
}

/** Whether a challenge would occupy a target slot: target-capable, and
 * still fighting for it under the policy ('eager': a solved challenge never
 * occupies; 'drained': any target-capable challenge with a live agent
 * does). */
function occupiesTargetSlot(
  db: Database,
  challengeId: string,
  drained: boolean
): boolean {
  if (drained) {
    const row = db
      .select({
        available: challengeRemote.available,
        targetSupported: challengeRemote.targetSupported,
        targetIgnored: challengeRemote.targetIgnored,
      })
      .from(challengeRemote)
      .where(eq(challengeRemote.challengeId, challengeId))
      .get()
    return Boolean(
      row?.available && row?.targetSupported && !row?.targetIgnored
    )
  }
  const row = db
    .select({
      available: challengeRemote.available,
      targetSupported: challengeRemote.targetSupported,
      targetIgnored: challengeRemote.targetIgnored,
    })
    .from(challengeRemote)
    .where(eq(challengeRemote.challengeId, challengeId))
    .get()
  if (!row) return false
  if (!row.available || !row.targetSupported || row.targetIgnored) return false
  return !fullySolved(db, challengeId)
}

/**
 * Decide whether a solver agent may spawn under the concurrency fence.
 * Two independent caps:
 *
 *  1. Global: live solver agents (running + idle — idle keeps a warm session)
 *     ≤ `scheduler.maxConcurrentAgents`.
 *  2. Per-event: distinct target-capable unsolved challenges with a live
 *     agent ≤ `scheduler_config.maxConcurrentTargets`. The candidate shares
 *     its slot if its challenge already has a live agent; otherwise it adds
 *     one.
 *
 * The scheduler agent is always admitted — it neither counts nor consumes
 * slots. Pure (reads only); the caller wraps check + spawn in the global
 * fence lock for atomicity.
 */
export function checkSpawnFence(
  db: Database,
  settings: FlatSettings,
  candidate: { eventId: string; challengeId: string }
): FenceDecision {
  const policy = schedulerPolicyFor(db, candidate.eventId)
  // Solved-challenge gate: a fully-solved challenge is finished work — new
  // spawns on it are rejected (queue items are cancelled by the drainer)
  // unless the event explicitly re-opens it (reproduction / writeup agents).
  if (policy.blockSpawnOnSolved && fullySolved(db, candidate.challengeId)) {
    return {
      ok: false,
      code: "challenge_solved",
      message:
        "Challenge is already fully solved — spawning on it is blocked by this event's policy.",
    }
  }

  const cap = maxConcurrentAgentsSetting(settings)
  const live = liveSolverAgentCount(db)
  if (live + 1 > cap) {
    return {
      ok: false,
      code: "global_capacity",
      message: `Live agent cap reached (${live}/${cap} solver agents). Close or wait for an agent to free a slot.`,
    }
  }

  const challengeId = candidate.challengeId
  const drained = policy.nextTaskPolicy === "drained"
  if (occupiesTargetSlot(db, challengeId, drained)) {
    const maxTargets = maxConcurrentTargetsFor(db, candidate.eventId)
    const active = activeTargetSlots(db, candidate.eventId, drained)
    // The candidate's agent row does not exist yet, so it is never in the
    // active set unless another agent is already attacking the same
    // challenge (shared slot).
    if (!active.has(challengeId) && active.size + 1 > maxTargets) {
      return {
        ok: false,
        code: "target_slots",
        message: `Target-slot cap reached for this event (${active.size}/${maxTargets} distinct targets under attack). Close an agent on another target first.`,
      }
    }
  }
  return { ok: true }
}
