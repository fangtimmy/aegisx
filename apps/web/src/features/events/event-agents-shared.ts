import { isActiveAgentStatus } from "@aegisx/shared"

import type { AgentStatus, AgentSummary } from "@/api"
import { agentStatusLabel } from "@/features/runs/agent-overview"

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
  if (status === "completed")
    return { label: agentStatusLabel(status), variant: "success" }
  if (status === "failed")
    return { label: agentStatusLabel(status), variant: "destructive" }
  if (status === "aborted")
    return { label: agentStatusLabel(status), variant: "warning" }
  return null
}

/** The scheduler's lifecycle label (task list, overview stat, control panel
 * share it): 未启动 > 已暂停 > the agent status vocabulary. */
export function schedulerStatusLabel(
  agent: AgentSummary | null,
  paused: boolean
): string {
  const active = agent !== null && isActiveAgentStatus(agent.status)
  if (!active) return "未启动"
  if (paused) return "已暂停"
  return agentStatusLabel(agent.status)
}

/** The AgentsGraph active root node id (live agents + live scheduler). */
export const ACTIVE_NODE_ID = "active"
/** The AgentsGraph archive root node id (finished agents collapse under it;
 * expanded shows per-challenge groups, collapsed shows only the root). */
export const ARCHIVE_NODE_ID = "archive"

// Planned node sizes — used both for the dagre layout spacing and (roughly)
// matched by the Tailwind widths on each node component.
export const NODE_DIM = {
  active: { width: 176, height: 56 },
  archive: { width: 176, height: 56 },
  scheduler: { width: 176, height: 56 },
  challenge: { width: 208, height: 60 },
  agent: { width: 192, height: 56 },
} as const

export const EDGE_STYLE = {
  // root → challenge/scheduler: the navigation backbone, emphasized over
  // the agent edges below.
  challenge: {
    stroke: "var(--primary)",
    strokeOpacity: 0.45,
    strokeWidth: 1.5,
  },
  // challenge/scheduler → agent: execution attempts, kept faint.
  agent: { stroke: "var(--border)", strokeWidth: 1.5 },
} as const
