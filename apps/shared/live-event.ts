import {
  isRecord,
  type AgentSummary,
  type EntryItem,
  type SessionEntry,
} from "./agent"
import type { RunPublic } from "./run"

export type TransientActivity = "retrying" | "compacting"

export type ToolProgressStatus = "running" | "done" | "error"

export type ToolTerminal = "timed_out" | "cancelled" | "failed"

/** Compaction trigger reason (mirrors the SDK compaction event). */
export type CompactionReason = "manual" | "threshold" | "overflow"

/** Per-agent context snapshot for the conversation stat strip (pi-TUI footer
 * parity: cumulative usage from session entries + live context usage + latest
 * cache-hit rate). */
export type ContextSnapshot = {
  tokens: number | null
  contextWindow: number
  percent: number | null
  cacheHitRate: number | null
  totals: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    cost: number
  }
}

/**
 * Live-only SSE events pushed over `GET /api/runs/:id/stream` (EventSource).
 * Ephemeral: reconnect re-fetches durable entries from `GET .../messages` and
 * re-applies progress from the current stream.
 */
export type LiveEvent =
  | {
      type: "ready"
      runId: string
      agentId: string
    }
  | {
      type: "run.updated"
      run: RunPublic
    }
  | {
      type: "agent.updated"
      agent: AgentSummary
    }
  | {
      type: "agent.activity"
      agentId: string
      activity: TransientActivity | null
      detail?: string
      /** Retry/compaction enrichment for the activity badge. */
      attempt?: number
      maxAttempts?: number
      delayMs?: number
      reason?: CompactionReason
    }
  | ({
      type: "context.updated"
      agentId: string
    } & ContextSnapshot)
  | {
      type: "queue.updated"
      agentId: string
      steering: string[]
      followUp: string[]
    }
  | {
      type: "message.progress"
      agentId: string
      /** Match key: identical to the eventual `message.committed` item.key,
       * so the store swaps the streaming draft for the committed entry. */
      key: string
      revision: number
      /** Synthetic message entry (not yet persisted): {type:"message", ...,
       * message: <partial AgentMessage>}. No seq (assigned on commit). */
      entry: SessionEntry
    }
  | {
      type: "tool.progress"
      agentId: string
      toolCallId: string
      revision: number
      toolName: string
      /** Server-side execution start (epoch ms) — the tool's TRUE start, so a
       * dialog opened mid-execution shows the real elapsed time instead of
       * counting from the dialog open. Absent on old snapshots/replays. */
      startedAt?: number
      /** Omitted on the terminal (tool_execution_end) event — the SDK's
       * tool_execution_end carries no args, so the store keeps the args from
       * the earlier tool_execution_start/_update instead of clobbering them. */
      args?: unknown
      result?: unknown
      status: ToolProgressStatus
      isError?: boolean
      terminal?: ToolTerminal
      terminalMessage?: string
    }
  | {
      type: "message.committed"
      agentId: string
      item: EntryItem
    }

/**
 * Timing metadata for a `session_entries` row (the `meta` column, v10).
 *
 * Persisted as JSON in `session_entries.meta` (nullable). Filled only for
 * `message` rows: assistant messages carry `durationMs` + per-block timing;
 * toolResult messages carry only `durationMs` (the tool execution time). All
 * other rows + pre-v10 rows are null.
 *
 * The event pipeline (server `event-pipeline.ts`) is the single producer — it
 * times the streaming assistant message and the tool execution, then injects
 * the result pre-commit via `DbSessionManager.metaProvider`. The frontend reads
 * it back to render block-level durations and the tool "参数生成 · 执行"
 * double timing.
 *
 * `blocks` (assistant only): one entry per timed content block, `index` = the
 * block's position in the assistant message `content` array. Only
 * `thinking`/`text`/`toolCall` blocks are timed; other block types are absent.
 */
export type TimingBlockType = "thinking" | "text" | "toolCall"

export type TimingBlock = {
  type: TimingBlockType
  index: number
  /** Offset from the assistant message start (message_start) in ms. */
  startMs: number
  /** Offset from the assistant message start in ms. */
  endMs: number
}

export type TimingMeta = {
  /** Total duration. Assistant = message_end − message_start; toolResult =
   * tool_execution_end − tool_execution_start. */
  durationMs: number
  /** Per-block timing (assistant messages only; absent for toolResult). */
  blocks?: TimingBlock[]
}

function isTimingBlockType(value: unknown): value is TimingBlockType {
  return value === "thinking" || value === "text" || value === "toolCall"
}

function isTimingBlock(value: unknown): value is TimingBlock {
  if (!isRecord(value)) return false
  return (
    isTimingBlockType(value.type) &&
    typeof value.index === "number" &&
    typeof value.startMs === "number" &&
    typeof value.endMs === "number"
  )
}

/** Narrow a parsed `meta` JSON value to {@link TimingMeta}. */
export function isTimingMeta(value: unknown): value is TimingMeta {
  if (!isRecord(value)) return false
  if (typeof value.durationMs !== "number") return false
  if (value.blocks !== undefined) {
    if (!Array.isArray(value.blocks)) return false
    if (!value.blocks.every(isTimingBlock)) return false
  }
  return true
}

export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"

const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return (
    value === "off" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
  )
}

export function normalizeThinkingLevel(value: unknown): ThinkingLevel {
  return isThinkingLevel(value) ? value : "off"
}

export function thinkingLevels(): readonly ThinkingLevel[] {
  return THINKING_LEVELS
}
