import type { AgentSummary } from "./agent"
import type { EntryItem, SessionEntry } from "./session-entry"
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
			tokensBefore?: number
			tokensAfter?: number
			aborted?: boolean
			success?: boolean
	  }
	| {
			type: "context.updated"
			agentId: string
		} & ContextSnapshot
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
			args: unknown
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
