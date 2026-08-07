import type { MessageList, OrchestratorPublic, RunUsage } from "@aegisx/shared"
import type { ThinkingLevel } from "@aegisx/shared/thinking"
import { and, eq } from "drizzle-orm"

import {
  listRenderableEntries,
  sumUsageTotals,
} from "../agents/session-queries"
import type { createDatabase } from "../db"
import { orchestrators, sessionEntries } from "../db/schema"
import { findExistingOrchestratorSessionId } from "./session"

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

  /** Durable committed entries for the orchestrator’s ACTIVE session only,
   * paginated by seq. Scoping to the active (newest) session means “new
   * session” starts a blank timeline; older sessions’ rows stay as archived
   * history. Same shape/semantics as run listMessages. */
  function listMessages(
    eventId: string,
    opts: { after?: number }
  ): MessageList {
    const sessionId = findExistingOrchestratorSessionId(db, eventId)
    if (!sessionId) return { items: [], nextAfter: opts.after ?? 0 }
    return listRenderableEntries(
      db,
      and(
        eq(sessionEntries.ownerType, "orchestrator"),
        eq(sessionEntries.ownerId, eventId),
        eq(sessionEntries.sessionId, sessionId)
      ),
      { after: opts.after ?? 0, agentIdFallback: ORCHESTRATOR_AGENT_ID }
    )
  }

  /** Sum token usage + cost across the orchestrator session (owner-scoped). */
  function usageTotals(eventId: string): RunUsage | undefined {
    return sumUsageTotals(
      db,
      and(
        eq(sessionEntries.ownerType, "orchestrator"),
        eq(sessionEntries.ownerId, eventId)
      )
    )
  }

  return { get, getRow, ensureRow, update, listMessages, usageTotals }
}
