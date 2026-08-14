import { Check, CircleDashed, LoaderCircle, OctagonX, X } from "lucide-react"

import type { AgentStatus } from "@/api"
import { cn } from "@/lib/utils"

function agentStatusLabel(status: AgentStatus): string {
  if (status === "running") return "运行中"
  if (status === "completed") return "已完成"
  if (status === "aborted") return "已中断"
  if (status === "failed") return "已失败"
  return "空闲"
}

/**
 * Inline status glyph for an agent. Spins while running; uses the theme status
 * colors (info/success/destructive/muted). The main agent uses running|idle;
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
        status === "running" && "text-info",
        status === "completed" && "text-success",
        status === "aborted" && "text-warning",
        status === "failed" && "text-destructive",
        status === "idle" && "text-muted-foreground",
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
