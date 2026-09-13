import { join } from "node:path"

/**
 * v19 workspace paths. The
 * workspace is a DERIVED PATH, not a row: every challenge of an event owns a
 * directory tree under data/events/<eventId>/challenges/<challengeId>/, the
 * scheduler owns data/events/<eventId>/orchestrator/. Each holds workspace/
 * (container bind → /workspace) and runtime/ subdirectories.
 *
 * Sandbox identity: one one-shot container per agent (prepare → settle), one
 * for the scheduler agent per event. The challenge-level shared resource is
 * the named cache volume (apt/pip/go caches survive container churn).
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

/** Container name for one agent's one-shot sandbox. */
export function agentContainerName(agentId: string): string {
  return `aegisx-agent-${agentId8(agentId)}`
}

/** Container name for the scheduler workspace. */
export function orchestratorContainerName(eventId: string): string {
  return `aegisx-orch-${agentId8(eventId)}`
}

/** Named docker volume holding a challenge's tool caches (apt archives +
 * /opt/aegisx-cache); shared by the challenge's agent containers, removed
 * with the challenge. */
export function challengeCacheVolume(challengeId: string): string {
  return `aegisx-ch-cache-${challengeId}`
}
