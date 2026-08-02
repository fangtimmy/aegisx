import { join } from "node:path"
import { and, count, eq } from "drizzle-orm"
import type { RunPublic } from "../../../shared"
import type { AgentSummary } from "../../../shared/agent"
import type { createDatabase } from "../db"
import {
  agents,
  challengeRemote,
  challenges,
  runEvents,
  runs,
} from "../db/schema"
import { isTargetCapable } from "../platforms/challenge-state"
import { type ChallengeMeta, toAgentSummary, toRunPublic } from "./public"

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
      .orderBy(runs.updatedAt)
      .all()
      .map(({ runs: run }) => mapRow(run))
      .reverse()
  }

  function listAgents(runId: string): AgentSummary[] {
    return db
      .select()
      .from(agents)
      .where(eq(agents.runId, runId))
      .orderBy(agents.createdAt)
      .all()
      .map((row) => toAgentSummary(row))
  }

  function mainAgent(runId: string): AgentSummary | undefined {
    return listAgents(runId).find((agent) => agent.role === "main")
  }

  function messageCount(runId: string, agentId: string): number {
    const row = db
      .select({ value: count() })
      .from(runEvents)
      .where(and(eq(runEvents.runId, runId), eq(runEvents.agentId, agentId)))
      .get()
    return row?.value ?? 0
  }

  function detail(
    runId: string
  ): { run: RunPublic; agents: AgentSummary[] } | undefined {
    const run = get(runId)
    if (!run) return undefined
    return { run, agents: listAgents(runId) }
  }

  function workspacePath(runId: string): string | undefined {
    const row = getRow(runId)
    if (!row) return undefined
    return join(dataDir, row.workspacePath)
  }

  /** Absolute path to the run directory (data/runs/<id>), the files root. */
  function runDirPath(runId: string): string | undefined {
    const row = getRow(runId)
    if (!row) return undefined
    return join(dataDir, row.workspacePath, "..")
  }

  return {
    get,
    getRow,
    listForEvent,
    listAgents,
    mainAgent,
    messageCount,
    detail,
    workspacePath,
    runDirPath,
  }
}
