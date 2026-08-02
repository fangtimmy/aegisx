import { Check, CircleDashed, LoaderCircle, X } from "lucide-react"
import type { AgentStatus } from "@/api"
import { cn } from "@/lib/utils"

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
        : status === "failed"
          ? X
          : CircleDashed // idle
  return (
    <span
      className={cn(
        "inline-flex shrink-0",
        status === "running" && "text-info",
        status === "completed" && "text-success",
        status === "failed" && "text-destructive",
        status === "idle" && "text-muted-foreground",
        className
      )}
      title={status}
    >
      <Icon
        aria-hidden="true"
        className={status === "running" ? "animate-spin" : undefined}
      />
      <span className="sr-only">{status}</span>
    </span>
  )
}
