import { join } from "node:path"
import { and, desc, eq, inArray } from "drizzle-orm"
import type { RunPublic } from "../../../shared"
import type { createDatabase } from "../db"
import { challengeRemote, challenges, runs } from "../db/schema"
import { isTargetCapable } from "../platforms/challenge-state"
import { type ChallengeMeta, toRunPublic } from "./public"

type Database = ReturnType<typeof createDatabase>["db"]

export type RunQueries = ReturnType<typeof createRunQueries>

export function createRunQueries(options: { db: Database; dataDir: string }) {
  const { db, dataDir } = options

  function challengeMeta(challengeId: string): ChallengeMeta | undefined {
    const row = db
      .select({ challenge: challenges, remote: challengeRemote })
      .from(challenges)
      .leftJoin(challengeRemote, eq(challenges.id, challengeRemote.challengeId))
      .where(eq(challenges.id, challengeId))
      .get()
    if (!row) return undefined
    return {
      name: row.challenge.name,
      eventId: row.challenge.eventId,
      targetSupported: isTargetCapable(row.remote ?? undefined),
    }
  }

  function mapRow(row: typeof runs.$inferSelect): RunPublic {
    return toRunPublic(row, challengeMeta(row.challengeId))
  }

  function get(runId: string): RunPublic | undefined {
    const row = db.select().from(runs).where(eq(runs.id, runId)).get()
    return row ? mapRow(row) : undefined
  }

  function getRow(runId: string) {
    return db.select().from(runs).where(eq(runs.id, runId)).get()
  }

  function listForEvent(eventId: string): RunPublic[] {
    return db
      .select()
      .from(runs)
      .innerJoin(challenges, eq(runs.challengeId, challenges.id))
      .where(eq(challenges.eventId, eventId))
      .orderBy(desc(runs.updatedAt))
      .all()
      .map(({ runs: run }) => mapRow(run))
  }

  function listForChallenge(challengeId: string): RunPublic[] {
    return db
      .select()
      .from(runs)
      .where(eq(runs.challengeId, challengeId))
      .orderBy(desc(runs.updatedAt))
      .all()
      .map(mapRow)
  }

  function workspacePath(runId: string): string | undefined {
    const row = getRow(runId)
    if (!row) return undefined
    return join(dataDir, row.workspacePath)
  }

  return { get, getRow, listForEvent, listForChallenge, workspacePath }
}

/** Active (running) run ids for an event — used by delete guards. */
export function findActiveRunIdsForEvent(db: Database, eventId: string) {
  return db
    .select({ id: runs.id })
    .from(runs)
    .innerJoin(challenges, eq(runs.challengeId, challenges.id))
    .where(
      and(eq(challenges.eventId, eventId), inArray(runs.status, ["running"]))
    )
    .all()
    .map((row) => row.id)
}
