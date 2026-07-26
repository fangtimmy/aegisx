import { LoaderCircle } from "lucide-react"
import { useCallback, useSyncExternalStore } from "react"
import type { AgentStatus } from "@/api"
import type { ConversationStore } from "./run-stream-store"

function formatTokenCount(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1000) return `${Math.round(value / 1000)}k`
  return String(Math.round(value))
}

function contextLabel(
  context: {
    usedTokens: number
    contextWindow: number
  } | null
) {
  if (!context || context.contextWindow <= 0 || context.usedTokens <= 0) {
    return null
  }
  const percent = Math.max(
    0,
    Math.round((context.usedTokens / context.contextWindow) * 100)
  )
  return `ctx ${formatTokenCount(context.usedTokens)} / ${formatTokenCount(context.contextWindow)} · ${percent}%`
}

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
    const context = stream.getContext(agentId)
    return `${agentStatus}|${activity?.activity ?? ""}|${activity?.detail ?? ""}|${running ? 1 : 0}|${context?.usedTokens ?? ""}|${context?.contextWindow ?? ""}`
  }, [stream, agentId, agentStatus])
  useSyncExternalStore(subscribe, getSignature, getSignature)

  if (agentStatus !== "running") return null
  const activity = stream.getActivity(agentId)
  const phase =
    activity?.activity === "compacting"
      ? "Compacting"
      : activity?.activity === "retrying"
        ? "Retrying"
        : stream.getRunningTool(agentId)
          ? "Working"
          : "Thinking"
  const context = contextLabel(stream.getContext(agentId))
  const label = context ? `${phase} · ${context}` : phase
  return (
    <span
      aria-live="polite"
      className="inline-flex items-center gap-1.5 text-info text-xs"
      role="status"
    >
      <LoaderCircle aria-hidden="true" className="size-3 animate-spin" />
      {label}
    </span>
  )
}
