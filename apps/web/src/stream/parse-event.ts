import {
  type AgentSummary,
  type ChannelMessagePublic,
  isSessionEntry,
  isTimingMeta,
  type LiveEvent,
} from "@/api"
import { isRecord } from "@/domain/conversation"

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

function isCompactionReason(
  value: unknown
): value is "manual" | "threshold" | "overflow" {
  return value === "manual" || value === "threshold" || value === "overflow"
}

function optNum(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function optStr(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

/** Minimal wire guard for the channel.message ledger row — the render path
 * dereferences id/author/body/meta/files unconditionally, so a malformed
 * frame must be dropped rather than cached. */
function isChannelMessage(value: unknown): value is ChannelMessagePublic {
  if (!isRecord(value)) return false
  return (
    typeof value.id === "number" &&
    typeof value.channelKey === "string" &&
    (value.authorType === "system" ||
      value.authorType === "user" ||
      value.authorType === "agent") &&
    (value.authorAgentId === null || typeof value.authorAgentId === "string") &&
    typeof value.authorName === "string" &&
    typeof value.body === "string" &&
    isRecord(value.meta) &&
    typeof value.createdAt === "string" &&
    Array.isArray(value.files)
  )
}

/** Parse one SSE data payload into a typed LiveEvent, or undefined if malformed. */
export function parseLiveEvent(value: unknown): LiveEvent | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined
  if (value.type === "ready") {
    return typeof value.agentId === "string"
      ? { type: "ready", agentId: value.agentId }
      : undefined
  }
  if (value.type === "channel.message") {
    if (!isChannelMessage(value.message)) return undefined
    return { type: "channel.message", message: value.message }
  }
  if (value.type === "agent.updated") {
    if (!isRecord(value.agent)) return undefined
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- 帧来自自家服务端；字段级校验会拒绝存量客户端依赖的部分帧（测试锁定）。
    return { type: "agent.updated", agent: value.agent as AgentSummary }
  }
  if (value.type === "message.progress") {
    const revision = numberValue(value.revision)
    if (
      typeof value.agentId !== "string" ||
      typeof value.key !== "string" ||
      revision === undefined ||
      !isSessionEntry(value.entry)
    ) {
      return undefined
    }
    return {
      type: "message.progress",
      agentId: value.agentId,
      key: value.key,
      revision,
      entry: value.entry,
    }
  }
  if (value.type === "tool.progress") {
    const revision = numberValue(value.revision)
    const status = value.status
    const startedAt = optNum(value.startedAt)
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
          ...(value.args !== undefined ? { args: value.args } : {}),
          ...("result" in value ? { result: value.result } : {}),
          status,
          ...(startedAt !== undefined ? { startedAt } : {}),
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
    const detail = optStr(value.detail)
    const attempt = optNum(value.attempt)
    const maxAttempts = optNum(value.maxAttempts)
    const delayMs = optNum(value.delayMs)
    return {
      type: "agent.activity",
      agentId: value.agentId,
      activity: value.activity,
      ...(detail !== undefined ? { detail } : {}),
      ...(attempt !== undefined ? { attempt } : {}),
      ...(maxAttempts !== undefined ? { maxAttempts } : {}),
      ...(delayMs !== undefined ? { delayMs } : {}),
      ...(isCompactionReason(value.reason) ? { reason: value.reason } : {}),
    }
  }
  if (value.type === "context.updated") {
    if (typeof value.agentId !== "string") return undefined
    const totals = value.totals
    if (!isRecord(totals)) return undefined
    return {
      type: "context.updated",
      agentId: value.agentId,
      tokens:
        typeof value.tokens === "number" || value.tokens === null
          ? value.tokens
          : null,
      contextWindow: optNum(value.contextWindow) ?? 0,
      percent:
        typeof value.percent === "number" || value.percent === null
          ? value.percent
          : null,
      cacheHitRate:
        typeof value.cacheHitRate === "number" || value.cacheHitRate === null
          ? value.cacheHitRate
          : null,
      totals: {
        input: optNum(totals.input) ?? 0,
        output: optNum(totals.output) ?? 0,
        cacheRead: optNum(totals.cacheRead) ?? 0,
        cacheWrite: optNum(totals.cacheWrite) ?? 0,
        cost: optNum(totals.cost) ?? 0,
      },
    }
  }
  if (value.type === "queue.updated") {
    if (typeof value.agentId !== "string") return undefined
    if (!Array.isArray(value.steering) || !Array.isArray(value.followUp))
      return undefined
    return {
      type: "queue.updated",
      agentId: value.agentId,
      steering: value.steering.filter(
        (s): s is string => typeof s === "string"
      ),
      followUp: value.followUp.filter(
        (s): s is string => typeof s === "string"
      ),
    }
  }
  if (value.type === "message.committed") {
    if (typeof value.agentId !== "string" || !isRecord(value.item))
      return undefined
    const item = value.item
    const seq = numberValue(item.seq)
    if (
      typeof item.key !== "string" ||
      seq === undefined ||
      !isSessionEntry(item.entry)
    ) {
      return undefined
    }
    return {
      type: "message.committed",
      agentId: value.agentId,
      item: {
        entry: item.entry,
        seq,
        key: item.key,
        ...(isTimingMeta(item.meta) ? { meta: item.meta } : {}),
      },
    }
  }
  return undefined
}
