import type {
  AssistantMessage,
  Message,
  NoticeMessage,
  ToolResultMessage,
  UserMessage,
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
        return truncateLabel(text(a?.path))
      case "grep":
      case "find": {
        const pattern = text(a?.pattern)
        return pattern ? `“${pattern}”` : ""
      }
      case "ls":
        return truncateLabel(text(a?.path)) || ""
      case "spawn_agent":
        return truncateLabel(text(a?.name))
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
        return running ? "Finishing run" : "Completed run"
      case "spawn_agent":
        return running ? "Spawning agent" : "Started agent"
      case "inspect_agent":
        return running ? "Inspecting agent" : "Inspected agent"
      case "get_target":
        return running ? "Checking target" : "Checked target"
      case "start_target":
        return running ? "Starting target" : "Started target"
      case "extend_target":
        return running ? "Extending target" : "Extended target lifetime"
      case "stop_target":
        return running ? "Stopping target" : "Stopped target"
      default:
        return running ? `Running ${name}` : name
    }
  })()
  const label = subject ? `${verb} ${subject}` : verb
  return label.length > 100 ? `${label.slice(0, 99)}…` : label
}

function handoffFromNotice(message: NoticeMessage) {
  if (!message.handoff) return null
  const marker = "\n\nFinal output:\n\n"
  return {
    agentId: message.handoff.agentId,
    agentName: message.handoff.agentName,
    status: message.handoff.status,
    body: message.text.includes(marker)
      ? message.text.slice(message.text.indexOf(marker) + marker.length)
      : message.text,
  }
}

export type LiveEntry =
  | {
      key: string
      type: "message"
      message: Message
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
  | {
      key: string
      type: "reasoning"
      body: string
      durationMs?: number
    }
  | { key: string; type: "error"; body: string }
  | ToolBlock

export type ConversationItem =
  | {
      key: string
      type: "handoff"
      agentId: string
      agentName: string
      status: string
      body: string
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

function messageTimestamp(message: Message, fallback?: string | number) {
  return typeof message.timestamp === "number" ? message.timestamp : fallback
}

function messageDuration(message: Message, endedAt?: string | number) {
  if (typeof message.timestamp !== "number" || endedAt === undefined) {
    return undefined
  }
  const end =
    typeof endedAt === "number" ? endedAt : new Date(endedAt).getTime()
  const duration = end - message.timestamp
  return Number.isFinite(duration) && duration >= 0 ? duration : undefined
}

function applyUser(
  message: UserMessage,
  items: ConversationItem[],
  fallback?: string | number,
  stableKey?: string
) {
  const body = contentText(message.content)
  if (!body) return
  const timestamp = messageTimestamp(message, fallback)
  items.push({
    key: stableKey ?? `user:${items.length}`,
    type: "user",
    body,
    timestamp,
  })
}

function applyNotice(
  message: NoticeMessage,
  items: ConversationItem[],
  fallback?: string | number,
  stableKey?: string
) {
  const timestamp = messageTimestamp(message, fallback)
  const handoff = handoffFromNotice(message)
  if (handoff) {
    items.push({
      key: stableKey ?? `handoff:${items.length}`,
      type: "handoff",
      agentName: handoff.agentName,
      agentId: handoff.agentId,
      status: handoff.status,
      body: handoff.body,
      timestamp,
    })
    return
  }
  if (!message.text.trim()) return
  items.push({
    key: stableKey ?? `notice:${items.length}`,
    type: "user",
    body: message.text,
    timestamp,
  })
}

function applyToolResult(
  message: ToolResultMessage,
  tools: Map<string, ToolBlock>,
  currentAgent: (
    timestamp?: string | number
  ) => Extract<ConversationItem, { type: "agent" }>,
  timestamp?: string | number
) {
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
    currentAgent(timestamp).blocks.push(block)
    tools.set(id, block)
  }
}

function applyAssistant(
  message: AssistantMessage,
  tools: Map<string, ToolBlock>,
  currentAgent: (
    timestamp?: string | number
  ) => Extract<ConversationItem, { type: "agent" }>,
  itemsLength: number,
  fallback?: string | number,
  stableKey?: string
) {
  const timestamp = messageTimestamp(message, fallback)
  const blocks = currentAgent(timestamp).blocks
  const blockPrefix = stableKey ?? `message:${timestamp ?? itemsLength}`
  const durationMs = messageDuration(message, fallback)
  const content = Array.isArray(message.content)
    ? message.content
    : [message.content]
  for (const [index, part] of content.entries()) {
    const key = `${blockPrefix}:${index}`
    if (typeof part === "string") {
      if (part.trim()) blocks.push({ key, type: "text", body: part })
      continue
    }
    if (!isRecord(part)) continue
    if (part.type === "text") {
      const body = text(part.text)
      if (body.trim()) blocks.push({ key, type: "text", body })
    } else if (part.type === "thinking") {
      const body = text(part.thinking)
      if (body.trim()) {
        blocks.push({ key, type: "reasoning", body, durationMs })
      }
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
  history: Message[],
  live: LiveEntry[]
): ConversationItem[] {
  const items: ConversationItem[] = []
  const tools = new Map<string, ToolBlock>()
  let agent: Extract<ConversationItem, { type: "agent" }> | null = null

  function currentAgent(timestamp?: string | number) {
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

  function applyMessage(
    message: Message,
    fallback?: string | number,
    stableKey?: string
  ) {
    if (message.role === "user") {
      applyUser(message, items, fallback, stableKey)
      agent = null
      return
    }
    if (message.role === "notice") {
      applyNotice(message, items, fallback, stableKey)
      agent = null
      return
    }
    if (message.role === "toolResult") {
      applyToolResult(
        message,
        tools,
        currentAgent,
        messageTimestamp(message, fallback)
      )
      return
    }
    if (message.role === "assistant") {
      applyAssistant(
        message,
        tools,
        currentAgent,
        items.length,
        fallback,
        stableKey
      )
    }
  }

  for (const entry of history) {
    applyMessage(entry, entry.createdAt, entry.id)
  }

  for (const entry of live) {
    if (entry.type === "message") {
      applyMessage(entry.message, entry.message.createdAt, entry.key)
    } else if (entry.type === "tool") {
      const existing = tools.get(entry.toolCallId)
      const block =
        existing ??
        ({
          key: entry.key,
          type: "tool",
          id: entry.toolCallId,
          name: entry.toolName,
          args: entry.args,
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
