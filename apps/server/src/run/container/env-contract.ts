/** The environment-variable contract between the server and the in-container
 * Python SDK (`apps/sdk/python`). Names are declared here once; the SDK's
 * reads (`aegisx/client.py`, `aegisx/channels.py`) and the exec-injection
 * table in `docs/env.md` are pinned to this list by the env-contract test —
 * renaming a variable is a three-way edit, and the test fails until all
 * three sides move together. */

/** Container-level env: set once at container creation (container-manager
 * `Env` / local-manager workspace env), shared by every agent in the
 * container. */
export const SDK_CONTAINER_ENV = {
  eventId: "AEGISX_EVENT_ID",
  apiUrl: "AEGISX_API_URL",
} as const

/** Per-exec env: rides each bash exec (identity is per-agent — one
 * challenge's N agents share a container, so it cannot be container-wide). */
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

/** Build the per-exec identity env for one agent's bash calls. */
export function sdkExecEnv(agentId: string, token: string): string[] {
  return [
    `${SDK_EXEC_ENV.agentId}=${agentId}`,
    `${SDK_EXEC_ENV.token}=${token}`,
  ]
}
