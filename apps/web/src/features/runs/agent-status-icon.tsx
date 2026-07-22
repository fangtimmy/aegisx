import {
  Check,
  CircleDashed,
  CircleSlash,
  LoaderCircle,
  Pause,
  X,
} from "lucide-react"
import type { AgentStatus } from "@/lib/api"
import { cn } from "@/lib/utils"

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
          : status === "paused"
            ? Pause
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
        status === "paused" && "text-warning",
        (status === "idle" || status === "stopped") && "text-muted-foreground",
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
