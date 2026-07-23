import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type { Api, Message, Model, Models } from "@earendil-works/pi-ai"
import type { UsageSummary } from "../../../shared"

export type CompactResult = {
  summary: string
  through: number
  usage: UsageSummary | null
}

function textMessage(text: string): Message {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  }
}

function contextSize(messages: AgentMessage[]) {
  return JSON.stringify(messages).length
}

function toLlm(messages: AgentMessage[]): Message[] {
  return messages.map((message) => {
    if (message.role === "user" || message.role === "assistant") {
      return message as Message
    }
    if (message.role === "toolResult") {
      return {
        role: "user" as const,
        content: [
          {
            type: "text" as const,
            text: `[tool ${message.toolName}] ${JSON.stringify(message.content)}`,
          },
        ],
        timestamp: message.timestamp ?? Date.now(),
      }
    }
    return textMessage(JSON.stringify(message))
  })
}

/**
 * Summarize older context when effective history exceeds model window budget.
 * Returns null when no compaction is needed or compaction fails softly.
 */
export async function maybeCompact(options: {
  model: Model<Api>
  models: Models
  messages: AgentMessage[]
  contextSummary: string | null
  contextThrough: number
  signal?: AbortSignal
  onActivity?(active: boolean): void
}): Promise<{
  effective: AgentMessage[]
  compact?: CompactResult
} | null> {
  const through = Math.min(options.contextThrough, options.messages.length)
  const tail = options.messages.slice(through)
  const summaryMessage = (summary: string): AgentMessage =>
    textMessage(`Previous conversation summary:\n\n${summary}`) as AgentMessage
  const effective = options.contextSummary
    ? [summaryMessage(options.contextSummary), ...tail]
    : tail
  const threshold = options.model.contextWindow * 3
  if (contextSize(effective) < threshold) {
    return { effective }
  }

  let keptSize = 0
  let keepAt = tail.length
  const keepBudget = options.model.contextWindow
  while (keepAt > 0 && keptSize < keepBudget) {
    keepAt -= 1
    keptSize += contextSize([tail[keepAt]])
  }
  while (keepAt < tail.length && tail[keepAt]?.role !== "user") {
    keepAt += 1
  }
  if (keepAt === 0 || keepAt === tail.length) return { effective }

  const compacted = [
    ...(options.contextSummary ? [summaryMessage(options.contextSummary)] : []),
    ...tail.slice(0, keepAt),
  ]
  options.onActivity?.(true)
  try {
    const response = await options.models.completeSimple(
      options.model,
      {
        systemPrompt:
          "Summarize the conversation for another agent. Preserve concrete findings, commands, files, failures, pending work, and constraints. Do not continue the task.",
        messages: [textMessage(JSON.stringify(toLlm(compacted)))],
      },
      { signal: options.signal, maxTokens: 4096 }
    )
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      return { effective }
    }
    const summary = response.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n")
      .trim()
    if (!summary) return { effective }

    const usage = response.usage
      ? {
          input: Number(response.usage.input ?? 0) || 0,
          output: Number(response.usage.output ?? 0) || 0,
          cacheRead: Number(response.usage.cacheRead ?? 0) || 0,
          cacheWrite: Number(response.usage.cacheWrite ?? 0) || 0,
          totalTokens: Number(response.usage.totalTokens ?? 0) || 0,
          cost:
            typeof response.usage.cost?.total === "number"
              ? response.usage.cost.total
              : null,
        }
      : null

    return {
      effective: [summaryMessage(summary), ...tail.slice(keepAt)],
      compact: {
        summary,
        through: through + keepAt,
        usage,
      },
    }
  } finally {
    options.onActivity?.(false)
  }
}
