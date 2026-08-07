import type { ThinkingLevel } from "@aegisx/shared/thinking"
import type { Api, Model } from "@earendil-works/pi-ai"
import type {
  ModelRuntime,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent"
import { and, eq } from "drizzle-orm"

import {
  type AgentLoopSettings,
  createHostAgentSession,
  type HostAgentSession,
} from "../agents/host-session"
import type { LiveBus } from "../agents/live"
import type { createDatabase } from "../db"
import { sessions } from "../db/schema"

type Database = ReturnType<typeof createDatabase>["db"]

/** Agent id for the orchestrator's single session (no `agents` row; keys only). */
export const ORCHESTRATOR_AGENT_ID = "orchestrator"

export type OrchestratorAgentSettings = AgentLoopSettings

export type CreateOrchestratorSessionInput = {
  eventId: string
  workspaceHostPath: string
  containerWorkspace: string
  modelRuntime: ModelRuntime
  model: Model<Api>
  thinkingLevel: ThinkingLevel
  agentSettings: OrchestratorAgentSettings
  systemPrompt: string
  /** Management tools (list/start/stop/read/status). File tools are added by
   * the caller and passed in here alongside them. */
  customTools: ToolDefinition[]
  toolNames: string[]
  db: Database
  bus: LiveBus
}

/** Find an existing orchestrator session id (cold-restore), else undefined.
 * An event has at most one orchestrator session; the oldest row is the
 * original (DbSessionManager never creates a second one — close+start reopens). */
function findExistingSessionId(
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

/**
 * Create the per-event orchestrator's host session. Thin wrapper over
 * {@link createHostAgentSession}: the only orchestrator-specific bits are the
 * owner kind, the bus channel (event id), the fixed agent id, and cold-restore
 * by owner. Everything else — pipeline, DbSessionManager wiring, resource
 * loader — is shared with solver main/child agents.
 */
export async function createOrchestratorSession(
  input: CreateOrchestratorSessionInput
): Promise<HostAgentSession> {
  const existingId = findExistingSessionId(input.db, input.eventId)
  return createHostAgentSession({
    owner: { type: "orchestrator", id: input.eventId },
    channel: input.eventId,
    agentId: ORCHESTRATOR_AGENT_ID,
    cwd: input.containerWorkspace,
    modelRuntime: input.modelRuntime,
    model: input.model,
    thinkingLevel: input.thinkingLevel,
    agentSettings: input.agentSettings,
    systemPrompt: input.systemPrompt,
    toolNames: input.toolNames,
    customTools: input.customTools,
    db: input.db,
    bus: input.bus,
    ...(existingId
      ? { resumeFrom: { sessionId: existingId, isJsonl: false } }
      : {}),
  })
}
