export type PlatformType = "ctfd" | "ret2shell" | "a1ctf";

export type ProviderType =
	| "openai-compatible"
	| "openai-responses"
	| "anthropic-messages";

export type RemoteEvent = { id: string; name: string };

export type RemoteChallengeSummary = {
	id: string;
	name: string;
	category: string | null;
	points: number | null;
	solved: boolean;
	imported: boolean;
	localChallengeId: string | null;
};

export type ChallengeSyncResult = {
	syncedAt: string;
	results: Array<{
		remoteId: string;
		status: "created" | "updated" | "failed";
		challengeId?: string;
		error?: string;
	}>;
};

export type EventPlatform = {
	eventId: string;
	type: PlatformType;
	baseUrl: string;
	credential: string;
	remoteEventId: string;
	lastSyncedAt: string | null;
	createdAt: string;
	updatedAt: string;
	credentialConfigured: boolean;
};

export type SubmissionStatus =
	| "pending"
	| "accepted"
	| "rejected"
	| "partial"
	| "already_solved"
	| "rate_limited"
	| "error";
