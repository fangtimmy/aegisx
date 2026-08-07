import { and, desc, eq } from "drizzle-orm"

import type { AgentLoopSettings } from "../agents/host-session"
import type { createDatabase } from "../db"
import { sessions } from "../db/schema"

type Database = ReturnType<typeof createDatabase>["db"]

/** Agent id for the orchestrator's single session (no `agents` row; keys only). */
export const ORCHESTRATOR_AGENT_ID = "orchestrator"

/** SDK agent-loop settings resolved from AegisX settings (compaction/retry). */
export type OrchestratorAgentSettings = AgentLoopSettings

/**
 * Find the ACTIVE orchestrator session id (cold-restore), else undefined.
 * The active session is the NEWEST `sessions` row for this owner: a normal
 * start creates one session and reuses it, while "new session" (see
 * service.newSession) creates a fresh row that becomes the active one — so
 * older rows stay as archived history. orderBy createdAt desc picks it.
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
    .orderBy(desc(sessions.createdAt))
    .all()
  return rows[0]?.id
}
