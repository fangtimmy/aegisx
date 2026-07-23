import type { AgentSummary } from "./agent"
import type { Message } from "./message"
import type { RunPublic } from "./run"

export type TransientActivity = "retrying" | "compacting"

export type ToolProgressStatus = "running" | "done" | "error"

export type ToolTerminal = "timed_out" | "cancelled" | "failed"

/** Live-only SSE events (v2). No durable cursor. */
export type LiveEvent =
	| {
			type: "ready"
			runId: string
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
	  }
	| {
			type: "message.progress"
			agentId: string
			messageId: string
			revision: number
			message: Message
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
			message: Message
	  }
