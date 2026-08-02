/** v4 run lifecycle: host-side pi SDK drives the agent; the container is a tool box. */
export type RunStatus =
	| "running"
	| "completed"
	| "failed"
	| "stopped"
	| "timed_out"

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
	"completed",
	"failed",
	"stopped",
	"timed_out",
]

export function isTerminalRunStatus(status: string): boolean {
	return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status)
}

/** Active runs occupy a container and a host-side AgentSession. */
export function isActiveRunStatus(status: string): boolean {
	return status === "running"
}

/** Per-agent lifecycle (main + child agents in a run). */
export type AgentStatus = "running" | "completed" | "failed" | "stopped"
