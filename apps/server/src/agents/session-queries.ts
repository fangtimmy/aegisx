import {
  isTimingMeta,
  type MessageList,
  type MessageListItem,
  type RunUsage,
  type TimingMeta,
} from "@aegisx/shared"
import type { SessionEntry } from "@earendil-works/pi-coding-agent"
import { and, asc, desc, eq, gt, sql, type SQL } from "drizzle-orm"

import type { Database } from "../db"
import { sessionEntries } from "../db/schema"
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

/** Parse committed session_entries.data rows (matching `where`) into entries.
 * Malformed rows are skipped. Shared by run (runId-scoped) and per-agent
 * queries — the caller supplies the scoping filter. */
export function readSessionEntries(
  db: Database,
  where: SQL | undefined
): SessionEntry[] {
  const rows = db
    .select({ data: sessionEntries.data })
    .from(sessionEntries)
    .where(where)
    .all()
  const entries: SessionEntry[] = []
  for (const row of rows) {
    try {
      entries.push(JSON.parse(row.data) as SessionEntry)
    } catch {
      // skip malformed
    }
  }
  return entries
}

/** One aggregate SQL pass over session_entries matching `where`: token/cost
 * sums + the latest assistant cache-hit rate (the parity twin of
 * {@link accumulateEntryUsage} — see {@link sumUsageTotals}).
 *
 * Reads only the needed fields via SQLite JSON1 (json_extract) instead of
 * parsing every `data` blob: the denormalized `type` column picks the usage
 * location (message.usage for assistant/toolResult messages, top-level usage
 * for compaction/branch_summary); missing/malformed fields coalesce to 0,
 * matching the JS accumulator's toNum semantics for non-numeric values
 * (SQLite CAST of a non-numeric to REAL yields 0). Malformed `data` rows
 * contribute nothing on both sides (readSessionEntries skips them;
 * json_extract returns NULL). `totalTokens` stays a JS sum (pi formula:
 * input + output + cacheRead + cacheWrite). */
export function usageTotalsSql(
  db: Database,
  where: SQL | undefined
): {
  totals: EntryUsageTotals & { turns: number }
  cacheHitRate: number | null
} {
  /** One usage field value, JSON-validity guarded: malformed `data` rows are
   * skipped (json_extract raises on invalid JSON; readSessionEntries skips
   * them, so the SQL must contribute 0 the same way). */
  const usageField = (path: string) => sql<number>`
    CAST(
      COALESCE(
        json_extract(CASE WHEN json_valid(${sessionEntries.data}) THEN ${sessionEntries.data} END, ${path}),
        0
      ) AS REAL
    )
  `
  /** Extract `$.message.role` with the same guard (null when data is invalid). */
  const roleField = sql`json_extract(CASE WHEN json_valid(${sessionEntries.data}) THEN ${sessionEntries.data} END, ${"$.message.role"})`

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

  // Latest assistant message with prompt tokens (input + cacheRead +
  // cacheWrite) drives the cache-hit rate (cacheRead / prompt * 100) — the
  // same walk accumulateEntryUsage does, in insertion (rowid) order.
  const cacheRow = db
    .select({
      input: usageField("$.message.usage.input"),
      cacheRead: usageField("$.message.usage.cacheRead"),
      cacheWrite: usageField("$.message.usage.cacheWrite"),
    })
    .from(sessionEntries)
    .where(
      and(
        where,
        eq(sessionEntries.type, "message"),
        sql`${roleField} = 'assistant'`,
        sql`(${usageField("$.message.usage.input")} + ${usageField("$.message.usage.cacheRead")} + ${usageField("$.message.usage.cacheWrite")}) > 0`
      )
    )
    .orderBy(desc(sql`rowid`))
    .limit(1)
    .get()
  let cacheHitRate: number | null = null
  if (cacheRow) {
    const prompt = cacheRow.input + cacheRow.cacheRead + cacheRow.cacheWrite
    if (prompt > 0) cacheHitRate = (cacheRow.cacheRead / prompt) * 100
  }
  return { totals, cacheHitRate }
}

/** Sum token usage + cost across entries matching `where`. Returns undefined
 * when nothing was used (so callers can omit the field). Runs as a single
 * aggregate SQL query (JSON1) instead of an O(N) full-row JSON.parse per call
 * — usageTotals sits on hot paths (each turn start/settle, flag, compaction). */
export function sumUsageTotals(
  db: Database,
  where: SQL | undefined
): RunUsage | undefined {
  const { totals } = usageTotalsSql(db, where)
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

/** List renderable entries after the given cursor, matching `scopeWhere`.
 * `scopeWhere` is the scoping condition WITHOUT the cursor filter (this adds
 * it). Every row carries its agent_id (v8: notNull).
 *
 * Cursor semantics (`opts.cursor`, default `seq`):
 *  - `seq` — per-session append position (`unique(sessionId, seq)`). Correct
 *    for single-session scopes (per-agent queries + backtrack's seq target);
 *    `nextAfter` is a seq.
 *  - `rowid` — SQLite rowid (monotonic on an append-only rowid table). Used
 *    for run-level queries that union several sessions' entries, where
 *    per-session seqs interleave and cannot order a single stream (a seq
 *    cursor there silently drops whole sessions' later entries). Items still
 *    carry their own `seq` (the per-agent pagination / backtrack key).
 *
 * Known boundary (accepted): flat backtrack deletes the tail of a session and
 * a later insert can reuse a freed rowid, so a client holding a stale rowid
 * cursor could theoretically skip new rows. Harmless in practice: backtrack
 * re-pulls via the store reset + full reload, and SSE `message.committed`
 * pushes new entries to live subscribers. */
export function listRenderableEntries(
  db: Database,
  scopeWhere: SQL | undefined,
  opts: { after: number; cursor?: { column: "seq" } | { column: "rowid" } }
): MessageList {
  const cursor = opts.cursor?.column ?? "seq"
  const rows = db
    .select({
      data: sessionEntries.data,
      meta: sessionEntries.meta,
      seq: sessionEntries.seq,
      agentId: sessionEntries.agentId,
      rowid: sql<number>`rowid`,
    })
    .from(sessionEntries)
    .where(
      and(
        scopeWhere,
        cursor === "rowid"
          ? gt(sql`rowid`, opts.after)
          : gt(sessionEntries.seq, opts.after)
      )
    )
    .orderBy(cursor === "rowid" ? asc(sql`rowid`) : asc(sessionEntries.seq))
    .all()
  const items: MessageListItem[] = []
  let nextCursor = opts.after
  for (const row of rows) {
    let entry: SessionEntry
    try {
      entry = JSON.parse(row.data) as SessionEntry
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
      agentId: row.agentId,
      ...(meta ? { meta } : {}),
    })
    nextCursor = cursor === "rowid" ? row.rowid : row.seq
  }
  return {
    items,
    nextAfter: items.length > 0 ? nextCursor : opts.after,
  }
}
