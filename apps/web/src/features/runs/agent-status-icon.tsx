import { Check, CircleDashed, LoaderCircle, OctagonX, X } from "lucide-react"

import type { AgentStatus } from "@/api"
import {
  agentStatusLabel,
  agentStatusVisual,
} from "@/features/runs/agent-overview"
import { cn } from "@/lib/utils"

/**
 * Inline status glyph for an agent. Spins while running; uses the shared
 * status colors (agentStatusVisual). The main agent uses running|idle;
 * children use completed|failed. Sizes inherit unless overridden via className.
 */
export function AgentStatusIcon({
  status,
  className,
}: {
  status: AgentStatus
  className?: string
}) {
  const Icon =
    status === "running"
      ? LoaderCircle
      : status === "completed"
        ? Check
        : status === "aborted"
          ? OctagonX
          : status === "failed"
            ? X
            : CircleDashed // idle
  return (
    <span
      className={cn(
        "inline-flex shrink-0",
        agentStatusVisual[status].text,
        className
      )}
      title={agentStatusLabel(status)}
    >
      <Icon
        aria-hidden="true"
        className={status === "running" ? "animate-spin" : undefined}
      />
      <span className="sr-only">{agentStatusLabel(status)}</span>
    </span>
  )
}
