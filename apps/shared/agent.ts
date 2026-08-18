import type { AgentUsage, WorkspaceInfo } from "./workspace"

/** One active tool's definition snapshot (for the timeline 工具定义 panel).
 * `parameters` is the tool's TypeBox schema serialized to JSON Schema. */
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
  /** Canonical model ref snapshot (`<providerKey>/<modelId>:<effort>` | alias),
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

/** Per-agent lifecycle. Solver + orchestrator agents use running|idle
 * (turn-by-turn); terminal states keep the DB session + files for reopen. */
export type AgentStatus =
  | "running"
  | "idle"
  | "completed"
  | "aborted"
  | "failed"

/** An agent holds live resources (a session; the challenge workspace's
 * container is shared and lazily managed). */
export function isActiveAgentStatus(status: string): boolean {
  return status === "running" || status === "idle"
}

import type {
  BranchSummaryEntry,
  CompactionEntry,
  SessionEntry,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent"

import type { TimingMeta } from "./live-event"

export type {
  BranchSummaryEntry,
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

/** Narrow to a message entry (the only kind carrying a renderable message). */
export function isMessageEntry(
  entry: SessionEntry
): entry is SessionMessageEntry {
  return entry.type === "message"
}

/** Narrow to a compaction entry (rendered as a centered timeline marker). */
export function isCompactionEntry(
  entry: SessionEntry
): entry is CompactionEntry {
  return entry.type === "compaction"
}

/** Narrow to a branch-summary entry (rendered as a centered timeline marker). */
export function isBranchSummaryEntry(
  entry: SessionEntry
): entry is BranchSummaryEntry {
  return entry.type === "branch_summary"
}
