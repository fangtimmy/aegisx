import type { AgentSessionSummary, AgentSummary } from "@aegisx/shared"
import { and, asc, eq, gt, inArray } from "drizzle-orm"

import type { Database } from "../../db"
import { agents, sessionEntries, sessions, usageRollups } from "../../db/schema"
import type { DomainEventActor } from "../domain-events/store"
import { emitDomainEvent } from "../domain-events/store"
import { RunActionError } from "../errors"
import type { HostAgentSession } from "../host/host-session"
import { loadMergedEntryRows } from "../host/session-archive"
import { recomputeSessionRollups } from "../host/usage-rollups"

/** Dependencies the kernel injects — the ops share its db, data dir (the
 * session archive's merged reads), per-agent locks, the agents' mounted
 * sessions, and call back into prepareAgent / resumeAgent / the bus emit.
 * Scope assertions are the composition facade's business; the ops take the
 * already-resolved event actor. */
export type AgentSessionOpsDeps = {
  db: Database
  dataDir: string
  /** The agent's mounted live session, if any. */
  sessionOf(agentId: string): HostAgentSession | undefined
  /** Unmount the live session (the caller disposes it). */
  detachSession(agentId: string): void
  withLock<T>(id: string, op: () => T | Promise<T>): Promise<T>
  /** Prepare (or reopen) one agent's live session. */
  prepareAgent(agentId: string): Promise<void>
  /** Full reopen for a terminal agent (prepare + idle flip + reopened
   * event + deadline re-arm) — session switches must land the same
   * converged state as a cold resume. */
  resumeAgent(agentId: string): Promise<void>
  emitAgent(agentId: string): void
  requireAgent(agentId: string): AgentSummary
  now(): string
}

/**
 * Multi-session + flat backtrack (v12) operations — kernel verbs over the
 * per-agent session threads. Sessions are per-agent conversation threads:
 * exactly one is active (agents.sessionFile), create starts a fresh one,
 * activate switches the pointer (old sessions stay in the DB), backtrack
 * truncates the active one flat (no pi tree-branching — the abandoned tail
 * is physically deleted). All ops require an idle agent (a running turn is
 * rejected, matching compact).
 */
export function createAgentSessionOps(deps: AgentSessionOpsDeps) {
  const { db } = deps

  /** The agent.eventId/challengeId dims for an emission (null when gone —
   * the ops run under the agent's lock, so a mid-op delete cannot race). */
  function dimsOf(agentId: string): {
    eventId: string | null
    challengeId: string | null
  } {
    const row = db
      .select({ eventId: agents.eventId, challengeId: agents.challengeId })
      .from(agents)
      .where(eq(agents.id, agentId))
      .get()
    return {
      eventId: row?.eventId ?? null,
      challengeId: row?.challengeId ?? null,
    }
  }

  /** The agent.session_switched fact — its projection moves the active
   * session pointer (null = fresh session, which makes the next prepare
   * build a new one). */
  function emitSessionSwitched(
    agentId: string,
    sessionId: string | null,
    actor: DomainEventActor
  ): void {
    const { eventId, challengeId } = dimsOf(agentId)
    emitDomainEvent(db, {
      type: "agent.session_switched",
      eventId,
      challengeId,
      agentId,
      actor,
      payload: { sessionId, at: deps.now() },
    })
  }

  /** Reject a session op while the agent's turn is in flight. */
  function requireIdleAgent(agentId: string): void {
    if (deps.sessionOf(agentId)?.session.isStreaming) {
      throw new RunActionError(
        "invalid_state",
        "Agent is currently running — stop the current turn first"
      )
    }
  }

  /** Dispose the agent's live session (if any) and unmount it. The caller
   * re-prepares it. */
  async function disposeLiveAgent(agentId: string): Promise<void> {
    const session = deps.sessionOf(agentId)
    if (session) {
      await session.dispose()
      deps.detachSession(agentId)
    }
  }

  /** Rebuild the agent's live session after a session-pointer change
   * (create / activate / backtrack): dispose the old one, then re-prepare
   * from the (possibly new) active session. Terminal agents rebuild lazily
   * on the next send (prepareAgent via onResume). */
  async function rebuildAgentSession(agentId: string): Promise<void> {
    await disposeLiveAgent(agentId)
    await deps.prepareAgent(agentId)
  }

  /** List an agent's sessions (oldest first) with per-session message counts
   * and the active flag (the current sessionFile pointer). Counts read the
   * usage_rollups entryCount (the projection every consumer shares) — not a
   * session_entries scan, and exact for archived sessions too. */
  function listSessions(agentId: string): AgentSessionSummary[] {
    const rows = db
      .select()
      .from(sessions)
      .where(eq(sessions.agentId, agentId))
      .orderBy(asc(sessions.createdAt))
      .all()
    const counts = new Map<string, number>()
    if (rows.length > 0) {
      for (const entry of db
        .select({
          sessionId: usageRollups.sessionId,
          entryCount: usageRollups.entryCount,
        })
        .from(usageRollups)
        .where(
          inArray(
            usageRollups.sessionId,
            rows.map((r) => r.id)
          )
        )
        .all()) {
        counts.set(entry.sessionId, entry.entryCount)
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
  async function createSession(
    agentId: string,
    actor: DomainEventActor
  ): Promise<AgentSummary> {
    return deps.withLock(agentId, async () => {
      requireIdleAgent(agentId)
      // Nulling the pointer makes prepareAgent's createHost build a fresh
      // PiSessionAdapter (new sessions row) and write the new id back.
      emitSessionSwitched(agentId, null, actor)
      await rebuildAgentSession(agentId)
      deps.emitAgent(agentId)
      return deps.requireAgent(agentId)
    })
  }

  /** Switch the agent's active session. The target must be one of the
   * agent's own sessions. Requires an idle agent. */
  async function activateSession(
    agentId: string,
    sessionId: string,
    actor: DomainEventActor
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
      if (current === sessionId && deps.sessionOf(agentId)) {
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
      emitSessionSwitched(agentId, sessionId, actor)
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
   * removed, so the next turn continues from the truncated history. The target
   * is resolved on the merged timeline (archive prefix + database rows) — the
   * same rows the message list renders — so an entry that only exists in the
   * archive is still a legal backtrack target. The live session is rebuilt so
   * pi re-derives its in-memory context (pi caches `agent.state.messages` at
   * session creation; a bare DB delete would not take effect). Requires an
   * idle agent. */
  async function backtrack(
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
      const target = loadMergedEntryRows(db, deps.dataDir, sessionId).some(
        (row) => row.seq === seq
      )
      if (!target) {
        throw new RunActionError("not_found", "Target message not found")
      }
      await disposeLiveAgent(agentId)
      // The tail delete and the rollup recompute land in ONE transaction:
      // physical removal would leave the incrementally-maintained projections
      // permanently inflated. Recompute-from-source (the merged read, bounded
      // by the session's logical row count) instead of tail-decrementing —
      // backtracks are low-frequency and it cannot drift; reading the archive
      // prefix keeps a partially-archived session's rollups exact.
      db.transaction((tx) => {
        tx.delete(sessionEntries)
          .where(
            and(
              eq(sessionEntries.sessionId, sessionId),
              gt(sessionEntries.seq, seq)
            )
          )
          .run()
        recomputeSessionRollups(tx, sessionId, deps.dataDir, deps.now())
      })
      await deps.prepareAgent(agentId)
      deps.emitAgent(agentId)
      return deps.requireAgent(agentId)
    })
  }

  return {
    requireIdleAgent,
    disposeLiveAgent,
    rebuildAgentSession,
    listSessions,
    createSession,
    activateSession,
    backtrack,
  }
}
