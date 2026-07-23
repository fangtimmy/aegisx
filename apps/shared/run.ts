import type { AgentSummary } from "./agent"
import type { Message } from "./message"
import type { RunStatus } from "./run-status"
import type { ThinkingLevel } from "./thinking"
import type { UsageSummary } from "./usage"

export type RunPublic = {
	id: string
	/** Distinct from main agent id (v2). */
	mainAgentId: string
	challengeId: string
	challengeName: string
	eventId: string
	status: RunStatus
	provider: string
	modelId: string
	modelName: string
	thinkingLevel: ThinkingLevel
	environment: "local" | "container"
	targetSupported: boolean
	image?: string | null
	cpus?: number
	memoryMb?: number
	pidsLimit?: number
	createdAt: string
	startedAt: string | null
	updatedAt: string
	completedAt: string | null
	error: string | null
	summary: string | null
	hasFlag: boolean
	flag?: string | null
}

/** REST snapshot for the run workspace. */
export type RunDetail = {
	run: RunPublic
	agents: AgentSummary[]
	usage: UsageSummary
}

export type MessagesPage = {
	runId: string
	agentId?: string
	messages: Message[]
}

export type RunFileEntry = {
	name: string
	path: string
	type: "file" | "directory"
	size: number
	modifiedAt: string
}

export type RunFile =
	| {
			path: string
			type: "directory"
			entries: RunFileEntry[]
	  }
	| {
			path: string
			type: "text"
			size: number
			modifiedAt: string
			content: string
			truncated: boolean
	  }
	| {
			path: string
			type: "binary"
			size: number
			modifiedAt: string
	  }
