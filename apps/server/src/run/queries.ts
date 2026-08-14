import { dirname, join } from "node:path"

import type {
  ChallengeFlag,
  MessageList,
  RunPublic,
  RunStatus,
  RunUsage,
} from "@aegisx/shared"
import type { AgentSummary } from "@aegisx/shared/agent"
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm"

import {
  listRenderableEntries,
  sumUsageTotals,
} from "../agents/session-queries"
import type { createDatabase } from "../db"
import {
  agents,
  challengeFlags,
  challengeRemote,
  challenges,
  runs,
  sessionEntries,
} from "../db/schema"
import { isTargetCapable } from "../platforms/challenge-state"
import {
  type ChallengeMeta,
  toAgentSummary,
  toFlagPublic,
  toRunPublic,
  type RunModelDisplay,
} from "./public"

/** Group flags by their originating run id (runId-sourced flags only). */
function groupFlagsByRun(
  db: Database,
  runIds: string[]
): Map<string, ChallengeFlag[]> {
  const map = new Map<string, ChallengeFlag[]>()
  if (runIds.length === 0) return map
  const rows = db
    .select()
    .from(challengeFlags)
    .where(inArray(challengeFlags.runId, runIds))
    .orderBy(asc(challengeFlags.createdAt), asc(challengeFlags.id))
    .all()
    .map(toFlagPublic)
  for (const flag of rows) {
    if (!flag.runId) continue
    const list = map.get(flag.runId) ?? []
    list.push(flag)
    map.set(flag.runId, list)
  }
  return map
}

type Database = ReturnType<typeof createDatabase>["db"]

export type RunQueries = ReturnType<typeof createRunQueries>

export function createRunQueries(options: {
  db: Database
  dataDir: string
  /** Derive the run model display (provider/modelId/modelName/thinkingLevel)
   * from the run row's `model` ref string. Needs the provider list — supplied by
   * the service. */
  resolveModelDisplay: (ref: string) => RunModelDisplay
}) {
  const { db, dataDir, resolveModelDisplay } = options

  function challengeMeta(
    challengeId: string | null
  ): ChallengeMeta | undefined {
    if (!challengeId) return undefined
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

  function mapRow(
    row: typeof runs.$inferSelect,
    flags: ChallengeFlag[] = []
  ): RunPublic {
    return toRunPublic(
      row,
      challengeMeta(row.challengeId),
      flags,
      undefined,
      resolveModelDisplay(row.model)
    )
  }

  function get(runId: string): RunPublic | undefined {
    const row = db.select().from(runs).where(eq(runs.id, runId)).get()
    if (!row) return undefined
    const flags = db
      .select()
      .from(challengeFlags)
      .where(eq(challengeFlags.runId, runId))
      .orderBy(asc(challengeFlags.createdAt), asc(challengeFlags.id))
      .all()
      .map(toFlagPublic)
    return toRunPublic(
      row,
      challengeMeta(row.challengeId),
      flags,
      usageTotals(runId),
      resolveModelDisplay(row.model)
    )
  }

  function getRow(runId: string) {
    return db.select().from(runs).where(eq(runs.id, runId)).get()
  }

  function listForEvent(eventId: string): RunPublic[] {
    const rows = db
      .select()
      .from(runs)
      .innerJoin(challenges, eq(runs.challengeId, challenges.id))
      .where(eq(challenges.eventId, eventId))
      .orderBy(desc(runs.updatedAt))
      .all()
    const flagsByRun = groupFlagsByRun(
      db,
      rows.map(({ runs: run }) => run.id)
    )
    return rows.map(({ runs: run }) =>
      mapRow(run, flagsByRun.get(run.id) ?? [])
    )
  }

  /** Filter runs by any combination of event / challenge / scope / status
   * (challenge-scope only by default — scheduler runs are excluded unless
   * `includeScheduler` is set). Recent-first. */
  function listRuns(
    filter: {
      eventId?: string
      challengeId?: string
      status?: RunStatus
      includeScheduler?: boolean
    } = {}
  ): RunPublic[] {
    const conds = []
    if (filter.eventId) conds.push(eq(runs.eventId, filter.eventId))
    if (filter.challengeId) conds.push(eq(runs.challengeId, filter.challengeId))
    if (filter.status) conds.push(eq(runs.status, filter.status))
    if (!filter.includeScheduler) conds.push(eq(runs.scopeType, "challenge"))
    const rows = db
      .select()
      .from(runs)
      .where(conds.length > 0 ? and(...conds) : undefined)
      .orderBy(desc(runs.updatedAt))
      .all()
    const flagsByRun = groupFlagsByRun(
      db,
      rows.map((row) => row.id)
    )
    return rows.map((row) => mapRow(row, flagsByRun.get(row.id) ?? []))
  }

  function listAgents(runId: string): AgentSummary[] {
    return (
      db
        .select()
        .from(agents)
        .where(eq(agents.runId, runId))
        // createdAt can tie when setup declares several agents within one
        // millisecond; rowid (monotonic by insertion) is a deterministic tiebreak.
        .orderBy(agents.createdAt, sql`rowid`)
        .all()
        .map((row) => toAgentSummary(row))
    )
  }

  function entryAgent(runId: string): AgentSummary | undefined {
    return listAgents(runId).find((agent) => agent.isEntry)
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

  /** Event-wide token usage + cost across every run in the event (scheduler
   * run included — it burns tokens too). session_entries.runId is the
   * redundant run-level key kept for exactly this (spec §九). */
  function usageForEvent(eventId: string): RunUsage | undefined {
    const runIds = db
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.eventId, eventId))
      .all()
      .map((row) => row.id)
    if (runIds.length === 0) return undefined
    return sumUsageTotals(db, inArray(sessionEntries.runId, runIds))
  }

  /** Durable committed entries for a run, paginated by `seq`. Only renderable
   * kinds (message / compaction / branch_summary / model_change /
   * thinking_level_change) are returned; others (custom, ...) are skipped
   * but still count toward seq (positional cursor). `after` is the highest seq
   * already seen.
   *
   * Multi-session (v12): each agent contributes only its ACTIVE session's
   * entries (its `agents.sessionFile` pointer). A per-agent query takes the
   * explicit `sessionId` override when given, else the active one; the
   * run-level query is the union of every agent's active session. Legacy jsonl
   * sessions have no session_entries rows and contribute nothing. */
  function listMessages(
    runId: string,
    opts: { after?: number; agentId?: string; sessionId?: string }
  ): MessageList {
    const after = opts.after ?? 0
    if (opts.agentId) {
      const agent = db
        .select({ sessionFile: agents.sessionFile })
        .from(agents)
        .where(eq(agents.id, opts.agentId))
        .get()
      const sessionId =
        opts.sessionId ??
        (agent?.sessionFile && !agent.sessionFile.endsWith(".jsonl")
          ? agent.sessionFile
          : undefined)
      if (!sessionId) return { items: [], nextAfter: after }
      return listRenderableEntries(
        db,
        and(
          eq(sessionEntries.runId, runId),
          eq(sessionEntries.agentId, opts.agentId),
          eq(sessionEntries.sessionId, sessionId)
        ),
        { after }
      )
    }
    const agentRows = db
      .select({ id: agents.id, sessionFile: agents.sessionFile })
      .from(agents)
      .where(eq(agents.runId, runId))
      .all()
    const scopes = agentRows
      .filter((a) => a.sessionFile && !a.sessionFile.endsWith(".jsonl"))
      .map((a) =>
        and(
          eq(sessionEntries.agentId, a.id),
          eq(sessionEntries.sessionId, a.sessionFile as string)
        )
      )
    if (scopes.length === 0) return { items: [], nextAfter: after }
    return listRenderableEntries(
      db,
      and(eq(sessionEntries.runId, runId), or(...scopes)),
      { after }
    )
  }

  return {
    get,
    getRow,
    listForEvent,
    listRuns,
    listAgents,
    entryAgent,
    detail,
    workspacePath,
    runDirPath,
    usageTotals,
    usageForEvent,
    listMessages,
  }
}
