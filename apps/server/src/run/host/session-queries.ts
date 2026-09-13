import {
  isTimingMeta,
  type MessageList,
  type MessageListItem,
  type AgentUsage,
  type SessionEntryView,
  type TimingMeta,
} from "@aegisx/shared"
import { and, asc, desc, gt, inArray, sql, type SQL } from "drizzle-orm"

import type { Database } from "../../db"
import { sessionEntries } from "../../db/schema"
import { type EntryUsageTotals } from "./entry-usage"
import { entryKeyOf } from "./event-pipeline"
import { entryViewFromRow } from "./session-entry-codec"

/** Only renderable session-entry kinds are surfaced to message lists. */
const RENDERABLE_TYPES = [
  "message",
  "compaction",
  "branch_summary",
  "model_change",
  "thinking_level_change",
] as const

/** One aggregate SQL pass over session_entries matching `where`: token/cost
 * sums straight off the first-class usage columns (the SQL twin of
 * {@link accumulateEntryUsage} — the JS fold stays for live sampling; both
 * are same-sourced from what the adapter writes). `turns` counts assistant
 * message rows (pi getSessionStats counts every assistant message, usage or
 * not). `cacheHitRate` mirrors the fold's rule: the LATEST assistant row with
 * prompt tokens (input + cacheRead + cacheWrite > 0) wins. */
export function usageTotalsSql(
  db: Database,
  where: SQL | undefined
): EntryUsageTotals & { turns: number; cacheHitRate: number | null } {
  const scope = where ? sql`${where} AND ` : sql``
  const row = db
    .select({
      input: sql<number>`COALESCE(SUM(${sessionEntries.inputTokens}), 0)`,
      output: sql<number>`COALESCE(SUM(${sessionEntries.outputTokens}), 0)`,
      cacheRead: sql<number>`COALESCE(SUM(${sessionEntries.cacheReadTokens}), 0)`,
      cacheWrite: sql<number>`COALESCE(SUM(${sessionEntries.cacheWriteTokens}), 0)`,
      reasoning: sql<number>`COALESCE(SUM(${sessionEntries.reasoningTokens}), 0)`,
      cost: sql<number>`COALESCE(SUM(${sessionEntries.cost}), 0)`,
      turns: sql<number>`SUM(CASE WHEN ${sessionEntries.role} = 'assistant' THEN 1 ELSE 0 END)`,
      // "Latest" is per-session (seq restarts per session) — only well-defined
      // when `where` scopes to a single session. No production consumer today
      // (sumUsageTotals drops it; the live strip uses the JS fold).
      cacheHitRate: sql<number | null>`(
        SELECT ${sessionEntries.cacheReadTokens} * 100.0 /
          (${sessionEntries.inputTokens} + ${sessionEntries.cacheReadTokens} + ${sessionEntries.cacheWriteTokens})
        FROM ${sessionEntries}
        WHERE ${scope}${sessionEntries.role} = 'assistant'
          AND ${sessionEntries.inputTokens} + ${sessionEntries.cacheReadTokens} + ${sessionEntries.cacheWriteTokens} > 0
        ORDER BY ${sessionEntries.seq} DESC
        LIMIT 1
      )`,
    })
    .from(sessionEntries)
    .where(where)
    .get()
  const totals: EntryUsageTotals & {
    turns: number
    cacheHitRate: number | null
  } = {
    input: row?.input ?? 0,
    output: row?.output ?? 0,
    cacheRead: row?.cacheRead ?? 0,
    cacheWrite: row?.cacheWrite ?? 0,
    reasoning: row?.reasoning ?? 0,
    cost: row?.cost ?? 0,
    turns: row?.turns ?? 0,
    cacheHitRate: row?.cacheHitRate ?? null,
    // pi getSessionStats total — NOT the provider-reported totalTokens field.
    totalTokens: 0,
  }
  totals.totalTokens =
    totals.input + totals.output + totals.cacheRead + totals.cacheWrite
  return totals
}

/** Sum token usage + cost across entries matching `where`. Returns undefined
 * when nothing was used (so callers can omit the field). Single aggregate SQL
 * query over the usage columns — usageTotals sits on hot paths (each turn
 * start/settle, flag, compaction). */
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
 * `nextAfter` echoes the highest seq above the cursor — renderable or not —
 * so a session whose tail is non-renderable rows (label / session_info) does
 * not pin clients into re-pulling them forever. */
export function listRenderableEntries(
  db: Database,
  scopeWhere: SQL | undefined,
  opts: { after: number }
): MessageList {
  const rows = db
    .select({
      id: sessionEntries.id,
      parentId: sessionEntries.parentId,
      createdAt: sessionEntries.createdAt,
      body: sessionEntries.body,
      meta: sessionEntries.meta,
      seq: sessionEntries.seq,
      agentId: sessionEntries.agentId,
    })
    .from(sessionEntries)
    .where(
      and(
        scopeWhere,
        gt(sessionEntries.seq, opts.after),
        inArray(sessionEntries.type, [...RENDERABLE_TYPES])
      )
    )
    .orderBy(asc(sessionEntries.seq))
    .all()
  const tail = db
    .select({ seq: sessionEntries.seq })
    .from(sessionEntries)
    .where(and(scopeWhere, gt(sessionEntries.seq, opts.after)))
    .orderBy(desc(sessionEntries.seq))
    .limit(1)
    .get()
  const items: MessageListItem[] = []
  for (const row of rows) {
    let entry: SessionEntryView
    try {
      // Written by the adapter (typed at commit time); parse only guards
      // against corrupt/truncated rows.
      entry = entryViewFromRow(row)
    } catch {
      continue
    }
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
  return { items, nextAfter: tail?.seq ?? opts.after }
}
