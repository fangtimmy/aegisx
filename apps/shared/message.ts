export type InboxKind = "user" | "child_result" | "resume";

export type AegisXMetadata = {
	handoff?: {
		agentId: string;
		agentName: string;
		status: string;
	};
};

/** Internal persisted inbox message (runtime). */
export type AegisXMessage = {
	role: "aegisx";
	id: string;
	kind: InboxKind;
	text: string;
	timestamp: number;
	metadata?: AegisXMetadata;
};

export type TextContent = {
	type: "text";
	text: string;
};

export type ImageContent = {
	type: "image";
	data?: string;
	mimeType: string;
};

export type ThinkingContent = {
	type: "thinking";
	thinking: string;
	thinkingSignature?: string;
	redacted?: boolean;
};

export type ToolCallContent = {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
};

export type UserContent = string | Array<TextContent | ImageContent>;

export type PublicUserMessage = {
	role: "user";
	timestamp?: number;
	content: UserContent;
	aegisx?: {
		id?: string;
		kind?: InboxKind;
		metadata?: AegisXMetadata;
	};
};

export type PublicAssistantMessage = {
	role: "assistant";
	timestamp?: number;
	content: Array<TextContent | ThinkingContent | ToolCallContent | string>;
	stopReason?: "stop" | "length" | "toolUse" | "error" | "aborted" | string;
	errorMessage?: string;
	api?: string;
	provider?: string;
	model?: string;
};

export type PublicToolResultMessage = {
	role: "toolResult";
	timestamp?: number;
	toolCallId: string;
	toolName: string;
	content: Array<TextContent | ImageContent | string>;
	isError?: boolean;
	details?: unknown;
};

/** Wire shape of agent messages after publicAgentMessage(). */
export type PublicAgentMessage =
	| PublicUserMessage
	| PublicAssistantMessage
	| PublicToolResultMessage;

export function isPublicAgentMessage(
	value: unknown,
): value is PublicAgentMessage {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const role = (value as { role?: unknown }).role;
	return role === "user" || role === "assistant" || role === "toolResult";
}
