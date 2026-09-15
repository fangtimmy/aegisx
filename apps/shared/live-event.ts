import type { AgentSummary, EntryItem, SessionEntryView } from "./agent"
import type { ChannelFileMeta } from "./channels"

/** One channel message (the ledger row — shared wire shape for timelines,
 * SDK reads, and the SSE `channel.message` push; v18: keyed by the derived
 * channel key). v19 attachments are shared/-tree paths (copied by the
 * server at post time); content is read directly from the workspace, not
 * fetched. */
type ChannelMessage = {
  id: number
  channelKey: string
  authorType: "system" | "user" | "agent"
  authorAgentId: string | null
  authorName: string
  body: string
  meta: Record<string, unknown>
  createdAt: string
  files: ChannelFileMeta[]
}

type TransientActivity = "retrying" | "compacting"

type ToolProgressStatus = "running" | "done" | "error"

export type ToolTerminal = "timed_out" | "cancelled" | "failed"

/** Compaction trigger reason (mirrors the SDK compaction event). */
type CompactionReason = "manual" | "threshold" | "overflow"

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
 * Live-only SSE events pushed over the multiplexed `GET /api/stream`
 * (EventSource). Ephemeral: reconnect re-fetches durable entries from
 * `GET .../messages` and re-applies progress from the current stream. Every
 * frame carries its own identity (agent events an `agentId`, channel
 * messages a `message.channelKey`); consumers dispatch on it.
 */
export type LiveEvent =
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
       * message: <partial message>}. No seq (assigned on commit). */
      entry: SessionEntryView
    }
  | {
      type: "tool.progress"
      agentId: string
      toolCallId: string
      revision: number
      toolName: string
      /** Server-side execution start (epoch ms) — the tool's TRUE start, so a
       * dialog opened mid-execution shows the real elapsed time instead of
       * counting from the dialog open. Only the start frame carries it, so
       * update/end frames omit it. */
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
      /** The session the entry landed in — clients key their lastSeq cursor
       * by it (seq is session-scoped; multi-session agents must not share a
       * cursor). */
      sessionId: string
      item: EntryItem
    }
  | {
      /** Unified message layer push: a new channel message landed. Emitted on
       * the run's channel (run-scope channels) or the event's channel (the
       * scheduler DM). */
      type: "channel.message"
      message: ChannelMessage
    }
export type { ThinkingLevel } from "./domain"
