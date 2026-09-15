import {
  isTimingMeta,
  type MessageList,
  type MessageListItem,
  type AgentUsage,
  type SessionEntryView,
  type TimingMeta,
} from "@aegisx/shared"
import { inArray, sql } from "drizzle-orm"

import type { Database } from "../../db"
import { usageRollups } from "../../db/schema"
import { type EntryUsageTotals } from "./entry-usage"
import { entryKeyOf } from "./event-pipeline"
import { loadMergedEntryRows, sessionHeadSeq } from "./session-archive"
import { entryViewFromRow } from "./session-entry-codec"

/** Only renderable session-entry kinds are surfaced to message lists. */
const RENDERABLE_TYPES = new Set([
  "message",
  "compaction",
  "branch_summary",
  "model_change",
  "thinking_level_change",
])

/** Usage totals across the named agents' sessions, read straight off the
 * usage_rollups projection (D 批 — the aggregate used to be one SQL pass
 * over session_entries; the rollup is maintained by the entry-write
 * transaction, so this is one small indexed table instead of the largest
 * table in the database). `totalTokens` follows pi's getSessionStats formula
 * (input + output + cacheRead + cacheWrite), NOT the provider-reported
 * totalTokens field. */
export function agentUsageTotals(
  db: Database,
  agentIds: string[]
): EntryUsageTotals & { turns: number } {
  const zero = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    cost: 0,
    turns: 0,
    totalTokens: 0,
  }
  if (agentIds.length === 0) return zero
  const row = db
    .select({
      input: sql<number>`COALESCE(SUM(${usageRollups.inputTokens}), 0)`,
      output: sql<number>`COALESCE(SUM(${usageRollups.outputTokens}), 0)`,
      cacheRead: sql<number>`COALESCE(SUM(${usageRollups.cacheReadTokens}), 0)`,
      cacheWrite: sql<number>`COALESCE(SUM(${usageRollups.cacheWriteTokens}), 0)`,
      reasoning: sql<number>`COALESCE(SUM(${usageRollups.reasoningTokens}), 0)`,
      cost: sql<number>`COALESCE(SUM(${usageRollups.cost}), 0)`,
      turns: sql<number>`COALESCE(SUM(${usageRollups.turns}), 0)`,
    })
    .from(usageRollups)
    .where(inArray(usageRollups.agentId, agentIds))
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

/** Sum token usage + cost across the named agents' sessions. Returns
 * undefined when nothing was used (so callers can omit the field). */
export function sumUsageTotals(
  db: Database,
  agentIds: string[]
): AgentUsage | undefined {
  const totals = agentUsageTotals(db, agentIds)
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

/** List renderable entries after the given seq cursor for one agent's
 * session (the cursor is also the backtrack API's target key). Reads the
 * transparent merged entry rows (archive prefix + database rows), so
 * archived history pages exactly like live rows. `nextAfter` echoes the
 * highest seq above the cursor — renderable or not — so a session whose
 * tail is non-renderable rows (label / session_info) does not pin clients
 * into re-pulling them forever. `sessionHeadSeq` is the session's TRUE head
 * (merged max seq) even when it sits below the request cursor — the client's
 * server-side-truncation probe (a backtrack elsewhere rewound the seq space;
 * `nextAfter` alone can never express that). */
export function listRenderableEntries(
  db: Database,
  opts: {
    agentId: string
    sessionId: string
    dataDir: string
    after: number
  }
): MessageList {
  const rows = loadMergedEntryRows(db, opts.dataDir, opts.sessionId, {
    after: opts.after,
  })
  const items: MessageListItem[] = []
  let nextAfter = opts.after
  for (const row of rows) {
    if (row.seq > nextAfter) nextAfter = row.seq
    if (!RENDERABLE_TYPES.has(row.type)) continue
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
      key: entryKeyOf(opts.agentId, entry),
      ...(meta ? { meta } : {}),
    })
  }
  return {
    items,
    nextAfter,
    sessionHeadSeq: sessionHeadSeq(db, opts.dataDir, opts.sessionId),
  }
}
