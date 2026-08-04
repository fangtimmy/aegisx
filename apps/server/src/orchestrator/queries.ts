import type { SessionEntry } from "@earendil-works/pi-coding-agent"
import { and, asc, eq, gt } from "drizzle-orm"
import type {
  MessageList,
  MessageListItem,
  OrchestratorPublic,
  RunUsage,
} from "../../../shared"
import type { ThinkingLevel } from "../../../shared/thinking"
import { accumulateEntryUsage } from "../agents/entry-usage"
import { entryKeyOf } from "../agents/event-pipeline"
import type { createDatabase } from "../db"
import { orchestrators, sessionEntries } from "../db/schema"

type Database = ReturnType<typeof createDatabase>["db"]

/** Stable agent id used for the orchestrator's single session (it has no
 * `agents` row; this is only for entry keys + SSE routing). */
export const ORCHESTRATOR_AGENT_ID = "orchestrator"

export type OrchestratorQueries = ReturnType<typeof createOrchestratorQueries>

export function createOrchestratorQueries(options: { db: Database }) {
  const { db } = options

  function getRow(eventId: string) {
    return db
      .select()
      .from(orchestrators)
      .where(eq(orchestrators.eventId, eventId))
      .get()
  }

  function toPublic(
    row: typeof orchestrators.$inferSelect
  ): OrchestratorPublic {
    return {
      eventId: row.eventId,
      enabled: row.enabled,
      modelId: row.modelId,
      thinkingLevel: row.thinkingLevel as ThinkingLevel,
      instruction: row.instruction,
      maxConcurrentTargets: row.maxConcurrentTargets,
      status: row.status as OrchestratorPublic["status"],
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  }

  function get(eventId: string): OrchestratorPublic | undefined {
    const row = getRow(eventId)
    return row ? toPublic(row) : undefined
  }

  /** Insert a default row if none exists; return it. Container/workspace
   * snapshot fields are filled on first start. */
  function ensureRow(eventId: string): typeof orchestrators.$inferSelect {
    const existing = getRow(eventId)
    if (existing) return existing
    const ts = new Date().toISOString()
    db.insert(orchestrators)
      .values({
        eventId,
        enabled: false,
        status: "closed",
        containerName: "",
        image: "",
        cpus: 0,
        memoryMb: 0,
        pidsLimit: 0,
        workspacePath: "",
        sessionDir: "",
        createdAt: ts,
        updatedAt: ts,
      })
      .run()
    return getRow(eventId) as typeof orchestrators.$inferSelect
  }

  function update(
    eventId: string,
    patch: Partial<typeof orchestrators.$inferInsert>
  ) {
    ensureRow(eventId)
    const ts = new Date().toISOString()
    db.update(orchestrators)
      .set({ ...patch, updatedAt: ts })
      .where(eq(orchestrators.eventId, eventId))
      .run()
    return getRow(eventId) as typeof orchestrators.$inferSelect
  }

  /** Durable committed entries for the orchestrator session, paginated by seq
   * (same shape/semantics as run listMessages, but owner-scoped). */
  function listMessages(
    eventId: string,
    opts: { after?: number }
  ): MessageList {
    const after = opts.after ?? 0
    const rows = db
      .select()
      .from(sessionEntries)
      .where(
        and(
          eq(sessionEntries.ownerType, "orchestrator"),
          eq(sessionEntries.ownerId, eventId),
          gt(sessionEntries.seq, after)
        )
      )
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
      if (
        entry.type !== "message" &&
        entry.type !== "compaction" &&
        entry.type !== "branch_summary"
      )
        continue
      const agentId = row.agentId ?? ORCHESTRATOR_AGENT_ID
      items.push({
        entry,
        seq: row.seq,
        key: entryKeyOf(agentId, entry),
        agentId,
      })
    }
    return {
      items,
      nextAfter: items.length > 0 ? items[items.length - 1].seq : after,
    }
  }

  /** Sum token usage + cost across the orchestrator session (owner-scoped). */
  function usageTotals(eventId: string): RunUsage | undefined {
    const rows = db
      .select({ data: sessionEntries.data })
      .from(sessionEntries)
      .where(
        and(
          eq(sessionEntries.ownerType, "orchestrator"),
          eq(sessionEntries.ownerId, eventId)
        )
      )
      .all()
    const entries: SessionEntry[] = []
    for (const row of rows) {
      try {
        entries.push(JSON.parse(row.data) as SessionEntry)
      } catch {
        // skip malformed
      }
    }
    const sample = accumulateEntryUsage(entries)
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

  return { get, getRow, ensureRow, update, listMessages, usageTotals }
}
