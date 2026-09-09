import type { AgentStatus } from "./domain"
import type { AgentUsage, WorkspaceInfo } from "./workspace"

/** One session of an agent (multi-session v12): a `sessions` row + its message
 * count + the active flag (whether it is the agent's current sessionFile
 * pointer). Sessions are per-agent conversation threads; exactly one is active
 * at a time. Display name is derived client-side by creation order. */
export type AgentSessionSummary = {
  id: string
  createdAt: string
  messageCount: number
  isActive: boolean
}

/** One active tool's definition snapshot (for the timeline 工具定义 panel).
 * `parameters` is the tool's TypeBox schema serialized to JSON Schema. */
export type ToolDefinitionSnapshot = {
  name: string
  description: string
  parameters: unknown
  promptGuidelines?: string[]
}

/** v19 agent: the execution unit. One attempt on a challenge = one agent row
 * (challengeId null = the event's orchestrator). A pi session + role + model
 * + prompt + tools, snapshotted on the row at spawn time. */
export type AgentSummary = {
  id: string
  eventId: string
  /** Null = the event's scheduler agent (one per event). */
  challengeId: string | null
  /** Display name of the agent's challenge ("" for the scheduler). */
  challengeName: string
  role: "solver" | "orchestrator"
  name: string | null
  /** Canonical model ref snapshot (`<providerKey>/<modelId>:<effort>`),
   * persisted on the agent row at spawn/switch time. */
  model: string | null
  status: AgentStatus
  source: "manual" | "scheduler"
  /** The spawn prompt (strategy input); reused on re-spawn. */
  prompt: string | null
  /** finish_run's result (written at the agent's terminal completed settle). */
  summary: string | null
  error: string | null
  deadlineAt: string | null
  lastTimeoutAt: string | null
  createdAt: string
  startedAt: string | null
  updatedAt: string
  completedAt: string | null
}

/** REST snapshot for one agent (GET /api/agents/:id). */
export type AgentDetail = {
  agent: AgentSummary
  /** Tool allowlist snapshot (real tool names; file tools always on, not
   * listed). JSON-parsed from the agents row. */
  tools: string[]
  /** Active tool-definition snapshots (name/description/JSON-schema), incl.
   * the always-on file tools. */
  toolDefinitions: ToolDefinitionSnapshot[]
  /** Full system prompt snapshot (spawn writes once; cold-restore reuses). */
  systemPrompt: string
  /** Session id (DB) for this agent (resume + audit). */
  sessionFile: string | null
  usage?: AgentUsage
  /** The agent's workspace (challenge workspace / scheduler workspace). */
  workspace: WorkspaceInfo
}

export {
  isAgentStatus,
  isActiveAgentStatus,
  isTerminalAgentStatus,
  LIVE_AGENT_STATUSES,
} from "./domain"
export type { AgentStatus } from "./domain"

import type {
  BranchSummaryEntry,
  CompactionEntry,
  SessionEntry,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent"

export type {
  CompactionEntry,
  SessionEntry,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent"

/** Renderable session-entry kinds the timeline consumes. Other kinds
 * (model_change, label, session_info, ...) are persisted but not rendered. */
export type RenderableEntry =
  | SessionMessageEntry
  | CompactionEntry
  | BranchSummaryEntry

/**
 * One persisted session entry projected for the wire, with its append position.
 *
 * `entry` is a native pi `SessionEntry` (byte-for-byte a `session_entries.data`
 * row). `seq` is the `session_entries.seq` column — it is NOT part of the entry
 * JSON, so it travels alongside. It is the render order and the pagination
 * cursor (`?after=`).
 *
 * `key` is the stable identity used by the frontend store for dedup and for
 * matching an in-flight `message.progress` to its eventual `message.committed`.
 * For message entries it is derived from the message
 * (`${agentId}:${role}:${timestamp}`, or the toolCallId); for compaction/other
 * entries it is the entry's own `id`. Computed server-side.
 */
export type EntryItem = {
  entry: SessionEntry
  seq: number
  key: string
  /** Timing metadata (the `meta` column, v10). Present for new message rows
   * (assistant: durationMs + blocks; toolResult: durationMs); absent for
   * pre-v10 rows (meta=null) and non-message rows. */
  meta?: TimingMeta
}

/** One entry in a `GET /agents/:id/messages` response. */
export type MessageListItem = EntryItem

export type MessageList = {
  items: MessageListItem[]
  /** Highest seq in items (cursor for `?after=`). Null when empty. */
  nextAfter: number | null
}

const ENTRY_TYPES = new Set([
  "message",
  "thinking_level_change",
  "model_change",
  "compaction",
  "branch_summary",
  "custom",
  "custom_message",
  "label",
  "session_info",
])

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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Narrow an arbitrary value to a pi `SessionEntry` (structural check on the
 * discriminating fields the frontend relies on). */
export function isSessionEntry(value: unknown): value is SessionEntry {
  if (!isRecord(value)) return false
  const type = value.type
  if (typeof type !== "string" || !ENTRY_TYPES.has(type)) return false
  return typeof value.id === "string" && typeof value.timestamp === "string"
}
