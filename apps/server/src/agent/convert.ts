import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type { Message as LlmMessage } from "@earendil-works/pi-ai"
import type {
  AssistantMessage,
  Message,
  ToolResultMessage,
  UserMessage,
} from "../../../shared"

/** Convert stored Message rows into pi-agent AgentMessage history. */
export function toAgentMessages(rows: Message[]): AgentMessage[] {
  return rows.map((row) => toAgentMessage(row))
}

export function toAgentMessage(row: Message): AgentMessage {
  const timestamp = row.timestamp ?? (Date.parse(row.createdAt) || Date.now())

  if (row.role === "user") {
    return {
      role: "user",
      content: row.content,
      timestamp,
    } as AgentMessage
  }

  if (row.role === "notice") {
    return {
      role: "user",
      content: row.text,
      timestamp,
    } as AgentMessage
  }

  if (row.role === "assistant") {
    return {
      role: "assistant",
      content: row.content,
      timestamp,
      stopReason: row.stopReason ?? "stop",
      errorMessage: row.errorMessage,
      api: row.api ?? "unknown",
      provider: row.provider ?? "unknown",
      model: row.model ?? "unknown",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
    } as AgentMessage
  }

  return {
    role: "toolResult",
    toolCallId: row.toolCallId,
    toolName: row.toolName,
    content: row.content,
    isError: row.isError,
    details: row.details,
    timestamp,
  } as AgentMessage
}

export function toLlmMessages(messages: AgentMessage[]): LlmMessage[] {
  return messages.flatMap((message) => {
    if (message.role === "assistant") return [message as LlmMessage]
    if (message.role === "user") {
      const content =
        typeof message.content === "string"
          ? [{ type: "text" as const, text: message.content }]
          : message.content
      return [
        {
          role: "user" as const,
          content,
          timestamp: message.timestamp ?? Date.now(),
        },
      ]
    }
    if (message.role === "toolResult") {
      const text = Array.isArray(message.content)
        ? message.content
            .map((part) =>
              typeof part === "string"
                ? part
                : part.type === "text"
                  ? part.text
                  : "[image]"
            )
            .join("\n")
        : String(message.content)
      return [
        {
          role: "user" as const,
          content: [
            {
              type: "text" as const,
              text: `[toolResult ${message.toolName}] ${text}`,
            },
          ],
          timestamp: message.timestamp ?? Date.now(),
        },
      ]
    }
    return []
  })
}

export function fromAgentMessage(
  message: AgentMessage,
  meta: { id: string; agentId: string; seq: number; createdAt: string }
): Message {
  if (message.role === "assistant") {
    const out: AssistantMessage = {
      role: "assistant",
      id: meta.id,
      seq: meta.seq,
      agentId: meta.agentId,
      createdAt: meta.createdAt,
      content: message.content as AssistantMessage["content"],
      stopReason: message.stopReason,
      errorMessage: message.errorMessage,
      api: message.api,
      provider: message.provider,
      model: message.model,
      timestamp: message.timestamp,
    }
    return out
  }
  if (message.role === "toolResult") {
    const out: ToolResultMessage = {
      role: "toolResult",
      id: meta.id,
      seq: meta.seq,
      agentId: meta.agentId,
      createdAt: meta.createdAt,
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      content: message.content as ToolResultMessage["content"],
      isError: message.isError,
      details: message.details,
      timestamp: message.timestamp,
    }
    return out
  }
  const content =
    message.role === "user"
      ? (message.content as UserMessage["content"])
      : JSON.stringify(message)
  const out: UserMessage = {
    role: "user",
    id: meta.id,
    seq: meta.seq,
    agentId: meta.agentId,
    createdAt: meta.createdAt,
    source: "user",
    content,
    timestamp:
      "timestamp" in message
        ? (message.timestamp as number | undefined)
        : undefined,
  }
  return out
}

export function assistantUsage(
  message: AgentMessage
): Record<string, unknown> | null {
  if (message.role !== "assistant" || !message.usage) return null
  const usage = message.usage
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    totalTokens: usage.totalTokens,
    cost: usage.cost,
  }
}
