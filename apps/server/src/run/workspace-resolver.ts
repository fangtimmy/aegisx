import { join } from "node:path"

/**
 * v19 workspace paths. The
 * workspace is a DERIVED PATH, not a row: every challenge of an event owns a
 * directory tree under data/events/<eventId>/challenges/<challengeId>/, the
 * scheduler owns data/events/<eventId>/orchestrator/. Each holds workspace/
 * (container bind → /workspace), sessions/, and runtime/ subdirectories.
 *
 * Container identity: one container per challenge workspace (shared by every
 * agent attacking the challenge), one for the scheduler workspace. Keyed by
 * challengeId / `orch:<eventId>`; the container name embeds a short slice.
 */

const ORCH_KEY_PREFIX = "orch:"

/** The scheduler workspace key (the registry/LiveBus-neutral identity). */
export function orchestratorKey(eventId: string): string {
  return `${ORCH_KEY_PREFIX}${eventId}`
}

/** Host root of a challenge's workspace tree
 * (data/events/<eventId>/challenges/<challengeId>). */
export function challengeRoot(
  dataDir: string,
  eventId: string,
  challengeId: string
): string {
  return join(dataDir, "events", eventId, "challenges", challengeId)
}

/** Host root of the scheduler's workspace tree
 * (data/events/<eventId>/orchestrator). */
export function orchestratorRoot(dataDir: string, eventId: string): string {
  return join(dataDir, "events", eventId, "orchestrator")
}

export function workspaceDir(root: string): string {
  return join(root, "workspace")
}

export function sessionsDir(root: string): string {
  return join(root, "sessions")
}

export function runtimeDir(root: string): string {
  return join(root, "runtime")
}

/** The agent's 8-char identity slice (dir names, labels, container ids). */
export function agentId8(agentId: string): string {
  return agentId.slice(0, 8)
}

/** Container-internal path of one agent's directory
 * (<containerWorkspace>/agents/<id8>). */
export function agentContainerDir(
  containerWorkspace: string,
  agentId: string
): string {
  return `${containerWorkspace.replace(/\/$/, "")}/agents/${agentId8(agentId)}`
}

/** Container name for a challenge workspace. */
export function challengeContainerName(challengeId: string): string {
  return `aegisx-ws-${agentId8(challengeId)}`
}

/** Container name for the scheduler workspace. */
export function orchestratorContainerName(eventId: string): string {
  return `aegisx-orch-${agentId8(eventId)}`
}
