import type { AgentSessionSummary, AgentSummary } from "@aegisx/shared"
import { and, asc, count, eq, gt, inArray } from "drizzle-orm"

import type { Database } from "../db"
import { agents, sessionEntries, sessions } from "../db/schema"
import { RunActionError } from "./errors"
import type { SessionLifecycle } from "./host/lifecycle"

/** Dependencies the run service injects — the ops share its db, per-agent
 * locks, lifecycle map, and call back into prepareAgent / emit helpers. */
export type AgentSessionOpsDeps = {
  db: Database
  lifecycle: SessionLifecycle
  withLock<T>(id: string, op: () => T | Promise<T>): Promise<T>
  /** Prepare (or reopen) one agent's live session. */
  prepareAgent(agentId: string): Promise<void>
  /** Full reopen for a terminal agent (prepare + idle flip + reopened
   * event + deadline re-arm) — session switches must land the same
   * converged state as a cold resume. */
  resumeAgent(agentId: string): Promise<void>
  updateAgent(agentId: string, patch: Partial<typeof agents.$inferInsert>): void
  emitAgent(agentId: string): void
  requireAgent(agentId: string): AgentSummary
  now(): string
}

/** Multi-session + flat backtrack (v12) operations. Sessions are per-agent
 * conversation threads: exactly one is active (agents.sessionFile), /new
 * creates a fresh one, activate switches the pointer (old sessions stay in
 * the DB), backtrack truncates the active one flat (no pi tree-branching —
 * the abandoned tail is physically deleted). All ops require an idle agent
 * (a running turn is rejected, matching /compact). */
export function createAgentSessionOps(deps: AgentSessionOpsDeps) {
  const { db, lifecycle } = deps

  /** Reject a session op while the agent's turn is in flight. */
  function requireIdleAgent(agentId: string): void {
    if (lifecycle.get(agentId)?.session.isStreaming) {
      throw new RunActionError(
        "invalid_state",
        "Agent is currently running — stop the current turn first"
      )
    }
  }

  /** Dispose the agent's live session (if any) and drop it from the
   * lifecycle map. The caller re-prepares it. */
  async function disposeLiveAgent(agentId: string): Promise<void> {
    const session = lifecycle.get(agentId)
    if (session) {
      await session.dispose()
      lifecycle.delete(agentId)
    }
  }

  /** Rebuild the agent's live session after a session-pointer change
   * (/new / activate / backtrack): dispose the old one, then re-prepare from
   * the (possibly new) active session. Terminal agents rebuild lazily on
   * the next send (prepareAgent via onResume). */
  async function rebuildAgentSession(agentId: string): Promise<void> {
    await disposeLiveAgent(agentId)
    await deps.prepareAgent(agentId)
  }

  /** List an agent's sessions (oldest first) with per-session message counts
   * and the active flag (the current sessionFile pointer). */
  function listAgentSessions(agentId: string): AgentSessionSummary[] {
    const row = db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.id, agentId))
      .get()
    if (!row) throw new RunActionError("not_found", "Agent not found")
    const rows = db
      .select()
      .from(sessions)
      .where(eq(sessions.agentId, agentId))
      .orderBy(asc(sessions.createdAt))
      .all()
    const counts = new Map<string, number>()
    if (rows.length > 0) {
      for (const entry of db
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
        counts.set(entry.sessionId, entry.count)
      }
    }
    const active = db
      .select({ sessionFile: agents.sessionFile })
      .from(agents)
      .where(eq(agents.id, agentId))
      .get()?.sessionFile
    return rows.map((session) => ({
      id: session.id,
      createdAt: session.createdAt,
      messageCount: counts.get(session.id) ?? 0,
      isActive: session.id === active,
    }))
  }

  /** Create a brand-new session for the agent and make it active (/new). Old
   * sessions stay in the DB (switchable). Requires an idle agent. */
  async function createAgentSession(agentId: string): Promise<AgentSummary> {
    return deps.withLock(agentId, async () => {
      requireIdleAgent(agentId)
      // Nulling the pointer makes prepareAgent's createHost build a fresh
      // DbSessionManager (new sessions row) and write the new id back.
      deps.updateAgent(agentId, { sessionFile: null, updatedAt: deps.now() })
      await rebuildAgentSession(agentId)
      deps.emitAgent(agentId)
      return deps.requireAgent(agentId)
    })
  }

  /** Switch the agent's active session. The target must be one of the
   * agent's own sessions. Requires an idle agent. */
  async function activateAgentSession(
    agentId: string,
    sessionId: string
  ): Promise<AgentSummary> {
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
        return deps.requireAgent(agentId) // already active + live — no-op
      }
      requireIdleAgent(agentId)
      const currentStatus = db
        .select({ status: agents.status })
        .from(agents)
        .where(eq(agents.id, agentId))
        .get()?.status
      const wasTerminal =
        currentStatus === "completed" ||
        currentStatus === "aborted" ||
        currentStatus === "failed"
      deps.updateAgent(agentId, {
        sessionFile: sessionId,
        updatedAt: deps.now(),
      })
      await disposeLiveAgent(agentId)
      // A terminal agent's switch is a reopen: converge through the same
      // path as a cold resume (idle flip + reopened event + timers), not a
      // bare prepare that would leave the status stale.
      if (wasTerminal) {
        await deps.resumeAgent(agentId)
      } else {
        await deps.prepareAgent(agentId)
      }
      deps.emitAgent(agentId)
      return deps.requireAgent(agentId)
    })
  }

  /** Flat backtrack: delete every committed entry after `seq` in the agent's
   * active session (the target entry itself is kept). pi's tree-branching
   * semantics are intentionally NOT used — the abandoned tail is physically
   * removed, so the next turn continues from the truncated history. The live
   * session is rebuilt so pi re-derives its in-memory context (pi caches
   * `agent.state.messages` at session creation; a bare DB delete would not
   * take effect). Requires an idle agent. */
  async function backtrackAgent(
    agentId: string,
    seq: number
  ): Promise<AgentSummary> {
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
      await deps.prepareAgent(agentId)
      deps.emitAgent(agentId)
      return deps.requireAgent(agentId)
    })
  }

  return {
    requireIdleAgent,
    disposeLiveAgent,
    rebuildAgentSession,
    listAgentSessions,
    createAgentSession,
    activateAgentSession,
    backtrackAgent,
  }
}
