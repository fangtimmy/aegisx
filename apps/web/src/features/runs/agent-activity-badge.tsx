import { LoaderCircle } from "lucide-react"
import { useCallback, useEffect, useState, useSyncExternalStore } from "react"

import type { AgentStatus } from "@/api"
import { formatDuration } from "@/lib/format"
import type { ConversationStore } from "@/stream/conversation-store"

/** Epoch ms of the last user message (the "time since your last message"
 * anchor for the running-turn footer). */
function lastUserMs(stream: ConversationStore, agentId: string): number | null {
  const items = stream.get(agentId)
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item.type === "user") {
      const ts = item.timestamp
      const ms =
        typeof ts === "number"
          ? ts
          : typeof ts === "string"
            ? Date.parse(ts)
            : Number.NaN
      return Number.isFinite(ms) ? ms : null
    }
  }
  return null
}

/**
 * Compact live-activity indicator for an agent. Reflects transient SDK states
 * (compacting / retrying) and, otherwise, whether a tool is mid-execution
 * ("Working…") or the model is simply producing a turn ("Thinking…"), plus
 * the elapsed time since the user's last message.
 */
export function AgentActivityBadge({
  stream,
  agentId,
  agentStatus,
}: {
  stream: ConversationStore
  agentId: string
  agentStatus: AgentStatus
}) {
  const subscribe = useCallback(
    (listener: () => void) => stream.subscribe(agentId, listener),
    [stream, agentId]
  )
  const getSignature = useCallback(() => {
    const activity = stream.getActivity(agentId)
    const running = stream.getRunningTool(agentId)
    const anchor = lastUserMs(stream, agentId)
    return `${agentStatus}|${activity?.activity ?? ""}|${activity?.attempt ?? ""}|${activity?.maxAttempts ?? ""}|${activity?.reason ?? ""}|${running ? 1 : 0}|${anchor ?? ""}`
  }, [stream, agentId, agentStatus])
  useSyncExternalStore(subscribe, getSignature, getSignature)

  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (agentStatus !== "running") return undefined
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [agentStatus])

  if (agentStatus !== "running") return null
  const activity = stream.getActivity(agentId)
  let label: string
  if (activity?.activity === "compacting") {
    label = "压缩上下文中…"
  } else if (activity?.activity === "retrying") {
    label =
      activity.attempt !== undefined && activity.maxAttempts !== undefined
        ? `重试 ${activity.attempt}/${activity.maxAttempts}…`
        : "重试中…"
  } else {
    label = stream.getRunningTool(agentId) ? "工作中…" : "思考中…"
  }
  const anchor = lastUserMs(stream, agentId)
  const elapsed = anchor !== null ? now - anchor : null
  return (
    <output
      aria-live="polite"
      className="inline-flex items-center gap-1.5 text-xs text-info"
    >
      <LoaderCircle aria-hidden="true" className="size-3 animate-spin" />
      {label}
      {elapsed !== null && (
        <span className="text-muted-foreground tabular-nums">
          · {formatDuration(elapsed)}
        </span>
      )}
    </output>
  )
}
