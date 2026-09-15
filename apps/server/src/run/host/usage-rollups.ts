import { eq, sql } from "drizzle-orm"

import type { Database } from "../../db"
import { sessions, usageRollups, usageToolRollups } from "../../db/schema"
import { loadMergedEntryRows } from "./session-archive"

/** The transaction-scoped handle rollup writes go through (same convention
 * as the domain-events projector: a drizzle bun:sqlite transaction is
 * structurally the db handle it came from). */
export type RollupDb = Pick<Database, "insert" | "delete" | "select">

/** The per-entry increment the rollup tables advance by: the entry's usage
 * columns (null → 0), plus the counters its kind/role contributes. Derived
 * from the same extraction the adapter writes into the entry row's
 * first-class columns, so rollup and row can never disagree on the source
 * values. */
export type RollupDelta = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  cost: number
  /** role === "assistant" */
  turns: 0 | 1
  /** role === "toolResult" */
  toolCalls: 0 | 1
  entryCount: 1
}

/** Build one entry's rollup increment from the adapter's index-column
 * extraction ({@link module:pi-session-adapter~indexColumnsOf} shape). */
export function rollupDeltaOf(columns: {
  role: string | null
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  reasoningTokens: number | null
  cost: number | null
}): RollupDelta {
  return {
    inputTokens: columns.inputTokens ?? 0,
    outputTokens: columns.outputTokens ?? 0,
    cacheReadTokens: columns.cacheReadTokens ?? 0,
    cacheWriteTokens: columns.cacheWriteTokens ?? 0,
    reasoningTokens: columns.reasoningTokens ?? 0,
    cost: columns.cost ?? 0,
    turns: columns.role === "assistant" ? 1 : 0,
    toolCalls: columns.role === "toolResult" ? 1 : 0,
    entryCount: 1,
  }
}

/** Advance the rollup tables by one entry's increment. Runs INSIDE the
 * entry-write transaction (crash-consistency: entry, leaf pointer and
 * rollups land together or not at all). `toolName` (toolResult rows only)
 * feeds the per-tool tier. */
export function applyRollupDelta(
  tx: RollupDb,
  input: {
    sessionId: string
    agentId: string
    toolName: string | null
    delta: RollupDelta
    at: string
  }
): void {
  const { sessionId, agentId, toolName, delta, at } = input
  tx.insert(usageRollups)
    .values({ sessionId, agentId, updatedAt: at, ...delta })
    .onConflictDoUpdate({
      target: usageRollups.sessionId,
      set: {
        inputTokens: sql`${usageRollups.inputTokens} + excluded.input_tokens`,
        outputTokens: sql`${usageRollups.outputTokens} + excluded.output_tokens`,
        cacheReadTokens: sql`${usageRollups.cacheReadTokens} + excluded.cache_read_tokens`,
        cacheWriteTokens: sql`${usageRollups.cacheWriteTokens} + excluded.cache_write_tokens`,
        reasoningTokens: sql`${usageRollups.reasoningTokens} + excluded.reasoning_tokens`,
        cost: sql`${usageRollups.cost} + excluded.cost`,
        turns: sql`${usageRollups.turns} + excluded.turns`,
        toolCalls: sql`${usageRollups.toolCalls} + excluded.tool_calls`,
        entryCount: sql`${usageRollups.entryCount} + excluded.entry_count`,
        updatedAt: at,
      },
    })
    .run()
  if (toolName !== null) {
    tx.insert(usageToolRollups)
      .values({ sessionId, agentId, toolName, calls: 1 })
      .onConflictDoUpdate({
        target: [usageToolRollups.sessionId, usageToolRollups.toolName],
        set: { calls: sql`${usageToolRollups.calls} + 1` },
      })
      .run()
  }
}

/** Rebuild one session's rollups from its FULL logical history — the merged
 * read (archive prefix + surviving database rows), not the database alone:
 * on a partially-archived session a database-only sum would deflate the
 * projection by the archived prefix. The backtrack path (physical tail
 * delete) recomputes instead of decrementing — backtracks are low-frequency
 * and a session's row count is bounded, and rewrite-from-source cannot
 * drift. Same transaction as the delete; `at` stamps the projection's
 * updatedAt (injected, same convention as applyRollupDelta). */
export function recomputeSessionRollups(
  tx: RollupDb,
  sessionId: string,
  dataDir: string,
  at: string
): void {
  const rows = loadMergedEntryRows(tx, dataDir, sessionId)
  const owner = tx
    .select({ agentId: sessions.agentId })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .get()
  tx.delete(usageRollups).where(eq(usageRollups.sessionId, sessionId)).run()
  tx.delete(usageToolRollups)
    .where(eq(usageToolRollups.sessionId, sessionId))
    .run()
  if (!owner || rows.length === 0) return
  const totals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    cost: 0,
    turns: 0,
    toolCalls: 0,
    entryCount: rows.length,
  }
  const toolCalls = new Map<string, number>()
  for (const row of rows) {
    totals.inputTokens += row.inputTokens ?? 0
    totals.outputTokens += row.outputTokens ?? 0
    totals.cacheReadTokens += row.cacheReadTokens ?? 0
    totals.cacheWriteTokens += row.cacheWriteTokens ?? 0
    totals.reasoningTokens += row.reasoningTokens ?? 0
    totals.cost += row.cost ?? 0
    if (row.role === "assistant") totals.turns += 1
    if (row.role === "toolResult") {
      totals.toolCalls += 1
      if (row.toolName !== null) {
        toolCalls.set(row.toolName, (toolCalls.get(row.toolName) ?? 0) + 1)
      }
    }
  }
  tx.insert(usageRollups)
    .values({ sessionId, agentId: owner.agentId, updatedAt: at, ...totals })
    .run()
  for (const [toolName, calls] of toolCalls) {
    tx.insert(usageToolRollups)
      .values({ sessionId, agentId: owner.agentId, toolName, calls })
      .run()
  }
}
