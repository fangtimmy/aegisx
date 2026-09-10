import { and, asc, eq, inArray, isNull, lt, ne, or } from "drizzle-orm"

import type { Database } from "../db"
import { agents, sessionEntries, sessions } from "../db/schema"
import { logEvent } from "../lib/log"
import type { Clock, ClockTimer } from "./clock"
import { createTimerHub, systemClock } from "./clock"

/** Retention window for terminal agents' sessions. Code constant, not a
 * setting: the only knob that matters for a long unattended event is "old
 * enough to be dead weight". Semantic cost: a terminal agent cold-reopened
 * after this window loses its in-window conversation history (the agent row,
 * workspace files and WRITEUP survive; only the session tree is pruned). */
export const SESSION_RETENTION_MS = 14 * 24 * 60 * 60_000

/** How often the pruner runs (plus once at boot). */
export const SESSION_RETENTION_INTERVAL_MS = 6 * 60 * 60_000

/** Sessions deleted per pass — bounds the write burst (session_entries is the
 * largest table in the DB; a single giant DELETE would hold the write lock). */
const SESSION_RETENTION_BATCH = 50

const TERMINAL_STATUSES = ["completed", "aborted", "failed"] as const

type SessionRetentionDeps = {
  db: Database
  /** Time layer (default: system clock); tests inject a fake clock. */
  clock?: Clock
  retentionMs?: number
  intervalMs?: number
  batchSize?: number
}

/**
 * `session_entries` retention: the append-only session tree is the largest
 * table in the DB and previously only shrank when an agent/session was
 * deleted, so a long event grew it without bound (events/stats aggregate over
 * it). This pruner deletes sessions — rows + their entries, per session —
 * under two hard safety rules:
 *
 *  1. only sessions owned by a TERMINAL agent (completed/aborted/failed) —
 *     a live agent's entries are never touched, and
 *  2. never the agent's ACTIVE session (`agents.sessionFile`) — a terminal
 *     agent can still be cold-reopened from its active session.
 *
 * Deletion is per-session and batched (oldest first) so the write lock is
 * held for bounded bursts. Every pass is a pure DB judgement against
 * `clock.now()`; the boot run and the 6h interval both call the same
 * `runOnce`.
 */
export function createSessionRetention(deps: SessionRetentionDeps) {
  const clock = deps.clock ?? systemClock
  const hub = createTimerHub(clock)
  const retentionMs = deps.retentionMs ?? SESSION_RETENTION_MS
  const intervalMs = deps.intervalMs ?? SESSION_RETENTION_INTERVAL_MS
  const batchSize = deps.batchSize ?? SESSION_RETENTION_BATCH
  let timer: ClockTimer | undefined

  /** One prune pass (oldest eligible sessions first, capped at batchSize).
   * Returns the number of sessions (and implicitly their entries) removed. */
  function runOnce(): number {
    const cutoff = new Date(clock.now() - retentionMs).toISOString()
    const rows = deps.db
      .select({ id: sessions.id })
      .from(sessions)
      .innerJoin(agents, eq(sessions.agentId, agents.id))
      .where(
        and(
          inArray(agents.status, [...TERMINAL_STATUSES]),
          lt(sessions.createdAt, cutoff),
          or(isNull(agents.sessionFile), ne(agents.sessionFile, sessions.id))
        )
      )
      .orderBy(asc(sessions.createdAt))
      .limit(batchSize)
      .all()
    const ids = rows.map((row) => row.id)
    if (ids.length === 0) return 0
    // Entries first (explicit, so the intent does not rest on FK cascade),
    // then the session rows themselves.
    deps.db
      .delete(sessionEntries)
      .where(inArray(sessionEntries.sessionId, ids))
      .run()
    deps.db.delete(sessions).where(inArray(sessions.id, ids)).run()
    logEvent("retention", "sessions_pruned", {
      sessions: ids.length,
      windowMs: retentionMs,
    })
    return ids.length
  }

  /** Boot run + interval. Idempotent; a second start is a no-op. */
  function start(): void {
    if (timer) return
    runOnce()
    timer = hub.setInterval(runOnce, intervalMs)
  }

  function close(): void {
    hub.disposeAll()
    timer = undefined
  }

  return { runOnce, start, close }
}
