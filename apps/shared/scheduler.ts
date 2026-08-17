/** Scheduler / fleet wire types. Canonical definition — the server's
 * scheduler-admin + routes and the web UI both import from here. */

import type { AgentSummary } from "./agent"
import type { RunPublic } from "./run"

/** Fence + active-run snapshot returned by get_status (the scheduler status
 * block of GET /api/events/:id/scheduler and /fleet). */
export type SchedulerStatusSnapshot = {
  maxConcurrentRuns: number
  runningCount: number
  maxConcurrentTargets: number
  activeTargetChallenges: string[]
  activeRuns: Array<{
    id: string
    challengeId: string | null
    challengeName: string
    status: string
  }>
}

/** GET /api/events/:id/inbox — the scheduler DM view's status header
 * (v18): the orch channel key + its unread backlog + the global flush tick
 * + the per-event delivery hold. The timeline itself comes from the channel
 * messages endpoint via `channelKey`. */
export type InboxSnapshot = {
  channelKey: string
  unreadCount: number
  nextFlushAt: number | null
  deliveryPaused: boolean
}

/** W7.3: GET /api/events/:id/fleet — the overview's single poll (runs +
 * agents + scheduler run/agents + scheduler config/status). */
export type FleetInfo = {
  runs: RunPublic[]
  agentsByRun: Record<string, AgentSummary[]>
  schedulerRun: RunPublic | null
  schedulerAgents: AgentSummary[]
  config: {
    eventId: string
    modelId: string | null
    instruction: string
    maxConcurrentTargets: number
    /** W3: scheduler disabled (run-lifecycle events gated). */
    paused: boolean
  }
  status: SchedulerStatusSnapshot
}
