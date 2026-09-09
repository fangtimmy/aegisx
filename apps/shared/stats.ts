import type { AgentStatus } from "./agent"

/** Per-event statistics (GET /api/events/:eventId/stats). Everything is a
 * derived view over existing rows — agents / challenge_flags / spawn_queue /
 * channel_messages / session_entries — no dedicated storage. */

type EventStatsWindow = {
  /** Derived activity bounds: start = first agent start (fallback: first
   * challenge creation), end = last agent/flag/message/challenge activity.
   * Both null for an event with no data. */
  start: string | null
  end: string | null
}

type EventStatsOverview = {
  challengesTotal: number
  /** Any solve dimension (local accepted flag / manual override / remote). */
  challengesSolved: number
  pointsEarned: number
  pointsAvailable: number
  /** Solver attempts (any status). */
  attempts: number
  attemptsActive: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  turns: number
  cost: number
}

export type EventScorePoint = {
  time: string
  challengeId: string
  challengeName: string
  points: number
  cumulative: number
  /** Which solve dimension produced the point: an accepted flag (agent or
   * manual entry) or a non-flag solve (remote sync / manual override). */
  source: "agent" | "manual" | "remote"
}

export type EventModelBillingItem = {
  /** Canonical model ref (`aegisx-<providerId>/<modelId>:<effort>`). */
  model: string
  requests: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cost: number
  /** Solver attempts spawned with this model. */
  solverAgents: number
  /** Accepted flags attributed to this model via the submitting agent. */
  solves: number
}

export type EventChallengeEfficiency = {
  challengeId: string
  name: string
  category: string | null
  points: number | null
  solved: boolean
  attempts: number
  tokens: number
  cost: number
  /** Wall time of the challenge's agents (sum of agent intervals). */
  durationMs: number
  submissions: number
  rejectedSubmissions: number
  messages: number
}

export type EventConcurrencyPoint = {
  time: string
  running: number
}

export type EventMessageBucket = {
  /** Hour bucket start (ISO). */
  bucket: string
  count: number
}

export type EventToolUsageItem = {
  tool: string
  calls: number
}

export type EventStatsAgentSpan = {
  id: string
  name: string
  /** Null = the event's scheduler. */
  challengeId: string | null
  challengeName: string | null
  model: string
  source: "manual" | "scheduler"
  status: AgentStatus
  start: string
  end: string
}

export type EventAgentEfficiency = {
  id: string
  name: string | null
  role: "solver" | "orchestrator"
  challengeId: string | null
  challengeName: string | null
  model: string
  source: "manual" | "scheduler"
  status: AgentStatus
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cost: number
  turns: number
  toolCalls: number
  /** Wall interval start → span end (same semantics as agentTimeline). */
  durationMs: number
  /** For a currently-idle agent: how long it has been sitting idle.
   * Zero otherwise. */
  idleMs: number
  error: string | null
  /** finish_run result written at terminal settle (null otherwise). */
  summary: string | null
}

export type EventCategoryStats = {
  category: string | null
  challenges: number
  /** Merged solve semantics (accepted flag / manual / remote). */
  solved: number
  points: number
  pointsAvailable: number
  attempts: number
  tokens: number
  cost: number
}

export type EventStats = {
  window: EventStatsWindow
  overview: EventStatsOverview
  scoreTimeline: EventScorePoint[]
  modelBilling: EventModelBillingItem[]
  challengeEfficiency: EventChallengeEfficiency[]
  /** Step series of concurrent running solver agents. */
  concurrency: EventConcurrencyPoint[]
  /** Solver attempts by spawn source. */
  spawnSource: { scheduler: number; manual: number }
  queue: {
    done: number
    failed: number
    cancelled: number
    /** Mean spawn_queue.createdAt → agent start (queued items only). */
    avgWaitMs: number | null
  }
  /** Team-channel message volume per hour. */
  messageActivity: EventMessageBucket[]
  /** Message volume by channel kind across the event. */
  messageKinds: { team: number; dm: number; orch: number }
  /** Top tools by toolResult count. */
  toolUsage: EventToolUsageItem[]
  failures: {
    timeouts: number
    aborted: number
    failed: number
  }
  agentTimeline: EventStatsAgentSpan[]
  /** One row per agent (solver + orchestrator). */
  agentEfficiency: EventAgentEfficiency[]
  /** Challenges grouped by category. */
  categoryStats: EventCategoryStats[]
}
