import { dirname, join } from "node:path"
import { and, desc, eq } from "drizzle-orm"
import type { MessageList, RunPublic, RunUsage } from "../../../shared"
import type { AgentSummary } from "../../../shared/agent"
import {
  listRenderableEntries,
  sumUsageTotals,
} from "../agents/session-queries"
import type { createDatabase } from "../db"
import {
  agents,
  challengeRemote,
  challenges,
  runs,
  sessionEntries,
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
      .orderBy(desc(runs.updatedAt))
      .all()
      .map(({ runs: run }) => mapRow(run))
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
    // workspacePath is "runs/<id>/workspace"; the run dir is its parent.
    // Derive it from the stored value instead of ".." so the coupling is
    // explicit and survives layout changes.
    return join(dataDir, dirname(row.workspacePath))
  }

  /** Sum token usage + cost across a run from session_entries. Parity with the
   * pi-TUI footer — shares one accumulator with the live stat strip
   * (entry-usage.ts) so the two never drift (counts assistant + toolResult
   * message usage + compaction + branch_summary usage). */
  function usageTotals(runId: string): RunUsage | undefined {
    return sumUsageTotals(db, eq(sessionEntries.runId, runId))
  }

  /** Durable committed entries for a run, paginated by `seq`. Only renderable
   * kinds (message / compaction / branch_summary / model_change /
   * thinking_level_change) are returned; others (custom, ...) are skipped
   * but still count toward seq
   * (positional cursor). `after` is the highest seq already seen. */
  function listMessages(
    runId: string,
    opts: { after?: number; agentId?: string }
  ): MessageList {
    return listRenderableEntries(
      db,
      and(
        eq(sessionEntries.runId, runId),
        opts.agentId ? eq(sessionEntries.agentId, opts.agentId) : undefined
      ),
      { after: opts.after ?? 0, agentIdFallback: "" }
    )
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
    listMessages,
  }
}
