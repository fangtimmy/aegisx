import { join } from "node:path"
import { and, count, eq } from "drizzle-orm"
import type { RunPublic, RunUsage } from "../../../shared"
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

  /** Sum token usage + cost across a run's committed assistant messages. */
  function usageTotals(runId: string): RunUsage | undefined {
    const rows = db
      .select({ payload: runEvents.payload })
      .from(runEvents)
      .where(and(eq(runEvents.runId, runId), eq(runEvents.role, "assistant")))
      .all()
    let input = 0
    let output = 0
    let cacheRead = 0
    let cacheWrite = 0
    let reasoning = 0
    let totalTokens = 0
    let cost = 0
    let turns = 0
    for (const row of rows) {
      if (!row.payload) continue
      let payload: Record<string, unknown>
      try {
        payload = JSON.parse(row.payload)
      } catch {
        continue
      }
      const u = payload.usage
      if (!u || typeof u !== "object") continue
      const usage = u as Record<string, unknown>
      const c = (usage.cost ?? {}) as Record<string, unknown>
      input += num(usage.input)
      output += num(usage.output)
      cacheRead += num(usage.cacheRead)
      cacheWrite += num(usage.cacheWrite)
      if (typeof usage.reasoning === "number") reasoning += usage.reasoning
      totalTokens += num(usage.totalTokens)
      cost += num(c.total)
      turns += 1
    }
    if (turns === 0) return undefined
    return {
      input,
      output,
      cacheRead,
      cacheWrite,
      reasoning,
      totalTokens,
      cost,
      turns,
    }
  }

  function num(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0
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
    usageTotals,
  }
}
