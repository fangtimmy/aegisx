import { useCallback, useSyncExternalStore } from "react"

import { cn } from "@/lib/utils"
import { ConversationStore } from "@/stream/conversation-store"

/** Format token counts for the stat strip, matching the pi-TUI footer rules. */
function formatStatTokens(count: number): string {
  if (count < 1000) return String(count)
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  return `${Math.round(count / 1_000_000)}M`
}

/** Live per-agent context meter for the message box (pi-TUI footer parity):
 * ↑input ↓output RcacheRead WcacheWrite CH% $cost  percent%/window. */
export function ContextStatStrip({
  agentId,
  stream,
  className,
}: {
  agentId: string
  stream: ConversationStore
  className?: string
}) {
  const subscribe = useCallback(
    (listener: () => void) => stream.subscribe(agentId, listener),
    [stream, agentId]
  )
  const snapshot = useSyncExternalStore(
    subscribe,
    () => stream.getContext(agentId),
    () => stream.getContext(agentId)
  )
  if (!snapshot) return null
  const t = snapshot.totals
  const parts: Array<{ label: string; tone?: "warn" | "danger" }> = []
  if (t.input) parts.push({ label: `↑${formatStatTokens(t.input)}` })
  if (t.output) parts.push({ label: `↓${formatStatTokens(t.output)}` })
  if (t.cacheRead) parts.push({ label: `R${formatStatTokens(t.cacheRead)}` })
  if (t.cacheWrite) parts.push({ label: `W${formatStatTokens(t.cacheWrite)}` })
  if (snapshot.cacheHitRate !== null && (t.cacheRead > 0 || t.cacheWrite > 0))
    parts.push({ label: `CH${snapshot.cacheHitRate.toFixed(1)}%` })
  if (t.cost > 0) parts.push({ label: `$${t.cost.toFixed(3)}` })
  const percent = snapshot.percent
  const ctxTone =
    percent !== null && percent > 90
      ? "danger"
      : percent !== null && percent > 70
        ? "warn"
        : undefined
  parts.push({
    label:
      percent === null
        ? `?/${formatStatTokens(snapshot.contextWindow)}`
        : `${percent.toFixed(1)}%/${formatStatTokens(snapshot.contextWindow)}`,
    tone: ctxTone,
  })
  return (
    <span className={cn("font-mono text-muted-foreground", className)}>
      {parts.map((part) => (
        <span
          className={cn(
            "ml-2.5 first:ml-0",
            part.tone === "danger" && "text-destructive",
            part.tone === "warn" && "text-warning"
          )}
          key={part.label}
        >
          {part.label}
        </span>
      ))}
    </span>
  )
}
