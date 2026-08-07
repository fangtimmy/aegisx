import { LoaderCircle } from "lucide-react"
import { useCallback, useSyncExternalStore } from "react"

import type { AgentStatus } from "@/api"
import type { ConversationStore } from "@/stream/conversation-store"

/**
 * Compact live-activity indicator for an agent. Reflects transient SDK states
 * (compacting / retrying) and, otherwise, whether a tool is mid-execution
 * ("Working…") or the model is simply producing a turn ("Thinking…").
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
    return `${agentStatus}|${activity?.activity ?? ""}|${activity?.attempt ?? ""}|${activity?.maxAttempts ?? ""}|${activity?.reason ?? ""}|${activity?.tokensBefore ?? ""}|${activity?.tokensAfter ?? ""}|${running ? 1 : 0}`
  }, [stream, agentId, agentStatus])
  useSyncExternalStore(subscribe, getSignature, getSignature)

  if (agentStatus !== "running") return null
  const activity = stream.getActivity(agentId)
  let label: string
  if (activity?.activity === "compacting") {
    const before = activity.tokensBefore
    const after = activity.tokensAfter
    label =
      before !== undefined && after !== undefined
        ? `压缩中 ${formatBadgeTokens(before)} → ~${formatBadgeTokens(after)}…`
        : "压缩上下文中…"
  } else if (activity?.activity === "retrying") {
    label =
      activity.attempt !== undefined && activity.maxAttempts !== undefined
        ? `重试 ${activity.attempt}/${activity.maxAttempts}…`
        : "重试中…"
  } else {
    label = stream.getRunningTool(agentId) ? "工作中…" : "思考中…"
  }
  return (
    <span
      aria-live="polite"
      className="inline-flex items-center gap-1.5 text-xs text-info"
      role="status"
    >
      <LoaderCircle aria-hidden="true" className="size-3 animate-spin" />
      {label}
    </span>
  )
}

function formatBadgeTokens(count: number): string {
  if (count < 1000) return String(count)
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`
  return `${(count / 1_000_000).toFixed(1)}M`
}
