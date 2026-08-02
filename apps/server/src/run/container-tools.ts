import type { BashOperations } from "@earendil-works/pi-coding-agent"
import type { ContainerManager } from "./container-manager"

/**
 * Bridge the pi SDK bash tool into the run's Kali container. The bash tool
 * calls `operations.exec(command, cwd, {...})`; we forward each command to the
 * container over `docker exec`. `cwd` is a host path (the session cwd); the
 * container only ever sees `/workspace` (the bind target), so we always exec
 * there. Each exec is a fresh shell, matching pi's local-bash per-call cwd
 * semantics.
 */
export function createContainerBashOperations(
  containerName: string,
  manager: ContainerManager
): BashOperations {
  return {
    exec: async (command, _cwd, options) => {
      return manager.exec(containerName, command, {
        workdir: "/workspace",
        onData: options.onData,
        signal: options.signal,
        timeout: options.timeout,
        env: envToDocker(options.env),
      })
    },
  }
}

function envToDocker(env?: NodeJS.ProcessEnv): string[] | undefined {
  if (!env) return undefined
  const entries: string[] = []
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue
    entries.push(`${key}=${value}`)
  }
  return entries.length > 0 ? entries : undefined
}
