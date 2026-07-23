import {
  type AgentSummary,
  type ConversationMessage,
  isPublicAgentMessage,
  type PublicAgentMessage,
  type RunPublic,
  type RunStreamEvent,
} from "@/api"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined
}

function isTerminal(
  value: unknown
): value is "timed_out" | "cancelled" | "failed" {
  return value === "timed_out" || value === "cancelled" || value === "failed"
}

function isTransientActivity(
  value: unknown
): value is "retrying" | "compacting" {
  return value === "retrying" || value === "compacting"
}

export function parseRunStreamEvent(
  value: unknown
): RunStreamEvent | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined
  if (value.type === "ready") {
    const cursor = numberValue(value.cursor)
    return typeof value.runId === "string" && cursor !== undefined
      ? { type: "ready", runId: value.runId, cursor }
      : undefined
  }
  if (value.type === "run.updated") {
    if (!isRecord(value.run)) return undefined
    const cursor = numberValue(value.cursor)
    return {
      type: "run.updated",
      run: value.run as RunPublic,
      ...(cursor !== undefined ? { cursor } : {}),
    }
  }
  if (value.type === "agent.updated") {
    if (!isRecord(value.agent)) return undefined
    const cursor = numberValue(value.cursor)
    return {
      type: "agent.updated",
      agent: value.agent as AgentSummary,
      ...(cursor !== undefined ? { cursor } : {}),
    }
  }
  if (value.type === "message.progress") {
    const revision = numberValue(value.revision)
    if (
      typeof value.agentId !== "string" ||
      typeof value.messageId !== "string" ||
      revision === undefined ||
      !isPublicAgentMessage(value.message)
    ) {
      return undefined
    }
    return {
      type: "message.progress",
      agentId: value.agentId,
      messageId: value.messageId,
      revision,
      message: value.message,
    }
  }
  if (value.type === "tool.progress") {
    const revision = numberValue(value.revision)
    const status = value.status
    return typeof value.agentId === "string" &&
      typeof value.toolCallId === "string" &&
      typeof value.toolName === "string" &&
      revision !== undefined &&
      (status === "running" || status === "done" || status === "error")
      ? {
          type: "tool.progress",
          agentId: value.agentId,
          toolCallId: value.toolCallId,
          revision,
          toolName: value.toolName,
          args: value.args,
          ...("result" in value ? { result: value.result } : {}),
          status,
          ...(value.isError === true ? { isError: true } : {}),
          ...(isTerminal(value.terminal)
            ? {
                terminal: value.terminal,
                ...(typeof value.terminalMessage === "string"
                  ? { terminalMessage: value.terminalMessage }
                  : {}),
              }
            : {}),
        }
      : undefined
  }
  if (value.type === "agent.activity") {
    if (typeof value.agentId !== "string") return undefined
    if (value.activity === null) {
      return { type: "agent.activity", agentId: value.agentId, activity: null }
    }
    if (!isTransientActivity(value.activity)) return undefined
    return {
      type: "agent.activity",
      agentId: value.agentId,
      activity: value.activity,
      ...(typeof value.detail === "string" ? { detail: value.detail } : {}),
    }
  }
  if (value.type === "message.committed") {
    const cursor = numberValue(value.cursor)
    if (
      typeof value.agentId !== "string" ||
      cursor === undefined ||
      !isRecord(value.message)
    ) {
      return undefined
    }
    const message = value.message
    if (
      typeof message.id !== "string" ||
      typeof message.agentId !== "string" ||
      typeof message.sequence !== "number" ||
      typeof message.createdAt !== "string" ||
      !isPublicAgentMessage(message.message)
    ) {
      return undefined
    }
    return {
      type: "message.committed",
      agentId: value.agentId,
      cursor,
      message: message as ConversationMessage,
    }
  }
  return undefined
}

export type { PublicAgentMessage }
