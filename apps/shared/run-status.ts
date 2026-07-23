export type RunStatus =
	| "running"
	| "paused"
	| "completed"
	| "failed"
	| "stopped";

export type AgentStatus = RunStatus | "idle";

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
	"completed",
	"failed",
	"stopped",
];

export const TERMINAL_AGENT_STATUSES: readonly AgentStatus[] = [
	"completed",
	"failed",
	"stopped",
];

export function isTerminalRunStatus(status: string): boolean {
	return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}

export function isTerminalAgentStatus(status: string): boolean {
	return (TERMINAL_AGENT_STATUSES as readonly string[]).includes(status);
}
