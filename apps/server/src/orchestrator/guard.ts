import { and, eq } from "drizzle-orm"

import type { createDatabase } from "../db"
import { challengeRemote, challenges, runs } from "../db/schema"
import { isTargetCapable } from "../platforms/challenge-state"

type Database = ReturnType<typeof createDatabase>["db"]

export type GuardLimits = {
  /** Global cap on simultaneously running solver runs (local resources). */
  maxConcurrentRuns: number
  /** Per-event cap on target-capable challenges running at once (platform limit). */
  maxConcurrentTargets: number
}

export type GuardVerdict = { ok: true } | { ok: false; reason: string }

/**
 * Hard guardrails the orchestrator (and the `start_run` tool) cannot violate.
 * These are physical / logical constraints that fail noisily if exceeded:
 *
 *   1. global running runs ≤ maxConcurrentRuns (local container resources)
 *   2. target-capable challenges running ≤ maxConcurrentTargets (platform limit)
 *   3. a challenge that already has a running run cannot be started again
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

  // (3) No second run while another for the same challenge is running.
  const activeForChallenge = db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.challengeId, challengeId), eq(runs.status, "running")))
    .get()
  if (activeForChallenge) {
    return { ok: false, reason: "This challenge already has a running run" }
  }

  // (1) Global running-run cap.
  const runningCount = countRunningRuns(db)
  if (runningCount >= limits.maxConcurrentRuns) {
    return {
      ok: false,
      reason: `Concurrency full (${runningCount}/${limits.maxConcurrentRuns} running runs)`,
    }
  }

  // (2) Target-capable concurrency (platform instance limit). Conservative
  // accounting: a running run on a target-capable, unsolved challenge holds a
  // target slot, because the solver starts its target lazily mid-run.
  if (isTargetCapable(row.remote ?? undefined) && !row.remote?.solved) {
    const inflightTargets = countTargetRuns(db, eventId)
    if (inflightTargets >= limits.maxConcurrentTargets) {
      return {
        ok: false,
        reason: `Target slots full (${inflightTargets}/${limits.maxConcurrentTargets} target-capable challenges running)`,
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
 * Per-event count of running runs on target-capable, unsolved challenges
 * (guardrail 2 + status tool). Conservative: counts any running run whose
 * challenge could hold a target slot.
 */
export function countTargetRuns(db: Database, eventId: string): number {
  const rows = db
    .select({ remote: challengeRemote })
    .from(runs)
    .innerJoin(challenges, eq(runs.challengeId, challenges.id))
    .leftJoin(challengeRemote, eq(challenges.id, challengeRemote.challengeId))
    .where(and(eq(runs.status, "running"), eq(challenges.eventId, eventId)))
    .all()
  return rows.filter(
    (r) => r.remote !== null && isTargetCapable(r.remote) && !r.remote.solved
  ).length
}
