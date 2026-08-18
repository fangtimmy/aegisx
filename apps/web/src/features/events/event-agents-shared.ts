import { Archive, Flag, Play, Puzzle, Timer } from "lucide-react"

import type { AgentStatus, AgentSummary } from "@/api"
export const UNCATEGORIZED = "未分类"

/** Overview poll cadence (ms). Unconditional — the scheduler acts server-side,
   so the fleet/queue/usage must refresh regardless of locally-known state. */
export const POLL_INTERVAL_MS = 5000

const ROLE_LABELS: Record<string, string> = {
  solver: "求解者",
  observer: "观察者",
  orchestrator: "调度者",
  child: "子代理",
}

export function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role
}

/** Terminal agent states — the attempt is over (completed / aborted /
 * failed); the challenge workspace and container may still be shared by
 * other live agents. */
export function isAgentFinished(agent: AgentSummary): boolean {
  return (
    agent.status === "completed" ||
    agent.status === "aborted" ||
    agent.status === "failed"
  )
}

/** Terminal-state badge for a finished agent; null while running / idle. */
export function agentFinishBadge(status: AgentStatus): {
  label: string
  variant: "success" | "destructive" | "warning"
} | null {
  if (status === "completed") return { label: "已完成", variant: "success" }
  if (status === "failed") return { label: "已失败", variant: "destructive" }
  if (status === "aborted") return { label: "已中断", variant: "warning" }
  return null
}

export type TimelineEvent = {
  time: string
  id: string
  kind: "agent" | "timeout" | "completed" | "flag" | "challenge"
  title: string
  detail: string
  agentId?: string
}

export const TIMELINE_ICONS: Record<TimelineEvent["kind"], typeof Play> = {
  agent: Play,
  timeout: Timer,
  completed: Archive,
  flag: Flag,
  challenge: Puzzle,
}

/** The AgentsGraph root node id (the event scheduler / orchestrator). */
export const SCHED_NODE_ID = "sched"
/** W7.2 group root: the archived aggregate (finished agents collapse into
 * it; expanded shows one node per finished attempt). */
export const ARCHIVE_NODE_ID = "archive"

// Planned node sizes — used both for the dagre layout spacing and (roughly)
// matched by the Tailwind widths on each node component.
export const NODE_DIM = {
  scheduler: { width: 176, height: 56 },
  challenge: { width: 208, height: 60 },
  archive: { width: 176, height: 56 },
  agent: { width: 192, height: 56 },
} as const

export const EDGE_STYLE = {
  // scheduler → challenge: the event's challenge backbone, emphasized over
  // the agent edges below.
  challenge: {
    stroke: "var(--primary)",
    strokeOpacity: 0.45,
    strokeWidth: 1.5,
  },
  // challenge → agent / archive → agent: execution attempts, kept faint.
  agent: { stroke: "var(--border)", strokeWidth: 1.5 },
} as const
