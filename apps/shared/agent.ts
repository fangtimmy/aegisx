import type { AgentStatus } from "./run-status"

/** v4 agent: one main AgentSession per run, plus optional child agents. */
export type AgentRole = "main" | "child"

export type AgentSummary = {
	id: string
	runId: string
	role: AgentRole
	/** null for the main agent. */
	parentAgentId: string | null
	name: string | null
	/** Delegated task text for child agents; null for main. */
	task: string | null
	status: AgentStatus
	/** SessionManager jsonl path (resume + audit). */
	sessionFile: string | null
	createdAt: string
	startedAt: string | null
	updatedAt: string
	completedAt: string | null
	error: string | null
}
