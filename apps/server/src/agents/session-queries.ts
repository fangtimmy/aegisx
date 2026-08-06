import type { SessionEntry } from "@earendil-works/pi-coding-agent"
import { and, asc, gt, type SQL } from "drizzle-orm"
import type { MessageList, MessageListItem, RunUsage } from "../../../shared"
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
 * Malformed rows are skipped. Shared by run (runId-scoped) and orchestrator
 * (ownerType/ownerId-scoped) queries — the caller supplies the owner filter. */
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

/** List renderable entries (seq > after, matching `ownerWhere`) as message
 * items, ordered by seq. `ownerWhere` is the owner-scoping condition WITHOUT
 * the seq filter (this adds it). `agentIdFallback` is used when a row has no
 * agent_id (the orchestrator's single session). */
export function listRenderableEntries(
  db: Database,
  ownerWhere: SQL | undefined,
  opts: { after: number; agentIdFallback: string }
): MessageList {
  const rows = db
    .select()
    .from(sessionEntries)
    .where(and(ownerWhere, gt(sessionEntries.seq, opts.after)))
    .orderBy(asc(sessionEntries.seq))
    .all()
  const items: MessageListItem[] = []
  for (const row of rows) {
    let entry: SessionEntry
    try {
      entry = JSON.parse(row.data) as SessionEntry
    } catch {
      continue
    }
    if (!RENDERABLE_TYPES.has(entry.type)) continue
    const agentId = row.agentId ?? opts.agentIdFallback
    items.push({
      entry,
      seq: row.seq,
      key: entryKeyOf(agentId, entry),
      agentId,
    })
  }
  return {
    items,
    nextAfter: items.length > 0 ? items[items.length - 1].seq : opts.after,
  }
}
