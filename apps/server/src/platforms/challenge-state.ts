import { and, eq, ne, sql } from "drizzle-orm"

import type { Database } from "../db"
import { challengeFlags, challengeRemote, challenges } from "../db/schema"

export type ChallengeRemote = typeof challengeRemote.$inferSelect

/** The single fully-solved predicate: any accepted flag, a remote solve
 * verdict, or the user's manual solve state. Shared by the spawn fence, the
 * acceptance tiers, and the queue views. */
export function fullySolved(db: Database, challengeId: string): boolean {
  return fullySolvedAsideFromFlag(db, challengeId, null)
}

/** The same predicate ignoring one flag value — decides an acceptance's
 * tier from the state BEFORE this submission's own row counts (the persist
 * may have landed already). */
export function fullySolvedAsideFromFlag(
  db: Database,
  challengeId: string,
  flag: string | null
): boolean {
  const row = db
    .select({
      remoteSolved: challengeRemote.solved,
      remoteAvailable: challengeRemote.available,
      remoteId: challengeRemote.remoteId,
      manual: challenges.manualSolveState,
    })
    .from(challenges)
    .leftJoin(challengeRemote, eq(challengeRemote.challengeId, challenges.id))
    .where(eq(challenges.id, challengeId))
    .get()
  if (!row) return false
  if (row.remoteSolved || row.manual === "solved") return true
  // A platform-integrated challenge's verdict belongs to the platform:
  // accepted local flag rows can be multi-flag PARTIALS (the platform only
  // reports the challenge solved on the last flag), so "an accepted flag
  // exists" must not read as fully solved — that would classify the final
  // flag as an extra value and skip the solve cleanup. Non-integrated
  // challenges have no platform verdict, so there an accepted flag IS the
  // full local verdict.
  if (row.remoteId && row.remoteAvailable) return false
  return (
    db
      .select({ id: challengeFlags.id })
      .from(challengeFlags)
      .where(
        and(
          eq(challengeFlags.challengeId, challengeId),
          eq(challengeFlags.status, "accepted"),
          ...(flag === null ? [] : [ne(challengeFlags.flag, flag)])
        )
      )
      .get() !== undefined
  )
}

/** The fully-solved rule as SQL over `challenges LEFT JOIN challenge_remote`,
 * for read-side aggregations (event summaries): a remote verdict or the
 * manual state settles it, and an accepted local flag counts only where no
 * platform verdict exists — integrated challenges' accepted rows can be
 * multi-flag partials. */
export const fullySolvedSql = sql`(${challengeRemote.solved} = 1 or ${challenges.manualSolveState} != 'unsolved' or ((${challengeRemote.remoteId} is null or ${challengeRemote.available} = 0) and exists (select 1 from ${challengeFlags} where ${challengeFlags.challengeId} = ${challenges.id} and ${challengeFlags.status} = 'accepted')))`

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

export function isPlatformIntegrated(
  remote: ChallengeRemote | null | undefined
): remote is ChallengeRemote {
  return Boolean(remote?.remoteId && remote?.available)
}

export function isTargetCapable(
  remote: ChallengeRemote | null | undefined
): remote is ChallengeRemote {
  return Boolean(
    remote?.available && remote?.targetSupported && !remote?.targetIgnored
  )
}
