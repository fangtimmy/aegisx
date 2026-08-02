import { Check, CircleDashed, CircleSlash, LoaderCircle, X } from "lucide-react"
import type { AgentStatus } from "@/api"
import { cn } from "@/lib/utils"

/**
 * Inline status glyph for an agent. Spins while running; uses the theme status
 * colors (info/success/destructive/muted). Sizes inherit from the parent unless
 * overridden via className (e.g. `[&_svg]:size-3.5`).
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
          : status === "stopped"
            ? CircleSlash
            : CircleDashed
  return (
    <span
      className={cn(
        "inline-flex shrink-0",
        status === "running" && "text-info",
        status === "completed" && "text-success",
        status === "failed" && "text-destructive",
        status === "stopped" && "text-muted-foreground",
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
