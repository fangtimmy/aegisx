import type { SessionEntry } from "@/lib/api"

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

function messageKey(message: Record<string, unknown>) {
  const role = text(message.role)
  const timestamp = text(message.timestamp)
  return role && timestamp ? `message:${role}:${timestamp}` : null
}

export type LiveEntry =
  | {
      key: string
      type: "message"
      message: Record<string, unknown>
      endedAt?: number
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
    }
  | {
      key: string
      type: "error"
      body: string
    }

export function mergeLiveEntries(current: LiveEntry[], updates: LiveEntry[]) {
  const next = [...current]
  for (const entry of updates) {
    const index =
      entry.type === "message" &&
      entry.message.role === "assistant" &&
      entry.message.stopReason &&
      entry.endedAt !== undefined &&
      !next.some((value) => value.key === entry.key)
        ? next.findLastIndex(
            (value) =>
              value.type === "message" &&
              value.message.role === "assistant" &&
              value.endedAt === undefined
          )
        : next.findIndex((value) => value.key === entry.key)
    if (index === -1) next.push(entry)
    else next[index] = { ...entry, key: next[index].key }
  }
  return next
}

export type ToolBlock = {
  key: string
  type: "tool"
  id: string
  name: string
  args: unknown
  output: string
  status: "pending" | "running" | "done" | "error"
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
  | {
      key: string
      type: "notice"
      label: string
      body: string
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

function messageTimestamp(
  message: Record<string, unknown>,
  fallback?: string | number
) {
  return typeof message.timestamp === "number" ? message.timestamp : fallback
}

function messageDuration(
  message: Record<string, unknown>,
  endedAt?: string | number
) {
  if (typeof message.timestamp !== "number" || endedAt === undefined) {
    return undefined
  }
  const end =
    typeof endedAt === "number" ? endedAt : new Date(endedAt).getTime()
  const duration = end - message.timestamp
  return Number.isFinite(duration) && duration >= 0 ? duration : undefined
}

export function liveEntries(payload: Record<string, unknown>): LiveEntry[] {
  const type = text(payload.type)
  const message = isRecord(payload.message) ? payload.message : null
  if (
    (type === "message_start" ||
      type === "message_update" ||
      type === "message_end") &&
    message
  ) {
    const key = messageKey(message)
    return key
      ? [
          {
            key,
            type: "message",
            message,
            endedAt: type === "message_end" ? Date.now() : undefined,
          },
        ]
      : []
  }
  if (type.startsWith("tool_execution_")) {
    const toolCallId = text(payload.toolCallId)
    if (!toolCallId) return []
    const ended = type === "tool_execution_end"
    return [
      {
        key: `tool:${toolCallId}`,
        type: "tool",
        toolCallId,
        toolName: text(payload.toolName) || "unknown",
        args: payload.args,
        result: ended ? payload.result : payload.partialResult,
        isError: Boolean(payload.isError),
        status: ended ? "done" : "running",
      },
    ]
  }
  if (type.includes("error") || payload.error) {
    return [
      {
        key: `error:${type}`,
        type: "error",
        body: text(payload.error ?? payload.errorMessage ?? payload.message),
      },
    ]
  }
  return []
}

export function buildConversation(
  history: SessionEntry[],
  live: LiveEntry[]
): ConversationItem[] {
  const items: ConversationItem[] = []
  const tools = new Map<string, ToolBlock>()
  const persistedMessages = new Set<string>()
  const persistedTools = new Set<string>()
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
    message: Record<string, unknown>,
    fallback?: string | number
  ) {
    const role = text(message.role)
    const timestamp = messageTimestamp(message, fallback)
    if (role === "user") {
      const body = contentText(message.content)
      if (body) {
        const handoff = body.match(
          /^Background agent (.+) \(([^)]+)\) (completed|failed|stopped)\.\n\nFinal output:\n\n([\s\S]*)$/
        )
        items.push(
          handoff
            ? {
                key: messageKey(message) ?? `handoff:${items.length}`,
                type: "handoff",
                agentName: handoff[1],
                agentId: handoff[2],
                status: handoff[3],
                body: handoff[4],
                timestamp,
              }
            : {
                key: messageKey(message) ?? `user:${items.length}`,
                type: "user",
                body,
                timestamp,
              }
        )
      }
      agent = null
      return
    }
    if (role === "toolResult") {
      const id = text(message.toolCallId)
      const existing = tools.get(id)
      const block =
        existing ??
        ({
          key: `tool:${id}`,
          type: "tool",
          id,
          name: text(message.toolName) || "unknown",
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
      return
    }
    if (role !== "assistant") return

    const blocks = currentAgent(timestamp).blocks
    const blockPrefix =
      messageKey(message) ?? `message:${timestamp ?? items.length}`
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

  for (const entry of history) {
    if (entry.type === "message" && isRecord(entry.message)) {
      const key = messageKey(entry.message)
      if (key) persistedMessages.add(key)
      if (entry.message.role === "toolResult") {
        const id = text(entry.message.toolCallId)
        if (id) persistedTools.add(`tool:${id}`)
      }
      applyMessage(entry.message, entry.timestamp)
    } else if (entry.type === "model_change") {
      items.push({
        key: entry.id,
        type: "notice",
        label: `Model changed to ${text(entry.modelId)}`,
        body: "",
        timestamp: entry.timestamp,
      })
      agent = null
    } else if (entry.type === "compaction" || entry.type === "branch_summary") {
      items.push({
        key: entry.id,
        type: "notice",
        label:
          entry.type === "compaction" ? "Context compacted" : "Branch summary",
        body: text(entry.summary),
        timestamp: entry.timestamp,
      })
      agent = null
    }
  }

  for (const entry of live) {
    if (entry.type === "message") {
      const key = messageKey(entry.message)
      const toolKey =
        entry.message.role === "toolResult"
          ? `tool:${text(entry.message.toolCallId)}`
          : null
      if (
        (key && persistedMessages.has(key)) ||
        (toolKey && persistedTools.has(toolKey))
      ) {
        continue
      }
      applyMessage(entry.message, entry.endedAt)
    } else if (entry.type === "tool") {
      if (persistedTools.has(entry.key)) continue
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
