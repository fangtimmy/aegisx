import type { ThinkingLevel } from "./thinking";

/** v3 is container-only; every run is a Docker container running pi. */
export type EnvironmentConfig = {
	type: "container";
	image: string;
	cpus: number;
	memoryMb: number;
	pidsLimit: number;
};

export type ModelConfig = {
	provider: string;
	providerLabel?: string;
	modelId: string;
	modelLabel?: string;
	baseUrl?: string;
	costKnown?: boolean;
	thinkingLevel: ThinkingLevel;
};

export type PromptAttachment = {
	name: string;
	path: string;
	size: number;
};

/**
 * Prompt template context (handlebars). The shape is preserved across v2→v3
 * so existing user-saved templates keep resolving. v3 sets:
 *  - run.environment always "container", run.isContainer always true
 *  - agent.role always "main", agent.isMain always true (single agent)
 *  - capabilities.canSpawnAgent always false (no multi-agent)
 */
export type PromptTemplateContext = {
	agent: {
		role: "main" | "child";
		isMain: boolean;
		name: string;
		task: string | null;
	};
	event: {
		id: string;
		name: string;
		platform: string | null;
		promptHint: string;
	};
	challenge: {
		id: string;
		name: string;
		description: string;
		category: string | null;
		points: number | null;
		attachments: PromptAttachment[];
		attachmentPaths: string[];
	};
	model: {
		provider: string;
		name: string;
		id: string;
	};
	run: {
		id: string;
		environment: "local" | "container";
		isContainer: boolean;
		workspace: string;
		targetSupported: boolean;
		platformIntegrated: boolean;
		containerImage: string | null;
		cpus: number | null;
		memoryMb: number | null;
		pidsLimit: number | null;
	};
	capabilities: {
		canFinishRun: boolean;
		canSpawnAgent: boolean;
		canSubmitFlag: boolean;
		canManageTarget: boolean;
	};
};

export type FrozenPromptConfig = {
	mainSystemPromptTemplate: string;
	childSystemPromptTemplate: string;
	initialPromptTemplate: string;
	context?: PromptTemplateContext;
};
