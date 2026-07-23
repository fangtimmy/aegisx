import { join } from "node:path"
import type { EnvironmentConfig } from "../../../shared"
import { createLocalBackend, type WorkspaceBackend } from "../agents/tools"
import type { SettingsPublic } from "../infrastructure/config-store"
import {
  containerName,
  containerRunningAsync,
  createContainerAsync,
  createContainerBackend,
  removeContainerAsync,
} from "../infrastructure/container"
import { RunStartError } from "./errors"

export type ContainerPool = ReturnType<typeof createContainerPool>

export function createContainerPool(options: {
  dataDir: string
  onFailure(runId: string): void
}) {
  const active = new Map<string, string>()
  const failures = new Map<string, string>()

  async function ensureBackend(
    runId: string,
    workspacePath: string | null,
    environment: EnvironmentConfig,
    settings: Pick<
      SettingsPublic,
      | "containerWorkspace"
      | "dockerTimeoutMs"
      | "tmpfsSize"
      | "maxCapturedShellOutputBytes"
    >
  ): Promise<WorkspaceBackend> {
    if (environment.type !== "container") {
      if (!workspacePath)
        throw new RunStartError("Run workspace is unavailable")
      return createLocalBackend(join(options.dataDir, workspacePath))
    }

    let name = active.get(runId)
    if (name && !(await containerRunningAsync(name))) {
      active.delete(runId)
      name = undefined
    }
    if (!name) {
      name = containerName(runId)
      if (!workspacePath) {
        throw new RunStartError("Run workspace is unavailable")
      }
      try {
        await createContainerAsync(
          name,
          join(options.dataDir, workspacePath),
          environment.image,
          environment,
          {
            containerWorkspace: settings.containerWorkspace,
            dockerTimeoutMs: settings.dockerTimeoutMs,
            tmpfsSize: settings.tmpfsSize,
          }
        )
      } catch {
        throw new RunStartError("Container could not be started")
      }
      active.set(runId, name)
    }
    return createContainerBackend(
      name,
      {
        cwd: settings.containerWorkspace,
        maxCapturedShellOutput: settings.maxCapturedShellOutputBytes,
      },
      () => {
        if (active.get(runId) === name) {
          active.delete(runId)
          void removeContainerAsync(name)
        }
        if (!failures.has(runId)) {
          failures.set(runId, "Container execution became unavailable")
          options.onFailure(runId)
        }
      }
    )
  }

  async function release(runId: string) {
    const name = active.get(runId)
    if (!name) return
    await removeContainerAsync(name)
    active.delete(runId)
  }

  async function releaseAll() {
    await Promise.allSettled(
      [...active.values()].map((name) => removeContainerAsync(name))
    )
    active.clear()
    failures.clear()
  }

  return {
    ensureBackend,
    release,
    releaseAll,
    takeFailure(runId: string) {
      const value = failures.get(runId)
      if (value !== undefined) failures.delete(runId)
      return value
    },
    hasFailure(runId: string) {
      return failures.has(runId)
    },
    clearFailure(runId: string) {
      failures.delete(runId)
    },
  }
}
