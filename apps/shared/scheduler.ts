/** Scheduler / fleet wire types. Canonical definition — the server's
 * scheduler-admin + routes and the web UI both import from here. */

import type { AgentSummary } from "./agent"

/** Next-task launch timing: 'eager' = a solved challenge frees its target
 * slot at flag acceptance (the next queue item launches immediately);
 * 'drained' = it holds the slot until its last agent goes terminal. */
export type NextTaskPolicy = "eager" | "drained"

/** Per-event orchestration policy (scheduler_config columns, camelCase wire
 * shape). Defaults live in the DB schema + run/scheduler-policy.ts. */
export type SchedulerPolicyConfig = {
  notifyTeamOnFlag: boolean
  stopSiblingsOnSolve: boolean
  stopTargetOnSolve: boolean
  nextTaskPolicy: NextTaskPolicy
  urgentTeamMessages: boolean
  /** A fully-solved challenge rejects new spawns (queue items cancel,
   * direct starts fail) while on; off = reproduction/writeup agents may
   * re-attack a solved challenge. */
  blockSpawnOnSolved: boolean
}

/** Fence + active-agent snapshot returned by get_status (the scheduler status
 * block of GET /api/events/:id/scheduler and /fleet). */
export type SchedulerStatusSnapshot = {
  maxConcurrentAgents: number
  liveAgentCount: number
  maxConcurrentTargets: number
  nextTaskPolicy: NextTaskPolicy
  activeTargetChallenges: string[]
  activeAgents: Array<{
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

/** Light challenge shape for the fleet view. */
export type ChallengeLite = {
  id: string
  name: string
  category: string | null
}

/** GET /api/events/:id/fleet — the overview's single poll (challenges +
 * per-challenge agents + scheduler agent + scheduler config/status). */
export type FleetInfo = {
  challenges: ChallengeLite[]
  agentsByChallenge: Record<string, AgentSummary[]>
  schedulerAgent: AgentSummary | null
  config: {
    eventId: string
    modelId: string | null
    instruction: string
    maxConcurrentTargets: number
    /** W3: scheduler disabled (agent-lifecycle events gated). */
    paused: boolean
  } & SchedulerPolicyConfig
  status: SchedulerStatusSnapshot
}
