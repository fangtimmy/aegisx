import type { AgentStatus } from "./run-status";
import type { ThinkingLevel } from "./thinking";
import type { AgentToolStats, UsageSummary } from "./usage";

export type AgentPublic = {
	id: string;
	runId: string;
	parentAgentId: string | null;
	name: string;
	status: AgentStatus;
	summary: string | null;
	error: string | null;
	createdAt: string;
	startedAt: string | null;
	updatedAt: string;
	completedAt: string | null;
};

export type AgentSummary = AgentPublic & { usage: UsageSummary };

export type AgentRuntimeSnapshot = {
	capturedAt: string;
	systemPrompt: string;
	cwd: string;
	model: {
		provider: string;
		modelId: string;
		thinkingLevel: ThinkingLevel;
	};
	tools: Array<{
		name: string;
		description: string;
		parameters: unknown;
		promptGuidelines?: string[];
	}>;
};

export type AgentInspector = {
	agent: AgentPublic;
	task: string | null;
	runtime: AgentRuntimeSnapshot | null;
	usage: UsageSummary;
	toolStats: AgentToolStats[];
};

export type ConversationMessage = {
	id: string;
	agentId: string;
	sequence: number;
	message: Record<string, unknown>;
	createdAt: string;
};
