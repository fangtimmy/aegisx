import { LoaderCircle } from "lucide-react"
import { useCallback, useSyncExternalStore } from "react"
import type { AgentStatus } from "@/lib/api"
import type { RunStreamStore } from "./run-stream-store"

function text(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function activityToolLabel(name: string, args: unknown): string {
  const record =
    args && typeof args === "object" && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : null
  if (name === "bash") {
    const cmd = text(record?.command).split("\n", 1)[0]
    return cmd ? `Running ${cmd}` : "Running command"
  }
  const verbs: Record<string, string> = {
    submit_flag: "Submitting flag",
    start_target: "Starting target",
    stop_target: "Stopping target",
    get_target: "Checking target",
    extend_target: "Extending target",
    read: "Reading file",
    grep: "Searching",
    find: "Finding files",
    ls: "Listing files",
    edit: "Editing file",
    write: "Writing file",
    finish_run: "Finishing run",
    spawn_agent: "Spawning agent",
    inspect_agent: "Inspecting agent",
  }
  return verbs[name] ?? `Running ${name}`
}

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
    return `${agentStatus}|${activity?.activity ?? ""}|${activity?.detail ?? ""}|${running?.toolName ?? ""}`
  }, [stream, agentId, agentStatus])
  useSyncExternalStore(subscribe, getSignature, getSignature)

  if (agentStatus !== "running") return null
  const activity = stream.getActivity(agentId)
  let label: string
  if (activity?.activity === "compacting") {
    label = "Compacting context…"
  } else if (activity?.activity === "retrying") {
    label = activity.detail ? `Retrying… (${activity.detail})` : "Retrying…"
  } else {
    const running = stream.getRunningTool(agentId)
    label = running
      ? `${activityToolLabel(running.toolName, running.args)}…`
      : "Thinking…"
  }
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
