import type {
  CompactionEntry,
  EntryItem,
  SessionEntry,
  SessionMessageEntry,
} from "@/api"

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function text(value: unknown): string {
  if (typeof value === "string") return value
  if (value === null || value === undefined) return ""
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function truncateLabel(value: string, limit = 100): string {
  const line = value.split("\n", 1)[0].trim()
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line
}

/** Human label for a tool block header (v4 native + coding tools). */
export function toolStatusLabel(
  name: string,
  args: unknown,
  running: boolean
): string {
  const a = isRecord(args) ? args : null
  const subject = (() => {
    switch (name) {
      case "bash":
        return truncateLabel(text(a?.command), 80)
      case "read":
      case "write":
      case "edit":
        return truncateLabel(text(a?.filePath ?? a?.path))
      case "grep":
      case "find": {
        const pattern = text(a?.pattern)
        return pattern ? `"${pattern}"` : ""
      }
      case "ls":
        return truncateLabel(text(a?.path)) || ""
      case "spawn_agent":
        return truncateLabel(text(a?.name)) || truncateLabel(text(a?.task), 60)
      case "inspect_agent":
        return truncateLabel(text(a?.agent_id)) || ""
      default:
        return ""
    }
  })()
  const verb = (() => {
    switch (name) {
      case "bash":
        return running ? "Running" : "Ran"
      case "read":
        return running ? "Reading" : "Read"
      case "write":
        return running ? "Writing" : "Wrote"
      case "edit":
        return running ? "Editing" : "Edited"
      case "grep":
        return running ? "Searching for" : "Searched for"
      case "find":
        return running ? "Finding" : "Found"
      case "ls":
        return running ? "Listing" : "Listed"
      case "submit_flag":
        return running ? "Submitting flag" : "Submitted flag"
      case "finish_run":
        return running ? "Finishing run" : "Finished run"
      case "spawn_agent":
        return running ? "Spawning agent" : "Spawned agent"
      case "inspect_agent":
        return running ? "Inspecting agent" : "Inspected agent"
      case "get_target":
        return running ? "Checking target" : "Checked target"
      case "start_target":
        return running ? "Starting target" : "Started target"
      case "extend_target":
        return running ? "Extending target" : "Extended target"
      case "stop_target":
        return running ? "Stopping target" : "Stopped target"
      default:
        return running ? `Running ${name}` : name
    }
  })()
  const label = subject ? `${verb} ${subject}` : verb
  return label.length > 100 ? `${label.slice(0, 99)}…` : label
}

export type LiveEntry =
  | {
      key: string
      type: "message"
      entry: SessionEntry
    }
  | {
      key: string
      type: "tool"
      toolCallId: string
      toolName: string
      args: unknown
      result?: unknown
      isError: boolean
      status: "running" | "done"
      terminal?: "timed_out" | "cancelled" | "failed"
      terminalMessage?: string
    }
  | {
      key: string
      type: "error"
      body: string
    }

export type ToolBlock = {
  key: string
  type: "tool"
  id: string
  name: string
  args: unknown
  output: string
  status: "pending" | "running" | "done" | "error"
  terminal?: "timed_out" | "cancelled" | "failed"
  terminalMessage?: string
}

type AgentBlock =
  | { key: string; type: "text"; body: string }
  | { key: string; type: "reasoning"; body: string; durationMs?: number }
  | { key: string; type: "error"; body: string }
  | ToolBlock

export type ConversationItem =
  | {
      key: string
      type: "system"
      kind?: "compact_start" | "compact_end"
      title: string
      detail?: string
      timestamp?: string | number
    }
  | {
      key: string
      type: "user"
      body: string
      timestamp?: string | number
    }
  | {
      key: string
      type: "agent"
      blocks: AgentBlock[]
      timestamp?: string | number
    }

function contentText(content: unknown) {
  const values = Array.isArray(content) ? content : [content]
  return values
    .flatMap((part) => {
      if (typeof part === "string") return part
      if (!isRecord(part)) return []
      if (part.type === "text") return text(part.text)
      if (part.type === "image") return `[Image: ${text(part.mimeType)}]`
      return []
    })
    .filter(Boolean)
    .join("\n")
}

function resultText(value: unknown) {
  if (isRecord(value) && "content" in value) {
    return contentText(value.content) || text(value)
  }
  return text(value)
}

type ConversationAgentItem = Extract<ConversationItem, { type: "agent" }>

function applyUser(
  entry: SessionMessageEntry,
  items: ConversationItem[],
  stableKey: string
) {
  const message = entry.message
  if (message.role !== "user") return
  const body = contentText(message.content)
  if (!body) return
  items.push({
    key: stableKey,
    type: "user",
    body,
    timestamp: entry.timestamp,
  })
}

/** Format a token count like the pi-TUI compaction marker. */
function formatTokens(count: number): string {
  if (count < 1000) return String(count)
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`
  return `${(count / 1_000_000).toFixed(1)}M`
}

function applyCompaction(
  entry: CompactionEntry,
  items: ConversationItem[],
  stableKey: string
) {
  const title = `Compacted ${formatTokens(entry.tokensBefore)} tokens`
  items.push({
    key: stableKey,
    type: "system",
    kind: "compact_end",
    title,
    timestamp: entry.timestamp,
  })
}

function applyToolResult(
  entry: SessionMessageEntry,
  tools: Map<string, ToolBlock>,
  currentAgent: (timestamp?: string | number) => ConversationAgentItem
) {
  const message = entry.message
  if (message.role !== "toolResult") return
  const id = message.toolCallId
  const existing = tools.get(id)
  const block =
    existing ??
    ({
      key: `tool:${id}`,
      type: "tool",
      id,
      name: message.toolName || "unknown",
      args: null,
      output: "",
      status: "pending",
    } satisfies ToolBlock)
  block.output = contentText(message.content) || resultText(message.details)
  block.status = message.isError ? "error" : "done"
  if (!existing) {
    currentAgent(entry.timestamp).blocks.push(block)
    tools.set(id, block)
  }
}

function applyAssistant(
  entry: SessionMessageEntry,
  tools: Map<string, ToolBlock>,
  currentAgent: (timestamp?: string | number) => ConversationAgentItem,
  stableKey: string
) {
  const message = entry.message
  if (message.role !== "assistant") return
  const timestamp = entry.timestamp
  const blocks = currentAgent(timestamp).blocks
  const blockPrefix = stableKey
  for (const [index, part] of message.content.entries()) {
    const key = `${blockPrefix}:${index}`
    if (!isRecord(part)) continue
    if (part.type === "text") {
      const body = text(part.text)
      if (body.trim()) blocks.push({ key, type: "text", body })
    } else if (part.type === "thinking") {
      const body = text(part.thinking)
      if (body.trim()) blocks.push({ key, type: "reasoning", body })
    } else if (part.type === "toolCall") {
      const id = text(part.id)
      const block: ToolBlock = {
        key: `tool:${id}`,
        type: "tool",
        id,
        name: text(part.name) || "unknown",
        args: part.arguments,
        output: "",
        status: "pending",
      }
      blocks.push(block)
      tools.set(id, block)
    }
  }
  if (message.stopReason === "error" && message.errorMessage) {
    blocks.push({
      key: `${blockPrefix}:error`,
      type: "error",
      body: text(message.errorMessage),
    })
  }
}

export function buildConversation(
  history: EntryItem[],
  live: LiveEntry[]
): ConversationItem[] {
  const items: ConversationItem[] = []
  const tools = new Map<string, ToolBlock>()
  let agent: ConversationAgentItem | null = null

  const currentAgent = (timestamp?: string | number): ConversationAgentItem => {
    if (agent) return agent
    agent = {
      key: `agent:${items.length}:${timestamp ?? "live"}`,
      type: "agent",
      blocks: [],
      timestamp,
    }
    items.push(agent)
    return agent
  }

  const applyEntry = (entry: SessionEntry, stableKey: string) => {
    if (entry.type === "message") {
      const message = entry.message
      if (message.role === "user") {
        applyUser(entry, items, stableKey)
        agent = null
        return
      }
      if (message.role === "assistant") {
        applyAssistant(entry, tools, currentAgent, stableKey)
        return
      }
      if (message.role === "toolResult") {
        applyToolResult(entry, tools, currentAgent)
        return
      }
      // bashExecution / custom / branchSummary / compactionSummary roles are
      // not produced by AegisX's zero-extension agent; ignore if seen.
      return
    }
    if (entry.type === "compaction") {
      applyCompaction(entry, items, stableKey)
      agent = null
      return
    }
    if (entry.type === "branch_summary") {
      items.push({
        key: stableKey,
        type: "system",
        kind: "compact_end",
        title: "Branched from an earlier point",
        timestamp: entry.timestamp,
      })
      agent = null
      return
    }
  }

  for (const item of history) {
    applyEntry(item.entry, item.key)
  }

  for (const entry of live) {
    if (entry.type === "message") {
      applyEntry(entry.entry, `message:${entry.key}`)
    } else if (entry.type === "tool") {
      const existing = tools.get(entry.toolCallId)
      const block =
        existing ??
        ({
          key: entry.key,
          type: "tool",
          id: entry.toolCallId,
          name: entry.toolName,
          args: null,
          output: "",
          status: "pending",
        } satisfies ToolBlock)
      block.args = entry.args ?? block.args
      block.output = resultText(entry.result)
      block.status = entry.isError
        ? "error"
        : entry.status === "done"
          ? "done"
          : "running"
      if (entry.terminal) {
        block.terminal = entry.terminal
        if (entry.terminalMessage) block.terminalMessage = entry.terminalMessage
      }
      if (!existing) {
        currentAgent().blocks.push(block)
        tools.set(entry.toolCallId, block)
      }
    } else if (entry.body) {
      currentAgent().blocks.push({
        key: entry.key,
        type: "error",
        body: entry.body,
      })
    }
  }

  return items.filter((item) => item.type !== "agent" || item.blocks.length > 0)
}
