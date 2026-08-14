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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
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
