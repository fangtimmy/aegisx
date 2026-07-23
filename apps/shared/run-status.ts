export type RunStatus =
	| "running"
	| "paused"
	| "completed"
	| "failed"
	| "stopped"

/** Agent adds idle: main finished a turn without finishing the run. */
export type AgentStatus = RunStatus | "idle"

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
	"completed",
	"failed",
	"stopped",
]

export const TERMINAL_AGENT_STATUSES: readonly AgentStatus[] = [
	"completed",
	"failed",
	"stopped",
]

/** Active for concurrency accounting. */
export const ACTIVE_AGENT_STATUSES: readonly AgentStatus[] = [
	"running",
	"idle",
]

export function isTerminalRunStatus(status: string): boolean {
	return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status)
}

export function isTerminalAgentStatus(status: string): boolean {
	return (TERMINAL_AGENT_STATUSES as readonly string[]).includes(status)
}

export function isActiveAgentStatus(status: string): boolean {
	return (ACTIVE_AGENT_STATUSES as readonly string[]).includes(status)
}
