import {
  isTimingMeta,
  type MessageList,
  type MessageListItem,
  type AgentUsage,
  type TimingMeta,
} from "@aegisx/shared"
import type { SessionEntry } from "@earendil-works/pi-coding-agent"
import { and, asc, gt, sql, type SQL } from "drizzle-orm"

import type { Database } from "../../db"
import { sessionEntries } from "../../db/schema"
import { parseJson } from "../../lib/guards"
import { type EntryUsageTotals } from "./entry-usage"
import { entryKeyOf } from "./event-pipeline"

/** Only renderable session-entry kinds are surfaced to message lists. */
const RENDERABLE_TYPES = new Set([
  "message",
  "compaction",
  "branch_summary",
  "model_change",
  "thinking_level_change",
])

/** One usage field value, JSON-validity guarded: malformed `data` rows are
 * skipped (json_extract raises on invalid JSON; the JS side parses and skips
 * them, so the SQL must contribute 0 the same way). Exported for aggregate
 * queries that join session_entries with agents (e.g. per-model billing). */
export const usageField = (path: string) => sql<number>`
    CAST(
      COALESCE(
        json_extract(CASE WHEN json_valid(${sessionEntries.data}) THEN ${sessionEntries.data} END, ${path}),
        0
      ) AS REAL
    )
  `
/** Extract `$.message.role` with the same guard (null when data is invalid). */
export const roleField = sql`json_extract(CASE WHEN json_valid(${sessionEntries.data}) THEN ${sessionEntries.data} END, ${"$.message.role"})`

/** One aggregate SQL pass over session_entries matching `where`: token/cost
 * sums (the parity twin of {@link accumulateEntryUsage} — see
 * {@link sumUsageTotals}).
 *
 * Reads only the needed fields via SQLite JSON1 (json_extract) instead of
 * parsing every `data` blob: the denormalized `type` column picks the usage
 * location (message.usage for assistant/toolResult messages, top-level usage
 * for compaction/branch_summary); missing/malformed fields coalesce to 0,
 * matching the JS accumulator's toNum semantics for non-numeric values
 * (SQLite CAST of a non-numeric to REAL yields 0). Malformed `data` rows
 * contribute nothing on both sides (the JS reader skips them; json_extract
 * returns NULL). `totalTokens` stays a JS sum (pi formula: input + output +
 * cacheRead + cacheWrite). */
export function usageTotalsSql(
  db: Database,
  where: SQL | undefined
): EntryUsageTotals & { turns: number } {
  /** SUM of one usage field: top-level path for compaction/branch_summary,
   * message path for assistant/toolResult messages. */
  const sumField = (msgPath: string, entryPath: string) => sql<number>`
    SUM(
      CASE
        WHEN ${sessionEntries.type} IN ('compaction', 'branch_summary')
          THEN ${usageField(entryPath)}
        WHEN ${sessionEntries.type} = 'message'
          AND ${roleField} IN ('assistant', 'toolResult')
          THEN ${usageField(msgPath)}
        ELSE 0
      END
    )
  `
  const row = db
    .select({
      input: sumField("$.message.usage.input", "$.usage.input"),
      output: sumField("$.message.usage.output", "$.usage.output"),
      cacheRead: sumField("$.message.usage.cacheRead", "$.usage.cacheRead"),
      cacheWrite: sumField("$.message.usage.cacheWrite", "$.usage.cacheWrite"),
      reasoning: sumField("$.message.usage.reasoning", "$.usage.reasoning"),
      cost: sumField("$.message.usage.cost.total", "$.usage.cost.total"),
      // pi getSessionStats counts EVERY assistant message as a turn (before
      // the usage guard) — same rule as accumulateEntryUsage.
      turns: sql<number>`SUM(CASE WHEN ${sessionEntries.type} = 'message' AND ${roleField} = 'assistant' THEN 1 ELSE 0 END)`,
    })
    .from(sessionEntries)
    .where(where)
    .get()
  const totals: EntryUsageTotals & { turns: number } = {
    input: row?.input ?? 0,
    output: row?.output ?? 0,
    cacheRead: row?.cacheRead ?? 0,
    cacheWrite: row?.cacheWrite ?? 0,
    reasoning: row?.reasoning ?? 0,
    cost: row?.cost ?? 0,
    turns: row?.turns ?? 0,
    // pi getSessionStats total — NOT the provider-reported totalTokens field.
    totalTokens: 0,
  }
  totals.totalTokens =
    totals.input + totals.output + totals.cacheRead + totals.cacheWrite
  return totals
}

/** Sum token usage + cost across entries matching `where`. Returns undefined
 * when nothing was used (so callers can omit the field). Runs as a single
 * aggregate SQL query (JSON1) instead of an O(N) full-row JSON.parse per call
 * — usageTotals sits on hot paths (each turn start/settle, flag, compaction). */
export function sumUsageTotals(
  db: Database,
  where: SQL | undefined
): AgentUsage | undefined {
  const totals = usageTotalsSql(db, where)
  if (totals.turns === 0 && totals.cost === 0 && totals.totalTokens === 0) {
    return undefined
  }
  return {
    input: totals.input,
    output: totals.output,
    cacheRead: totals.cacheRead,
    cacheWrite: totals.cacheWrite,
    reasoning: totals.reasoning,
    totalTokens: totals.totalTokens,
    cost: totals.cost,
    turns: totals.turns,
  }
}

/** List renderable entries after the given seq cursor, matching `scopeWhere`.
 * `scopeWhere` is the scoping condition WITHOUT the cursor filter (this adds
 * it). Every row carries its agent_id (v8: notNull).
 *
 * The cursor is the per-session append position (`unique(sessionId, seq)`);
 * `nextAfter` echoes the highest SCANNED seq — renderable or not — so a
 * session whose tail is non-renderable rows (label / session_info) does not
 * pin clients into re-pulling them forever. */
export function listRenderableEntries(
  db: Database,
  scopeWhere: SQL | undefined,
  opts: { after: number }
): MessageList {
  const rows = db
    .select({
      data: sessionEntries.data,
      meta: sessionEntries.meta,
      seq: sessionEntries.seq,
      agentId: sessionEntries.agentId,
    })
    .from(sessionEntries)
    .where(and(scopeWhere, gt(sessionEntries.seq, opts.after)))
    .orderBy(asc(sessionEntries.seq))
    .all()
  const items: MessageListItem[] = []
  let nextAfter = opts.after
  for (const row of rows) {
    nextAfter = row.seq
    let entry: SessionEntry
    try {
      // Written by DbSessionManager (typed at commit time); parse only
      // guards against corrupt/truncated rows.
      entry = parseJson<SessionEntry>(row.data)
    } catch {
      continue
    }
    if (!RENDERABLE_TYPES.has(entry.type)) continue
    let meta: TimingMeta | undefined
    if (row.meta) {
      try {
        const parsed = JSON.parse(row.meta)
        if (isTimingMeta(parsed)) meta = parsed
      } catch {
        // skip malformed meta; the row still renders without timing
      }
    }
    items.push({
      entry,
      seq: row.seq,
      key: entryKeyOf(row.agentId, entry),
      ...(meta ? { meta } : {}),
    })
  }
  return { items, nextAfter }
}
