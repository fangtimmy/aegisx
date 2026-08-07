import { and, eq } from "drizzle-orm"

import type { createDatabase } from "../db"
import { challengeRemote, challenges, runs } from "../db/schema"
import { isTargetCapable } from "../platforms/challenge-state"

type Database = ReturnType<typeof createDatabase>["db"]

export type GuardLimits = {
  /** Global cap on simultaneously running solver runs (local resources). */
  maxConcurrentRuns: number
  /** Per-event cap on DISTINCT target-capable challenges attacked at once
   * (platform target-instance limit). Multiple runs on the same challenge
   * share one slot. */
  maxConcurrentTargets: number
}

export type GuardVerdict = { ok: true } | { ok: false; reason: string }

/**
 * Hard guardrails the orchestrator (and the `start_run` tool) cannot violate.
 * These are physical / logical constraints that fail noisily if exceeded:
 *
 *   1. global running runs ≤ maxConcurrentRuns (local container resources)
 *   2. DISTINCT target-capable challenges running ≤ maxConcurrentTargets
 *      (platform target-instance limit). A target is a per-challenge instance;
 *      multiple runs on the same target-capable challenge share one slot.
 *
 * Preference-style filters (already-solved, excluded, priority) are
 * intentionally NOT enforced here — those belong to the orchestrator's
 * instruction, per docs/orchestrator.md §三.
 *
 * On violation the verdict carries a human-readable reason so the orchestrator
 * (an LLM) can adjust its plan rather than hit a hard error.
 */
export function canLaunchRun(
  db: Database,
  eventId: string,
  challengeId: string,
  limits: GuardLimits
): GuardVerdict {
  const row = db
    .select({ challenge: challenges, remote: challengeRemote })
    .from(challenges)
    .leftJoin(challengeRemote, eq(challenges.id, challengeRemote.challengeId))
    .where(eq(challenges.id, challengeId))
    .get()
  if (!row) return { ok: false, reason: "Challenge not found" }
  if (row.challenge.eventId !== eventId) {
    return { ok: false, reason: "Challenge does not belong to this event" }
  }

  // (1) Global running-run cap.
  const runningCount = countRunningRuns(db)
  if (runningCount >= limits.maxConcurrentRuns) {
    return {
      ok: false,
      reason: `Concurrency full (${runningCount}/${limits.maxConcurrentRuns} running runs)`,
    }
  }

  // (2) Target-capable concurrency, counted as DISTINCT challenges. Launching
  // another run on a challenge that already has a running run does NOT consume
  // a new target slot (it shares the same target instance) — only a run on a
  // target-capable challenge with no other running run adds a slot.
  if (isTargetCapable(row.remote ?? undefined) && !row.remote?.solved) {
    const hasRunning = db
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.challengeId, challengeId), eq(runs.status, "running")))
      .get()
    if (!hasRunning) {
      const activeTargets = countTargetChallenges(db, eventId)
      if (activeTargets >= limits.maxConcurrentTargets) {
        return {
          ok: false,
          reason: `Target slots full (${activeTargets}/${limits.maxConcurrentTargets} target-capable challenges running)`,
        }
      }
    }
  }

  return { ok: true }
}

/** Global count of running solver runs (guardrail 1 + status tool). */
export function countRunningRuns(db: Database): number {
  return db
    .select({ id: runs.id })
    .from(runs)
    .where(eq(runs.status, "running"))
    .all().length
}

/**
 * Per-event count of DISTINCT target-capable, unsolved challenges with at
 * least one running run (guardrail 2 + status tool). A target is a
 * per-challenge platform instance, so N parallel runs on one such challenge
 * count as 1 here.
 */
export function countTargetChallenges(db: Database, eventId: string): number {
  const rows = db
    .select({
      challengeId: runs.challengeId,
      remote: challengeRemote,
    })
    .from(runs)
    .innerJoin(challenges, eq(runs.challengeId, challenges.id))
    .leftJoin(challengeRemote, eq(challenges.id, challengeRemote.challengeId))
    .where(and(eq(runs.status, "running"), eq(challenges.eventId, eventId)))
    .all()
  const distinct = new Set<string>()
  for (const r of rows) {
    if (r.remote && isTargetCapable(r.remote) && !r.remote.solved) {
      distinct.add(r.challengeId)
    }
  }
  return distinct.size
}
