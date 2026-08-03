import { eq } from "drizzle-orm"
import type { createDatabase } from "../db"
import { challengeRemote } from "../db/schema"

type Database = ReturnType<typeof createDatabase>["db"]
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
