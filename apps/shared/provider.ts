import type { ProviderType } from "./platform";
import type { ThinkingLevel } from "./thinking";

export type PiModelProfile = {
	providerId: string;
	modelId: string;
	name: string;
};

export type ModelMetadata = {
	reasoning: boolean;
	thinkingLevelMap: Partial<Record<ThinkingLevel, string | null>>;
	input: Array<"text" | "image">;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		tiers?: Array<{
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
			inputTokensAbove: number;
		}>;
	};
	costKnown: boolean;
	contextWindow: number;
	maxTokens: number;
	headers?: Record<string, string>;
	compat?: Record<string, unknown>;
};

export type ProviderModel = {
	id: string;
	providerId: string;
	modelId: string;
	label: string;
	enabled: boolean;
	metadata: ModelMetadata;
	piBinding: { providerId: string; modelId: string } | null;
	thinkingLevels: ThinkingLevel[];
	createdAt: string;
	updatedAt: string;
};

export type ProviderConnection = {
	id: string;
	label: string;
	type: ProviderType;
	baseUrl: string;
	apiKey: string;
	enabled: boolean;
	createdAt: string;
	updatedAt: string;
	models: ProviderModel[];
};
