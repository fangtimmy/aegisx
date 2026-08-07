/** v5 run lifecycle: a run is a long-lived pi session + container. The agent
 * loops prompt()-by-prompt(); a turn resolving does NOT tear the run down.
 *
 * - `running`: a prompt() turn is in flight (pi isStreaming); container warm.
 * - `idle`: between turns; container warm — promptable instantly.
 * - `closed`: container + in-process session released (after finish_run, a
 *   manual close, or crash recovery); the DB session is retained,
 *   cold-restorable by messaging the run. Not a dead terminal. */
export type RunStatus = "running" | "idle" | "closed"

/** A run holds live resources (container + in-process session). */
export function isActiveRunStatus(status: string): boolean {
  return status === "running" || status === "idle"
}

/** Per-agent lifecycle. The main agent uses running|idle; children run to
 * completion within a single spawn_agent call (running|completed|failed). */
export type AgentStatus = "running" | "idle" | "completed" | "failed"
