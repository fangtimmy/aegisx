import { get, type FlatSettings } from "@aegisx/shared"
import { and, eq, sql } from "drizzle-orm"

import type { createDatabase } from "../db"
import {
  challengeFlags,
  challengeRemote,
  challenges,
  runs,
  schedulerConfig,
} from "../db/schema"

type Database = ReturnType<typeof createDatabase>["db"]

export type FenceDecision =
  | { ok: true }
  | { ok: false; code: "global_capacity" | "target_slots"; message: string }

/** A candidate run whose launch the fence must admit. Event-scope (scheduler)
 * runs never count and are never blocked; challenge-scope runs are checked. */
export type FenceCandidate = {
  scopeType: "challenge" | "event"
  eventId: string
  /** The challenge being attacked (challenge-scope only). */
  challengeId?: string | null
}

/** Default global cap when the setting is somehow absent. */
const DEFAULT_MAX_CONCURRENT_RUNS = 4
/** Default per-event target cap when no scheduler_config row exists. */
const DEFAULT_MAX_CONCURRENT_TARGETS = 1

/** Read the global challenge-run concurrency cap from settings. */
export function maxConcurrentRunsSetting(settings: FlatSettings): number {
  return get(settings, "scheduler.maxConcurrentRuns")
}

/** A read-only snapshot of the fence state for one event (the scheduler's
 * get_status tool + the status route). `runningCount` is global; the target
 * figures are per-event. */
export function fenceSnapshot(
  db: Database,
  settings: FlatSettings,
  eventId: string
): {
  maxConcurrentRuns: number
  runningCount: number
  maxConcurrentTargets: number
  activeTargetChallenges: string[]
} {
  return {
    maxConcurrentRuns: maxConcurrentRunsSetting(settings),
    runningCount: runningChallengeRunCount(db),
    maxConcurrentTargets: maxConcurrentTargetsFor(db, eventId),
    activeTargetChallenges: [...activeTargetSlots(db, eventId)],
  }
}

/** Count challenge-scope runs currently `running` (spec §8.2: only running
 * counts — idle keeps a warm container but consumes no compute slot; scheduler
 * runs never count). */
function runningChallengeRunCount(db: Database): number {
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(runs)
    .where(and(eq(runs.scopeType, "challenge"), eq(runs.status, "running")))
    .get()
  return row?.n ?? 0
}

/** Distinct target-capable AND unsolved challenges with a running run in this
 * event (spec §8.2: "different target-capable challenges under attack"). Solved
 * challenges free their slot; the same challenge attacked by several runs
 * shares one slot (DISTINCT). */
function activeTargetSlots(db: Database, eventId: string): Set<string> {
  const rows = db
    .select({ challengeId: runs.challengeId })
    .from(runs)
    .innerJoin(challenges, eq(challenges.id, runs.challengeId))
    .innerJoin(challengeRemote, eq(challengeRemote.challengeId, challenges.id))
    .where(
      and(
        eq(runs.scopeType, "challenge"),
        eq(runs.status, "running"),
        eq(runs.eventId, eventId),
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
 * Decide whether a candidate run may launch under the concurrency fence
 * (spec §8.2). Two independent caps:
 *
 *  1. Global: challenge-scope running runs ≤ `scheduler.maxConcurrentRuns`.
 *  2. Per-event: distinct target-capable unsolved challenges under attack ≤
 *     `scheduler_config.maxConcurrentTargets`. The candidate shares its slot
 *     if its challenge is already under attack; otherwise it adds one.
 *
 * Scheduler (event-scope) runs are always admitted — they neither count nor
 * consume slots. Pure (reads only); the caller wraps check + launch in the
 * global fence lock for atomicity.
 */
export function checkLaunchFence(
  db: Database,
  settings: FlatSettings,
  candidate: FenceCandidate
): FenceDecision {
  if (candidate.scopeType === "event") return { ok: true }

  const cap = maxConcurrentRunsSetting(settings)
  const running = runningChallengeRunCount(db)
  if (running + 1 > cap) {
    return {
      ok: false,
      code: "global_capacity",
      message: `Concurrency cap reached (${running}/${cap} challenge runs running). Close or wait for a run to free a slot.`,
    }
  }

  const challengeId = candidate.challengeId
  if (challengeId && occupiesTargetSlot(db, challengeId)) {
    const maxTargets = maxConcurrentTargetsFor(db, candidate.eventId)
    const active = activeTargetSlots(db, candidate.eventId)
    // The candidate's run does not exist yet, so it is never in the active set
    // unless another run is already attacking the same challenge (shared slot).
    if (!active.has(challengeId) && active.size + 1 > maxTargets) {
      return {
        ok: false,
        code: "target_slots",
        message: `Target-slot cap reached for this event (${active.size}/${maxTargets} distinct targets under attack). Close a run on another target first.`,
      }
    }
  }
  return { ok: true }
}
