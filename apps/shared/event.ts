import type { EventPlatform } from "./platform";
import type { RunPublic } from "./run";
import type {
	AgentToolStats,
	EventCostSummary,
	EventDurationSummary,
	UsageSummary,
} from "./usage";

export type EventInput = {
	name: string;
	promptHint?: string;
};

export type EventSummary = {
	id: string;
	name: string;
	promptHint: string;
	platform: EventPlatform | null;
	createdAt: string;
	updatedAt: string;
	challengeCount: number;
	solvedCount: number;
	activeRunCount: number;
	lastActivityAt: string;
};

export type EventStats = {
	eventId: string;
	challengeCount: number;
	attemptedChallengeCount: number;
	solvedChallengeCount: number;
	runCount: number;
	terminalRunCount: number;
	successfulRunCount: number;
	successRate: number | null;
	usage: UsageSummary;
	cost: EventCostSummary;
	duration: EventDurationSummary;
	funnel: {
		totalChallenges: number;
		attemptedChallenges: number;
		submittedChallenges: number;
		solvedChallenges: number;
		totalSubmissions: number;
		acceptedSubmissions: number;
		rejectedSubmissions: number;
		submittedRuns: number;
		firstAttemptAcceptedRuns: number;
	};
	failures: Array<{
		reason: string;
		runCount: number;
		usage: UsageSummary;
	}>;
	models: Array<{
		key: string;
		provider: string;
		modelId: string;
		modelName: string;
		runCount: number;
		terminalRunCount: number;
		successfulRunCount: number;
		successRate: number | null;
		averageTokens: number;
		averageDurationMs: number | null;
		usage: UsageSummary;
		cost: EventCostSummary;
		duration: EventDurationSummary;
	}>;
	trend: Array<{
		date: string;
		runCount: number;
		successfulRunCount: number;
		successRate: number | null;
		totalTokens: number;
		knownCost: number;
		averageDurationMs: number | null;
	}>;
	categories: Array<{
		category: string;
		challengeCount: number;
		attemptedCount: number;
		solvedCount: number;
	}>;
	outcomes: Array<{
		outcome: "successful" | "unsuccessful";
		runCount: number;
		averageTokens: number;
		averageDurationMs: number | null;
	}>;
	tools: AgentToolStats[];
	challenges: Array<{
		challengeId: string;
		challengeName: string;
		category: string | null;
		runCount: number;
		successfulRunCount: number;
		usage: UsageSummary;
		cost: EventCostSummary;
		duration: EventDurationSummary;
	}>;
	runs: Array<{
		run: RunPublic;
		usage: UsageSummary;
		durationMs: number | null;
		successful: boolean;
	}>;
};
