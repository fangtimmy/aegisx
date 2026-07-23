export type UsageSummary = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number | null;
};

export type AgentToolStats = {
	toolName: string;
	callCount: number;
	failedCount: number;
	durationMs: number;
	outputBytes: number;
	truncatedCount: number;
};

export type EventCostSummary = {
	known: number;
	unknownRunCount: number;
};

export type EventDurationSummary = {
	medianMs: number | null;
	p90Ms: number | null;
};
