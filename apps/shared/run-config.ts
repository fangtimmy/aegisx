import type { ThinkingLevel } from "./thinking";

export type EnvironmentConfig =
	| { type: "local" }
	| {
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
