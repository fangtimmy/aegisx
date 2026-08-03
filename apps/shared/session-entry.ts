import type {
  BranchSummaryEntry,
  CompactionEntry,
  SessionEntry,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent"

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
}

/** One entry in a `GET /runs/:id/messages` response (an `EntryItem` tagged with
 * which agent's session it belongs to — a run may have several agents). */
export type MessageListItem = EntryItem & {
  agentId: string
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
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
export function isCompactionEntry(entry: SessionEntry): entry is CompactionEntry {
  return entry.type === "compaction"
}

/** Narrow to a branch-summary entry (rendered as a centered timeline marker). */
export function isBranchSummaryEntry(
  entry: SessionEntry
): entry is BranchSummaryEntry {
  return entry.type === "branch_summary"
}
