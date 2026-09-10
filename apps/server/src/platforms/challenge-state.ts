import { progressOf, type ChallengeProgress } from "@aegisx/shared"
import { and, eq, isNull, sql } from "drizzle-orm"

import type { Database } from "../db"
import { challengeFlags, challengeRemote, challenges } from "../db/schema"

export type ChallengeRemote = typeof challengeRemote.$inferSelect

/**
 * The progress state machine's DB adapter: read the flag facts, run the shared
 * pure function. This is THE definition of "how solved is this challenge" —
 * the spawn fence, the solve cleanup, the digest, the stats and the wire
 * projection all read it, so the rule cannot fork.
 */
export function progressOfChallenge(
  db: Database,
  challengeId: string
): ChallengeProgress {
  const row = db
    .select({
      points: challenges.points,
      manual: challenges.manualSolveState,
      requiredFlags: challenges.requiredFlags,
      remoteSolved: challengeRemote.solved,
      available: challengeRemote.available,
      remoteId: challengeRemote.remoteId,
    })
    .from(challenges)
    .leftJoin(challengeRemote, eq(challengeRemote.challengeId, challenges.id))
    .where(eq(challenges.id, challengeId))
    .get()
  if (!row) {
    return progressOf({
      accepted: 0,
      requiredFlags: null,
      remoteSolved: false,
      integrated: false,
      manual: "unsolved",
      points: null,
    })
  }
  const accepted = db
    .select({ id: challengeFlags.id })
    .from(challengeFlags)
    .where(
      and(
        eq(challengeFlags.challengeId, challengeId),
        eq(challengeFlags.status, "accepted")
      )
    )
    .all().length
  return progressOf({
    accepted,
    requiredFlags: row.requiredFlags,
    remoteSolved: row.remoteSolved === true,
    integrated: isPlatformIntegrated(row),
    manual: row.manual,
    points: row.points,
  })
}

/** Whether the challenge is fully solved (the fence / cleanup gate). */
export function fullySolved(db: Database, challengeId: string): boolean {
  return progressOfChallenge(db, challengeId).state === "solved"
}

/** When the challenge FIRST reached `solved` (null = never). The solve cleanup
 * keys on it: a chain later revealed to need more flags (solved → partial →
 * solved) must not run the teardown twice. */
export function challengeSolvedAt(
  db: Database,
  challengeId: string
): string | null {
  return (
    db
      .select({ solvedAt: challenges.solvedAt })
      .from(challenges)
      .where(eq(challenges.id, challengeId))
      .get()?.solvedAt ?? null
  )
}

/** Stamp the first transition into `solved`. Idempotent (guarded on
 * `solved_at IS NULL`) and a no-op while the challenge is not solved yet. */
export function stampChallengeSolvedAt(
  db: Database,
  challengeId: string,
  nowIso: string
): void {
  if (progressOfChallenge(db, challengeId).state !== "solved") return
  db.update(challenges)
    .set({ solvedAt: nowIso })
    .where(and(eq(challenges.id, challengeId), isNull(challenges.solvedAt)))
    .run()
}

/** The progress machine's SQL mirror, for read-side aggregations that must not
 * materialize every flag row (event summaries). Kept in lockstep with
 * {@link progressOf}: manual `solved` wins, manual `partial` short-circuits
 * every derived rule, then the remote verdict / local record / known count. */
export const solvedChallengeSql = sql`(${challenges.manualSolveState} = 'solved' or (${challenges.manualSolveState} <> 'partial' and (${challengeRemote.solved} = 1 or ((${challengeRemote.remoteId} is null or ${challengeRemote.available} = 0) and exists (select 1 from ${challengeFlags} where ${challengeFlags.challengeId} = ${challenges.id} and ${challengeFlags.status} = 'accepted')) or (${challengeRemote.remoteId} is not null and ${challengeRemote.available} = 1 and ${challenges.requiredFlags} is not null and (select count(*) from ${challengeFlags} where ${challengeFlags.challengeId} = ${challenges.id} and ${challengeFlags.status} = 'accepted') >= ${challenges.requiredFlags}))))`

export function getChallengeRemote(
  db: Database,
  challengeId: string
): ChallengeRemote | undefined {
  return db
    .select()
    .from(challengeRemote)
    .where(eq(challengeRemote.challengeId, challengeId))
    .get()
}

/** The ONLY source-scoped availability writer: a whole platform source's
 * mappings for ONE event flip together, always qualified by the composite
 * (eventId, sourceKey). Both call sites — platform detach and sync
 * inventory — go through here, so the P0-2 shape (a single-key WHERE that
 * silently hits other events sharing the same source) cannot be written. */
export function setSourceAvailability(
  db: Pick<Database, "update">,
  eventId: string,
  sourceKey: string,
  available: boolean
): void {
  db.update(challengeRemote)
    .set({ available })
    .where(
      and(
        eq(challengeRemote.eventId, eventId),
        eq(challengeRemote.sourceKey, sourceKey)
      )
    )
    .run()
}

/** Whether a platform verdict exists and is authoritative. Accepts the
 * leftJoin-nullable projection so a raw select row can be passed straight in. */
export function isPlatformIntegrated(
  remote:
    | { remoteId: string | null; available: boolean | null }
    | null
    | undefined
): boolean {
  return Boolean(remote?.remoteId && remote?.available)
}

export function isTargetCapable(
  remote: ChallengeRemote | null | undefined
): remote is ChallengeRemote {
  return Boolean(
    remote?.available && remote?.targetSupported && !remote?.targetIgnored
  )
}
