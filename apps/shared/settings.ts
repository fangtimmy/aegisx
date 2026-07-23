import type { ThinkingLevel } from "./thinking";

export type Environment = "local" | "container";

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
	mainSystemPromptTemplate: string;
	childSystemPromptTemplate: string;
	initialPromptTemplate: string;
	defaultMainSystemPromptTemplate: string;
	defaultChildSystemPromptTemplate: string;
	defaultInitialPromptTemplate: string;
	promptTemplateVariables: string[];
	updatedAt: string;
};
