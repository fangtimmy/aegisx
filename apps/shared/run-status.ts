/** v3 run lifecycle: a run is a single Docker container running pi. */
export type RunStatus =
	| "running"
	| "completed"
	| "failed"
	| "stopped"

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
	"completed",
	"failed",
	"stopped",
]

export function isTerminalRunStatus(status: string): boolean {
	return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status)
}

/** Active runs occupy a container. */
export function isActiveRunStatus(status: string): boolean {
	return status === "running"
}
