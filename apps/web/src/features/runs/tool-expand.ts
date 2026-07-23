import type { ConversationToolExpandPrefs } from "@/api"

export type ToolExpandCategory =
  | "fileRead"
  | "fileEdit"
  | "bash"
  | "target"
  | "flag"
  | "agent"

export function toolExpandCategory(name: string): ToolExpandCategory {
  switch (name) {
    case "read":
    case "ls":
    case "find":
    case "grep":
      return "fileRead"
    case "write":
    case "edit":
      return "fileEdit"
    case "bash":
      return "bash"
    case "get_target":
    case "start_target":
    case "extend_target":
    case "stop_target":
      return "target"
    case "submit_flag":
    case "finish_run":
      return "flag"
    default:
      return "agent"
  }
}

export function shouldAutoExpandTool(
  name: string,
  status: "pending" | "running" | "done" | "error",
  prefs: ConversationToolExpandPrefs
): boolean {
  if (status === "error" && prefs.errors) return true
  if (status !== "running") return false
  return prefs[toolExpandCategory(name)]
}
