/** Activity-log wire types (GET /api/activity). Derived view — no table:
 * each item is a timestamped fact already persisted in agents /
 * challenge_flags / spawn_queue. */

export type ActivityKind =
  | "flag"
  | "agentSpawn"
  | "agentEnd"
  | "timeout"
  | "queueFailed"

export type ActivityItem = {
  /** Stable per-source key ("flag:<id>" / "agent:<id>:end" / …). */
  id: string
  kind: ActivityKind
  /** ISO timestamp of the underlying fact. */
  time: string
  eventId: string
  eventName: string
  /** Null = the event's scheduler (not challenge-scoped). */
  challengeId: string | null
  challengeName: string | null
  agentId: string | null
  /** agentEnd terminal state (completed | aborted | failed). */
  agentStatus: string | null
  /** agentEnd: finish_run summary or error, pre-truncated by the server. */
  summary: string | null
  flag: string | null
}

export type ActivitySnapshot = {
  items: ActivityItem[]
}
