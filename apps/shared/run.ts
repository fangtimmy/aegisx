import type { RunStatus } from "./run-status";
import type { ThinkingLevel } from "./thinking";

export type RunPublic = {
	id: string;
	challengeId: string;
	challengeName: string;
	eventId: string;
	status: RunStatus;
	/** Distinct from main agent id (v2). */
	targetSupported: boolean;
	/** Main process launcher; v3 is always "pi". */
	launcher: "pi";
	provider: string;
	modelId: string;
	modelName: string;
	thinkingLevel: ThinkingLevel;
	environment: "container";
	image: string;
	cpus: number;
	memoryMb: number;
	pidsLimit: number;
	containerName: string;
	/** pi jsonl session id (for resume); null until discovered. */
	piSessionId: string | null;
	createdAt: string;
	startedAt: string | null;
	updatedAt: string;
	completedAt: string | null;
	error: string | null;
	summary: string | null;
	flag: string | null;
	hasFlag: boolean;
};

/** REST snapshot for a run. v3 has no agents/usage. */
export type RunDetail = {
	run: RunPublic;
};

export type RunFileEntry = {
	name: string;
	path: string;
	type: "file" | "directory";
	size: number;
	modifiedAt: string;
};

export type RunFile =
	| {
			path: string;
			type: "directory";
			entries: RunFileEntry[];
	  }
	| {
			path: string;
			type: "text";
			size: number;
			modifiedAt: string;
			content: string;
			truncated: boolean;
	  }
	| {
			path: string;
			type: "binary";
			size: number;
			modifiedAt: string;
	  };
