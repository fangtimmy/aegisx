import {
  type AgentSummary,
  isSessionEntry,
  isTimingMeta,
  type LiveEvent,
  type RunPublic,
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

/** Parse one SSE data payload into a typed LiveEvent, or undefined if malformed. */
export function parseLiveEvent(value: unknown): LiveEvent | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined
  if (value.type === "ready") {
    return typeof value.runId === "string" && typeof value.agentId === "string"
      ? { type: "ready", runId: value.runId, agentId: value.agentId }
      : undefined
  }
  if (value.type === "run.updated") {
    if (!isRecord(value.run)) return undefined
    return { type: "run.updated", run: value.run as RunPublic }
  }
  if (value.type === "agent.updated") {
    if (!isRecord(value.agent)) return undefined
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
      ...(optStr(value.detail) !== undefined
        ? { detail: value.detail as string }
        : {}),
      ...(optNum(value.attempt) !== undefined
        ? { attempt: value.attempt as number }
        : {}),
      ...(optNum(value.maxAttempts) !== undefined
        ? { maxAttempts: value.maxAttempts as number }
        : {}),
      ...(optNum(value.delayMs) !== undefined
        ? { delayMs: value.delayMs as number }
        : {}),
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
