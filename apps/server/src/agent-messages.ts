import type { AgentMessage } from "@earendil-works/pi-agent-core"

export type InboxKind = "user" | "child_result" | "resume"

export type AegisXMetadata = {
  handoff?: {
    agentId: string
    agentName: string
    status: string
  }
}

export type AegisXMessage = {
  role: "aegisx"
  id: string
  kind: InboxKind
  text: string
  timestamp: number
  metadata?: AegisXMetadata
}

declare module "@earendil-works/pi-agent-core" {
  interface CustomAgentMessages {
    aegisx: AegisXMessage
  }
}

type RecordValue = Record<string, unknown>

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === "string"
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function isTextContent(value: unknown): boolean {
  return isRecord(value) && value.type === "text" && isString(value.text)
}

function isImageContent(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.type === "image" &&
    isString(value.data) &&
    isString(value.mimeType)
  )
}

function isThinkingContent(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.type === "thinking" &&
    isString(value.thinking) &&
    (value.thinkingSignature === undefined ||
      isString(value.thinkingSignature)) &&
    (value.redacted === undefined || typeof value.redacted === "boolean")
  )
}

function isToolCallContent(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.type === "toolCall" &&
    isString(value.id) &&
    isString(value.name) &&
    isRecord(value.arguments)
  )
}

function isTextOrImageContent(value: unknown): boolean {
  return isTextContent(value) || isImageContent(value)
}

function isUsage(value: unknown): boolean {
  if (!isRecord(value)) return false
  const cost = value.cost
  return (
    isFiniteNumber(value.input) &&
    isFiniteNumber(value.output) &&
    isFiniteNumber(value.cacheRead) &&
    isFiniteNumber(value.cacheWrite) &&
    isFiniteNumber(value.totalTokens) &&
    isRecord(cost) &&
    isFiniteNumber(cost.input) &&
    isFiniteNumber(cost.output) &&
    isFiniteNumber(cost.cacheRead) &&
    isFiniteNumber(cost.cacheWrite) &&
    isFiniteNumber(cost.total)
  )
}

function isUserMessage(value: RecordValue): boolean {
  return (
    value.role === "user" &&
    isFiniteNumber(value.timestamp) &&
    (isString(value.content) ||
      (Array.isArray(value.content) &&
        value.content.every(isTextOrImageContent)))
  )
}

function isAssistantMessage(value: RecordValue): boolean {
  return (
    value.role === "assistant" &&
    isFiniteNumber(value.timestamp) &&
    isString(value.api) &&
    isString(value.provider) &&
    isString(value.model) &&
    Array.isArray(value.content) &&
    value.content.every(
      (part) =>
        isTextContent(part) ||
        isThinkingContent(part) ||
        isToolCallContent(part)
    ) &&
    isUsage(value.usage) &&
    (value.stopReason === "stop" ||
      value.stopReason === "length" ||
      value.stopReason === "toolUse" ||
      value.stopReason === "error" ||
      value.stopReason === "aborted")
  )
}

function isToolResultMessage(value: RecordValue): boolean {
  return (
    value.role === "toolResult" &&
    isFiniteNumber(value.timestamp) &&
    isString(value.toolCallId) &&
    isString(value.toolName) &&
    Array.isArray(value.content) &&
    value.content.every(isTextOrImageContent) &&
    typeof value.isError === "boolean"
  )
}

function isInboxKind(value: unknown): value is InboxKind {
  return value === "user" || value === "child_result" || value === "resume"
}

function isAegisXMessage(value: RecordValue): boolean {
  return (
    value.role === "aegisx" &&
    isString(value.id) &&
    isInboxKind(value.kind) &&
    isString(value.text) &&
    isFiniteNumber(value.timestamp) &&
    (value.metadata === undefined || isAegisXMetadata(value.metadata))
  )
}

function isAegisXMetadata(value: unknown): value is AegisXMetadata {
  if (!isRecord(value)) return false
  if (value.handoff === undefined) return true
  return (
    isRecord(value.handoff) &&
    isString(value.handoff.agentId) &&
    isString(value.handoff.agentName) &&
    isString(value.handoff.status)
  )
}

export function parseAgentMessage(value: string): AgentMessage {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error("Persisted agent message is invalid")
  }
  if (!isRecord(parsed)) {
    throw new Error("Persisted agent message is invalid")
  }
  if (
    !isUserMessage(parsed) &&
    !isAssistantMessage(parsed) &&
    !isToolResultMessage(parsed) &&
    !isAegisXMessage(parsed)
  ) {
    throw new Error("Persisted agent message is invalid")
  }
  return parsed as AgentMessage
}

export function parseInboxMetadata(value: string): AegisXMetadata | undefined {
  try {
    const parsed: unknown = JSON.parse(value)
    return isAegisXMetadata(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}
