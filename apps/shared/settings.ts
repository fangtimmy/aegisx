import type { ThinkingLevel } from "./thinking";

export type Environment = "local" | "container";

/** When a tool is running (or errors, if enabled), auto-expand that category. */
export type ConversationToolExpandPrefs = {
	fileRead: boolean;
	fileEdit: boolean;
	bash: boolean;
	target: boolean;
	flag: boolean;
	agent: boolean;
	/** Expand tools that ended in error regardless of category. */
	errors: boolean;
};

export type SettingsPublic = {
	defaultModelId: string | null;
	defaultThinkingLevel: ThinkingLevel;
	environment: Environment;
	containerImage: string;
	cpus: number;
	memoryMb: number;
	pidsLimit: number;
	maxConcurrency: number;
	maxAttachmentMb: number;
	maxRetryAttempts: number;
	retryBaseDelayMs: number;
	retryMaxDelayMs: number;
	maxToolOutputBytes: number;
	maxInlineShellOutputBytes: number;
	maxCapturedShellOutputBytes: number;
	containerWorkspace: string;
	dockerTimeoutMs: number;
	tmpfsSize: string;
	platformRequestTimeoutMs: number;
	providerDiscoverTimeoutMs: number;
	defaultToolTimeoutMs: number;
	toolTimeouts: Record<string, number>;
	renderUserMessagesAsMarkdown: boolean;
	conversationToolExpand: ConversationToolExpandPrefs;
	mainSystemPromptTemplate: string;
	childSystemPromptTemplate: string;
	initialPromptTemplate: string;
	defaultMainSystemPromptTemplate: string;
	defaultChildSystemPromptTemplate: string;
	defaultInitialPromptTemplate: string;
	promptTemplateVariables: string[];
	updatedAt: string;
};
