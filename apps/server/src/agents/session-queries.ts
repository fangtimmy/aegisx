import {
  isTimingMeta,
  type MessageList,
  type MessageListItem,
  type RunUsage,
  type TimingMeta,
} from "@aegisx/shared"
import type { SessionEntry } from "@earendil-works/pi-coding-agent"
import { and, asc, gt, sql, type SQL } from "drizzle-orm"

import type { createDatabase } from "../db"
import { sessionEntries } from "../db/schema"
import { accumulateEntryUsage } from "./entry-usage"
import { entryKeyOf } from "./event-pipeline"

type Database = ReturnType<typeof createDatabase>["db"]

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

/** Sum token usage + cost across entries matching `where`. Returns undefined
 * when nothing was used (so callers can omit the field). */
export function sumUsageTotals(
  db: Database,
  where: SQL | undefined
): RunUsage | undefined {
  const sample = accumulateEntryUsage(readSessionEntries(db, where))
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
