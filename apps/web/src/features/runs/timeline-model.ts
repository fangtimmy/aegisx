import type { ConversationMessage } from "@/lib/api"

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

function handoffFromMessage(message: Record<string, unknown>, body: string) {
  const aegisx = isRecord(message.aegisx) ? message.aegisx : null
  const metadata = aegisx && isRecord(aegisx.metadata) ? aegisx.metadata : null
  const handoff =
    metadata && isRecord(metadata.handoff) ? metadata.handoff : null
  if (
    handoff &&
    typeof handoff.agentId === "string" &&
    typeof handoff.agentName === "string" &&
    typeof handoff.status === "string"
  ) {
    const marker = "\n\nFinal output:\n\n"
    return {
      agentId: handoff.agentId,
      agentName: handoff.agentName,
      status: handoff.status,
      body: body.includes(marker)
        ? body.slice(body.indexOf(marker) + marker.length)
        : body,
    }
  }
  const legacy = body.match(
    /^Background agent (.+) \(([^)]+)\) (completed|failed|stopped)\.\n\nFinal output:\n\n([\s\S]*)$/
  )
  return legacy
    ? {
        agentName: legacy[1],
        agentId: legacy[2],
        status: legacy[3],
        body: legacy[4],
      }
    : null
}

export type LiveEntry =
  | {
      key: string
      type: "message"
      message: Record<string, unknown>
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

export function buildConversation(
  history: ConversationMessage[],
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
    message: Record<string, unknown>,
    fallback?: string | number,
    stableKey?: string
  ) {
    const role = text(message.role)
    const timestamp = messageTimestamp(message, fallback)
    const identity = stableKey
    if (role === "user") {
      const body = contentText(message.content)
      if (body) {
        const handoff = handoffFromMessage(message, body)
        items.push(
          handoff
            ? {
                key: identity ?? `handoff:${items.length}`,
                type: "handoff",
                agentName: handoff.agentName,
                agentId: handoff.agentId,
                status: handoff.status,
                body: handoff.body,
                timestamp,
              }
            : {
                key: identity ?? `user:${items.length}`,
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
    const blockPrefix = identity ?? `message:${timestamp ?? items.length}`
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
    applyMessage(entry.message, entry.createdAt, entry.id)
  }

  for (const entry of live) {
    if (entry.type === "message") {
      applyMessage(entry.message, undefined, entry.key)
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
