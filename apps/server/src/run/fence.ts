import { get, type FlatSettings } from "@aegisx/shared"
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm"

import type { Database } from "../db"
import {
  agents,
  challengeFlags,
  challengeRemote,
  challenges,
  schedulerConfig,
} from "../db/schema"

export type FenceDecision =
  | { ok: true }
  | { ok: false; code: "global_capacity" | "target_slots"; message: string }

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
  activeTargetChallenges: string[]
} {
  return {
    maxConcurrentAgents: maxConcurrentAgentsSetting(settings),
    liveAgentCount: liveSolverAgentCount(db),
    maxConcurrentTargets: maxConcurrentTargetsFor(db, eventId),
    activeTargetChallenges: [...activeTargetSlots(db, eventId)],
  }
}

/** Count live solver agents (running + idle, challengeId set). Idle keeps a
 * warm session and its target may still run on the platform, so it consumes
 * a concurrency slot until terminal. The scheduler agent never counts. */
export function liveSolverAgentCount(db: Database): number {
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(agents)
    .where(
      and(
        isNotNull(agents.challengeId),
        inArray(agents.status, ["running", "idle"])
      )
    )
    .get()
  return row?.n ?? 0
}

/** Distinct target-capable AND unsolved challenges with a LIVE agent in this
 * event. Solved challenges free their slot; the same challenge attacked by
 * several agents shares one slot (DISTINCT). */
function activeTargetSlots(db: Database, eventId: string): Set<string> {
  const rows = db
    .select({ challengeId: agents.challengeId })
    .from(agents)
    .innerJoin(challenges, eq(challenges.id, agents.challengeId))
    .innerJoin(challengeRemote, eq(challengeRemote.challengeId, challenges.id))
    .where(
      and(
        eq(agents.eventId, eventId),
        inArray(agents.status, ["running", "idle"]),
        eq(challengeRemote.available, true),
        eq(challengeRemote.targetSupported, true),
        eq(challengeRemote.targetIgnored, false),
        eq(challengeRemote.solved, false),
        eq(challenges.manualSolveState, "unsolved"),
        // No accepted flag → still unsolved.
        sql`NOT EXISTS (SELECT 1 FROM ${challengeFlags} WHERE ${challengeFlags.challengeId} = ${challenges.id} AND ${challengeFlags.status} = 'accepted')`
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

/** Whether a challenge would occupy a target slot: target-capable AND unsolved. */
function occupiesTargetSlot(db: Database, challengeId: string): boolean {
  const row = db
    .select({
      available: challengeRemote.available,
      targetSupported: challengeRemote.targetSupported,
      targetIgnored: challengeRemote.targetIgnored,
      solved: challengeRemote.solved,
      manualSolveState: challenges.manualSolveState,
    })
    .from(challengeRemote)
    .innerJoin(challenges, eq(challenges.id, challengeRemote.challengeId))
    .where(eq(challengeRemote.challengeId, challengeId))
    .get()
  if (!row) return false
  if (!row.available || !row.targetSupported || row.targetIgnored) return false
  if (row.solved) return false
  if (row.manualSolveState !== "unsolved") return false
  const accepted = db
    .select({ id: challengeFlags.id })
    .from(challengeFlags)
    .where(
      and(
        eq(challengeFlags.challengeId, challengeId),
        eq(challengeFlags.status, "accepted")
      )
    )
    .get()
  return !accepted
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
  if (occupiesTargetSlot(db, challengeId)) {
    const maxTargets = maxConcurrentTargetsFor(db, candidate.eventId)
    const active = activeTargetSlots(db, candidate.eventId)
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
