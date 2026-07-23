import type { RunStatus } from "./run-status";
import type { ThinkingLevel } from "./thinking";

export type RunPublic = {
	id: string;
	challengeId: string;
	challengeName: string;
	eventId: string;
	status: RunStatus;
	provider: string;
	modelId: string;
	modelName: string;
	thinkingLevel: ThinkingLevel;
	environment: "local" | "container";
	targetSupported: boolean;
	image?: string | null;
	cpus?: number;
	memoryMb?: number;
	pidsLimit?: number;
	createdAt: string;
	startedAt: string | null;
	updatedAt: string;
	completedAt: string | null;
	error: string | null;
	summary: string | null;
	hasFlag: boolean;
	flag?: string | null;
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
