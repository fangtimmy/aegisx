import type { AgentSessionSummary, RunPublic } from "@aegisx/shared"
import { and, asc, count, eq, gt, inArray } from "drizzle-orm"

import type { SessionLifecycle } from "../agents/lifecycle"
import type { Database } from "../db"
import { agents, sessionEntries, sessions } from "../db/schema"
import { RunActionError } from "./errors"
import type { RunContext } from "./service"

/** Dependencies the run service injects — the ops share its db, per-agent
 * locks, lifecycle map and run context, and call back into prepareAgent /
 * emit / status helpers. */
export type AgentSessionOpsDeps = {
  db: Database
  lifecycle: SessionLifecycle
  /** Per-run reusable handles (container/model/prompt context). */
  contexts: Map<string, RunContext>
  withLock<T>(id: string, op: () => T | Promise<T>): Promise<T>
  /** Prepare (or cold-restore) one agent's live session. */
  prepareAgent(runId: string, agentId: string): Promise<void>
  runIdOf(agentId: string): string | undefined
  updateAgent(agentId: string, patch: Partial<typeof agents.$inferInsert>): void
  emitAgents(runId: string): void
  requireRun(runId: string): RunPublic
  now(): string
}

type AgentSessionOps = ReturnType<typeof createAgentSessionOps>

/** Multi-session + flat backtrack (v12) operations. Sessions are per-agent
 * conversation threads: exactly one is active (agents.sessionFile), /new
 * creates a fresh one, activate switches the pointer (old sessions stay in
 * the DB), backtrack truncates the active one flat (no pi tree-branching —
 * the abandoned tail is physically deleted). All ops require an idle agent
 * (a running turn is rejected, matching /compact) and are rejected for spawn
 * children (they run unattended). */
export function createAgentSessionOps(deps: AgentSessionOpsDeps) {
  const { db, lifecycle, contexts } = deps

  /** The agent's run, throwing for unknown ids and spawn children. */
  function mainAgentRunOf(agentId: string): string {
    const row = db
      .select({ runId: agents.runId, parentAgentId: agents.parentAgentId })
      .from(agents)
      .where(eq(agents.id, agentId))
      .get()
    if (!row) throw new RunActionError("not_found", "Agent not found")
    if (row.parentAgentId) {
      throw new RunActionError(
        "invalid_state",
        "Child agents run unattended and do not support session operations"
      )
    }
    return row.runId
  }

  /** Reject a session op while the agent's turn is in flight. */
  function requireIdleAgent(agentId: string): void {
    if (lifecycle.get(agentId)?.session.isStreaming) {
      throw new RunActionError(
        "invalid_state",
        "Agent is currently running — stop the current turn first"
      )
    }
  }

  /** Dispose the agent's live session (if any) and drop it from the lifecycle
   * map. The caller re-prepares it when the run is warm. */
  async function disposeLiveAgent(agentId: string): Promise<void> {
    const session = lifecycle.get(agentId)
    if (session) {
      await session.dispose()
      lifecycle.delete(agentId)
    }
  }

  /** Rebuild the agent's live session after a session-pointer change
   * (/new / activate / backtrack): dispose the old one, then re-prepare from
   * the (possibly new) active session when the run context is warm. Closed /
   * cold runs rebuild lazily on the next send (prepareAgent via onResume). */
  async function rebuildAgentSession(
    runId: string,
    agentId: string
  ): Promise<void> {
    await disposeLiveAgent(agentId)
    if (contexts.has(runId)) await deps.prepareAgent(runId, agentId)
  }

  /** List an agent's sessions (oldest first) with per-session message counts
   * and the active flag (the current sessionFile pointer). */
  function listAgentSessions(agentId: string): AgentSessionSummary[] {
    const runId = deps.runIdOf(agentId)
    if (!runId) throw new RunActionError("not_found", "Agent not found")
    const rows = db
      .select()
      .from(sessions)
      .where(eq(sessions.agentId, agentId))
      .orderBy(asc(sessions.createdAt))
      .all()
    const counts = new Map<string, number>()
    if (rows.length > 0) {
      for (const row of db
        .select({ sessionId: sessionEntries.sessionId, count: count() })
        .from(sessionEntries)
        .where(
          inArray(
            sessionEntries.sessionId,
            rows.map((r) => r.id)
          )
        )
        .groupBy(sessionEntries.sessionId)
        .all()) {
        counts.set(row.sessionId, row.count)
      }
    }
    const active = db
      .select({ sessionFile: agents.sessionFile })
      .from(agents)
      .where(eq(agents.id, agentId))
      .get()?.sessionFile
    return rows.map((row) => ({
      id: row.id,
      createdAt: row.createdAt,
      messageCount: counts.get(row.id) ?? 0,
      isActive: row.id === active,
    }))
  }

  /** Create a brand-new session for the agent and make it active (/new). Old
   * sessions stay in the DB (switchable). Requires an idle agent. */
  async function createAgentSession(agentId: string): Promise<RunPublic> {
    const runId = mainAgentRunOf(agentId)
    return deps.withLock(agentId, async () => {
      requireIdleAgent(agentId)
      // Nulling the pointer makes prepareAgent's createHost build a fresh
      // DbSessionManager (new sessions row) and write the new id back.
      deps.updateAgent(agentId, { sessionFile: null, updatedAt: deps.now() })
      await rebuildAgentSession(runId, agentId)
      deps.emitAgents(runId)
      return deps.requireRun(runId)
    })
  }

  /** Switch the agent's active session. The target must be one of the agent's
   * own sessions. Requires an idle agent. */
  async function activateAgentSession(
    agentId: string,
    sessionId: string
  ): Promise<RunPublic> {
    const runId = mainAgentRunOf(agentId)
    return deps.withLock(agentId, async () => {
      const row = db
        .select()
        .from(sessions)
        .where(and(eq(sessions.id, sessionId), eq(sessions.agentId, agentId)))
        .get()
      if (!row) throw new RunActionError("not_found", "Session not found")
      const current = db
        .select({ sessionFile: agents.sessionFile })
        .from(agents)
        .where(eq(agents.id, agentId))
        .get()?.sessionFile
      if (current === sessionId && lifecycle.has(agentId)) {
        return deps.requireRun(runId) // already active + live — no-op
      }
      requireIdleAgent(agentId)
      deps.updateAgent(agentId, {
        sessionFile: sessionId,
        updatedAt: deps.now(),
      })
      await rebuildAgentSession(runId, agentId)
      deps.emitAgents(runId)
      return deps.requireRun(runId)
    })
  }

  /** Flat backtrack: delete every committed entry after `seq` in the agent's
   * active session (the target entry itself is kept). pi's tree-branching
   * semantics are intentionally NOT used — the abandoned tail is physically
   * removed, so the next turn continues from the truncated history. The live
   * session is rebuilt so pi re-derives its in-memory context (pi caches
   * `agent.state.messages` at session creation; a bare DB delete would not
   * take effect). Requires an idle agent; legacy jsonl sessions are rejected. */
  async function backtrackAgent(
    agentId: string,
    seq: number
  ): Promise<RunPublic> {
    const runId = mainAgentRunOf(agentId)
    return deps.withLock(agentId, async () => {
      requireIdleAgent(agentId)
      const agentRow = db
        .select({ sessionFile: agents.sessionFile })
        .from(agents)
        .where(eq(agents.id, agentId))
        .get()
      if (!agentRow?.sessionFile) {
        throw new RunActionError("invalid_state", "Agent has no session")
      }
      if (agentRow.sessionFile.endsWith(".jsonl")) {
        throw new RunActionError(
          "invalid_state",
          "Legacy jsonl sessions do not support backtracking"
        )
      }
      const sessionId = agentRow.sessionFile
      const target = db
        .select({ id: sessionEntries.id })
        .from(sessionEntries)
        .where(
          and(
            eq(sessionEntries.sessionId, sessionId),
            eq(sessionEntries.seq, seq)
          )
        )
        .get()
      if (!target) {
        throw new RunActionError("not_found", "Target message not found")
      }
      await disposeLiveAgent(agentId)
      db.delete(sessionEntries)
        .where(
          and(
            eq(sessionEntries.sessionId, sessionId),
            gt(sessionEntries.seq, seq)
          )
        )
        .run()
      if (contexts.has(runId)) await deps.prepareAgent(runId, agentId)
      deps.emitAgents(runId)
      return deps.requireRun(runId)
    })
  }

  return {
    mainAgentRunOf,
    requireIdleAgent,
    disposeLiveAgent,
    rebuildAgentSession,
    listAgentSessions,
    createAgentSession,
    activateAgentSession,
    backtrackAgent,
  }
}
