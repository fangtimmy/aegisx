import { eq } from "drizzle-orm"

import type { Database } from "../db"
import { challengeRemote } from "../db/schema"

export type ChallengeRemote = typeof challengeRemote.$inferSelect

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
