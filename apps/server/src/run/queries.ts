import { join } from "node:path"
import type { SessionEntry } from "@earendil-works/pi-coding-agent"
import { and, eq } from "drizzle-orm"
import type { RunPublic, RunUsage } from "../../../shared"
import type { AgentSummary } from "../../../shared/agent"
import type { createDatabase } from "../db"
import {
  agents,
  challengeRemote,
  challenges,
  runs,
  sessionEntries,
  submissions,
} from "../db/schema"
import { isTargetCapable } from "../platforms/challenge-state"
import { accumulateEntryUsage } from "./entry-usage"
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
    return row
      ? toRunPublic(row, challengeMeta(row.challengeId), usageTotals(runId))
      : undefined
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

  /** Sum token usage + cost across a run from session_entries. Parity with the
   * pi-TUI footer — shares one accumulator with the live stat strip
   * (entry-usage.ts) so the two never drift (counts assistant + toolResult
   * message usage + compaction + branch_summary usage). */
  function usageTotals(runId: string): RunUsage | undefined {
    const rows = db
      .select({ data: sessionEntries.data })
      .from(sessionEntries)
      .where(eq(sessionEntries.runId, runId))
      .all()
    const entries: SessionEntry[] = []
    for (const row of rows) {
      try {
        entries.push(JSON.parse(row.data) as SessionEntry)
      } catch {}
    }
    const sample = accumulateEntryUsage(entries)
    if (sample.turns === 0 && sample.cost === 0 && sample.totalTokens === 0) {
      return undefined
    }
    return {
      input: sample.input,
      output: sample.output,
      cacheRead: sample.cacheRead,
      cacheWrite: sample.cacheWrite,
      reasoning: sample.reasoning,
      totalTokens: sample.totalTokens,
      cost: sample.cost,
      turns: sample.turns,
    }
  }

  /** Whether this run has an accepted flag submission (gate for finish_run). */
  function hasAcceptedFlag(runId: string): boolean {
    const row = db
      .select({ id: submissions.id })
      .from(submissions)
      .where(
        and(eq(submissions.runId, runId), eq(submissions.status, "accepted"))
      )
      .get()
    return Boolean(row)
  }

  return {
    get,
    getRow,
    listForEvent,
    listAgents,
    mainAgent,
    detail,
    workspacePath,
    runDirPath,
    usageTotals,
    hasAcceptedFlag,
  }
}
