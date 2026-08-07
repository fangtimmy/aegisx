import { and, eq } from "drizzle-orm"

import type { AgentLoopSettings } from "../agents/host-session"
import type { createDatabase } from "../db"
import { sessions } from "../db/schema"

type Database = ReturnType<typeof createDatabase>["db"]

/** Agent id for the orchestrator's single session (no `agents` row; keys only). */
export const ORCHESTRATOR_AGENT_ID = "orchestrator"

/** SDK agent-loop settings resolved from AegisX settings (compaction/retry). */
export type OrchestratorAgentSettings = AgentLoopSettings

/**
 * Find an existing orchestrator session id (cold-restore), else undefined.
 * An event has at most one orchestrator session; the oldest row is the
 * original (DbSessionManager never creates a second one — close+start reopens).
 */
export function findExistingOrchestratorSessionId(
  db: Database,
  eventId: string
): string | undefined {
  const rows = db
    .select({ id: sessions.id })
    .from(sessions)
    .where(
      and(eq(sessions.ownerType, "orchestrator"), eq(sessions.ownerId, eventId))
    )
    .orderBy(sessions.createdAt)
    .all()
  return rows[0]?.id
}
