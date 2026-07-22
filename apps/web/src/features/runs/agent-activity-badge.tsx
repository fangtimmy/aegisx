import { LoaderCircle } from "lucide-react"
import { useCallback, useSyncExternalStore } from "react"
import type { AgentStatus } from "@/lib/api"
import type { RunStreamStore } from "./run-stream-store"

export function AgentActivityBadge({
  stream,
  agentId,
  agentStatus,
}: {
  stream: RunStreamStore
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
    return `${agentStatus}|${activity?.activity ?? ""}|${activity?.detail ?? ""}|${running ? 1 : 0}`
  }, [stream, agentId, agentStatus])
  useSyncExternalStore(subscribe, getSignature, getSignature)

  if (agentStatus !== "running") return null
  const activity = stream.getActivity(agentId)
  const label =
    activity?.activity === "compacting"
      ? "Compacting context…"
      : activity?.activity === "retrying"
        ? "Retrying…"
        : stream.getRunningTool(agentId)
          ? "Working…"
          : "Thinking…"
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
