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

export type ChallengeSyncAttachment = {
	filename: string;
	size: number;
	status: "downloaded" | "updated";
};

export type ChallengeSyncItem = {
	remoteId: string;
	status: "created" | "updated" | "failed";
	challengeId?: string;
	error?: string;
	name?: string;
	category?: string | null;
	points?: number | null;
	attachments?: ChallengeSyncAttachment[];
};

export type ChallengeSyncProgress = {
	remoteId: string;
	phase: "fetching" | "metadata" | "attachment";
	message: string;
	name?: string;
	category?: string | null;
	points?: number | null;
	attachment?: {
		filename: string;
		index: number;
		total: number;
	};
};

export type ChallengeSyncResult = {
	syncedAt: string;
	results: ChallengeSyncItem[];
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
