/** Single message shape for storage and wire (v4). Ported from v2; the host
 * pi SDK AgentMessages are normalized into this shape so the frontend Timeline
 * is decoupled from SDK internals. */

export type MessageRole = "user" | "assistant" | "toolResult" | "notice"

export type UserMessageSource = "user" | "resume" | "bootstrap"

export type TextContent = {
	type: "text"
	text: string
}

export type ImageContent = {
	type: "image"
	data?: string
	mimeType: string
}

export type ThinkingContent = {
	type: "thinking"
	thinking: string
	thinkingSignature?: string
	redacted?: boolean
}

export type ToolCallContent = {
	type: "toolCall"
	id: string
	name: string
	arguments: Record<string, unknown>
}

/** Token usage + cost for one assistant message (mirrors pi-ai `Usage`,
 * decoupled so `shared` does not import the SDK). */
export type MessageUsage = {
	input: number
	output: number
	cacheRead: number
	cacheWrite: number
	reasoning?: number
	totalTokens: number
	cost: {
		input: number
		output: number
		cacheRead: number
		cacheWrite: number
		total: number
	}
}

export type ChildHandoff = {
	agentId: string
	agentName: string
	status: string
}

export type UserMessage = {
	role: "user"
	id: string
	seq: number
	agentId: string
	createdAt: string
	clientMessageId?: string
	source: UserMessageSource
	content: string | Array<TextContent | ImageContent>
	timestamp?: number
}

export type AssistantMessage = {
	role: "assistant"
	id: string
	seq: number
	agentId: string
	createdAt: string
	content: Array<TextContent | ThinkingContent | ToolCallContent | string>
	stopReason?: "stop" | "length" | "toolUse" | "error" | "aborted" | string
	errorMessage?: string
	api?: string
	provider?: string
	model?: string
	usage?: MessageUsage
	timestamp?: number
}

export type ToolResultMessage = {
	role: "toolResult"
	id: string
	seq: number
	agentId: string
	createdAt: string
	toolCallId: string
	toolName: string
	content: Array<TextContent | ImageContent | string>
	isError?: boolean
	details?: unknown
	timestamp?: number
}

/** Durable system-marker kinds persisted as notice rows and rendered as
 * centered timeline markers (retry/compaction transparency). */
export type NoticeSystemKind =
	| "retry_start"
	| "retry_end"
	| "compact_start"
	| "compact_end"

export type NoticeMessage = {
	role: "notice"
	id: string
	seq: number
	agentId: string
	createdAt: string
	source: "child_result" | "system"
	text: string
	handoff?: ChildHandoff
	/** System-marker fields (source === "system"). */
	kind?: NoticeSystemKind
	title?: string
	detail?: string
	/** Compaction summarization usage (compact_end only); folded into run totals. */
	usage?: MessageUsage
	timestamp?: number
}

export type Message =
	| UserMessage
	| AssistantMessage
	| ToolResultMessage
	| NoticeMessage

export function isMessage(value: unknown): value is Message {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false
	}
	const role = (value as { role?: unknown }).role
	return (
		role === "user" ||
		role === "assistant" ||
		role === "toolResult" ||
		role === "notice"
	)
}

export type MessageList = {
	items: Message[]
	/** Highest seq in items (cursor for `?after=`). Null when empty. */
	nextAfter: number | null
}
