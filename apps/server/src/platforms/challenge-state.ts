import { and, eq, ne } from "drizzle-orm"

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
      manual: challenges.manualSolveState,
    })
    .from(challenges)
    .leftJoin(challengeRemote, eq(challengeRemote.challengeId, challenges.id))
    .where(eq(challenges.id, challengeId))
    .get()
  if (!row) return false
  if (row.remoteSolved || row.manual === "solved") return true
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
