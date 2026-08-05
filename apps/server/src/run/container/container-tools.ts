import type { BashOperations } from "@earendil-works/pi-coding-agent"
import type { ContainerManager } from "./container-manager"

/**
 * Bridge the pi SDK bash tool into the run's Kali container. The bash tool
 * calls `operations.exec(command, cwd, {...})`; we forward each command to the
 * container over `docker exec`. Both `cwd` and `env` are dropped: the
 * container owns its working directory (its `WorkingDir`, set at create time
 * from the `container.workspace` setting) and its environment (build-time ENV,
 * incl. the venv on PATH) — forwarding the host's would shadow both. Each exec
 * is a fresh non-login shell, matching pi's local-bash per-call semantics.
 */
export function createContainerBashOperations(
  containerName: string,
  manager: ContainerManager
): BashOperations {
  return {
    exec: async (command, _cwd, options) => {
      return manager.exec(containerName, command, {
        onData: options.onData,
        signal: options.signal,
        timeout: options.timeout,
      })
    },
  }
}
