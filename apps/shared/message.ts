/** Single message shape for storage and wire (v2). */

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

export type NoticeMessage = {
	role: "notice"
	id: string
	seq: number
	agentId: string
	createdAt: string
	source: "child_result"
	text: string
	handoff?: ChildHandoff
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
