import { mintAgentToken } from "../../infrastructure/agent-credentials"

/** The environment-variable contract between the server and the in-container
 * Python SDK (`apps/sdk/python`). Names are declared here once; the SDK's
 * reads (`aegisx/client.py`, `aegisx/channels.py`) and the exec-injection
 * table in `docs/env.md` are pinned to this list by the env-contract test —
 * renaming a variable is a three-way edit, and the test fails until all
 * three sides move together. */

/** Container-level env: set once at container creation (container-manager
 * `Env` / local-manager workspace env), shared by every exec in that
 * sandbox. */
export const SDK_CONTAINER_ENV = {
  eventId: "AEGISX_EVENT_ID",
  apiUrl: "AEGISX_API_URL",
} as const

/** Per-exec env: rides each bash exec. Identity is minted at call time —
 * a short-lived bearer token that stays valid even for agents idling far
 * beyond one TTL. */
export const SDK_EXEC_ENV = {
  agentId: "AEGISX_AGENT_ID",
  token: "AEGISX_TOKEN",
} as const

/** Build the container-level env array (eventId + the API URL the container
 * should reach the server at). */
export function sdkContainerEnv(eventId: string, apiUrl: string): string[] {
  return [
    `${SDK_CONTAINER_ENV.eventId}=${eventId}`,
    `${SDK_CONTAINER_ENV.apiUrl}=${apiUrl}`,
  ]
}

/** Build the per-exec identity env provider for one agent. The caller
 * invokes it at each bash exec so every call mints a fresh short-lived
 * token (a prepare-time snapshot would go stale on agents idling past the
 * TTL). */
export function sdkExecEnv(agentId: string): () => string[] {
  return () => [
    `${SDK_EXEC_ENV.agentId}=${agentId}`,
    `${SDK_EXEC_ENV.token}=${mintAgentToken(agentId)}`,
  ]
}
