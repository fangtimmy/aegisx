/** v8 run lifecycle. A run's status is SQL-derived from its agents' statuses
 * (running ↔ idle) plus sanctioned explicit `closed` transitions
 * (finish / close / timeout-SIGKILL / recoverOnBoot). Not a dead terminal:
 * the DB session + agent rows survive a `closed` run for cold-restore. */
export type RunStatus = "running" | "idle" | "closed"

/** A run holds live resources (container + in-process sessions). */
export function isActiveRunStatus(status: string): boolean {
  return status === "running" || status === "idle"
}

/** Per-agent lifecycle. Declared agents use running|idle (turn-by-turn); a
 * spawn child runs to completion within one spawn_agent call
 * (running|completed|aborted|failed). `aborted` is set when the run is torn
 * down (finish/close/timeout) while the agent was mid-turn. */
export type AgentStatus =
  | "running"
  | "idle"
  | "completed"
  | "aborted"
  | "failed"
