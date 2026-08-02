import { isAbsolute, join, relative } from "node:path"
import type { ContainerManager } from "../container-manager"

/**
 * Workspace file operations abstracted over the execution target. The agent
 * loop runs host-side; all file tools go through this backend so the workspace
 * can live either in a local container (bind-mounted) or a remote one (no host
 * filesystem access). Every method executes inside the run's tool-box
 * container via `docker exec`.
 */
export type WorkspaceEntry = {
  name: string
  path: string
  directory: boolean
}

export type ExecResult = {
  stdout: string
  stderr: string
  exitCode: number
  outputBytes: number
  truncated: boolean
}

export type BackendExecOptions = {
  signal?: AbortSignal
  timeout?: number
  workdir?: string
  onOutput?: (accumulatedStdout: string) => void
}

export type WorkspaceBackend = {
  /** Workspace root as seen inside the container. Always "/workspace". */
  readonly cwd: string
  /**
   * Resolve an agent-supplied path to a container-internal absolute path.
   * - relative path → under the workspace root
   * - "/workspace/x" → "/workspace/x"
   * - other absolute paths (e.g. "/opt/solver/...") are passed through (read-only)
   * - `write=true` constrains the result to the workspace root.
   */
  resolvePath(path: string, write?: boolean): string
  read(path: string, signal?: AbortSignal): Promise<Uint8Array>
  write(path: string, content: string, signal?: AbortSignal): Promise<void>
  list(path: string, signal?: AbortSignal): Promise<WorkspaceEntry[]>
  exec(command: string, options?: BackendExecOptions): Promise<ExecResult>
}

export function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/**
 * WorkspaceBackend whose every operation runs inside the run's tool-box
 * container over `docker exec` (read=cat, write=tee, list=ls, exec=bash).
 * Local and remote containers are identical here — the difference is only the
 * docker daemon the ContainerManager talks to.
 */
export function createDockerExecBackend(
  containerName: string,
  manager: ContainerManager,
  options?: { maxCapture?: number }
): WorkspaceBackend {
  const cwd = "/workspace"
  const maxCapture = options?.maxCapture ?? 1_000_000

  function resolvePath(path: string, write = false): string {
    const abs = isAbsolute(path) ? path : join(cwd, path)
    if (write) {
      const rel = relative(cwd, abs)
      if (rel.startsWith("..") || isAbsolute(rel)) {
        throw new Error("Path is outside the allowed workspace")
      }
    }
    return abs
  }

  async function run(
    command: string,
    opts?: { signal?: AbortSignal; stdin?: Uint8Array | string }
  ) {
    const result = await manager.capture(containerName, command, {
      signal: opts?.signal,
      stdin: opts?.stdin,
    })
    return result
  }

  return {
    cwd,
    resolvePath,
    async read(path, signal) {
      const result = await run(`cat ${shellQuote(resolvePath(path))}`, {
        signal,
      })
      if (result.exitCode !== 0) {
        throw new Error(
          result.stderr.trim() || `read failed (exit ${result.exitCode})`
        )
      }
      return result.stdout
    },
    async write(path, content, signal) {
      const target = resolvePath(path, true)
      const result = await run(
        `mkdir -p ${shellQuote(dirnameShim(target))} && tee ${shellQuote(target)} > /dev/null`,
        { signal, stdin: content }
      )
      if (result.exitCode !== 0) {
        throw new Error(
          result.stderr.trim() || `write failed (exit ${result.exitCode})`
        )
      }
    },
    async list(path, signal) {
      const target = resolvePath(path)
      const result = await run(
        `ls -1Ap ${shellQuote(target)} 2>/dev/null || ls -1A ${shellQuote(target)}`,
        { signal }
      )
      // Non-zero just means empty/missing; surface as empty list.
      const entries: WorkspaceEntry[] = []
      for (const line of result.stdout.toString("utf8").split("\n")) {
        const name = line.replace(/\/$/, "").trimEnd()
        if (!name) continue
        entries.push({
          name,
          path: join(target, name),
          directory: line.endsWith("/"),
        })
      }
      return entries
    },
    async exec(command, options) {
      const result = await manager.capture(containerName, command, {
        workdir: options?.workdir ?? cwd,
        signal: options?.signal,
        timeout: options?.timeout,
      })
      const stdout = result.stdout.toString("utf8")
      const truncated = result.stdout.byteLength > maxCapture
      return {
        stdout: truncated ? stdout.slice(0, maxCapture) : stdout,
        stderr: result.stderr,
        exitCode: result.exitCode === null ? -1 : result.exitCode,
        outputBytes: result.stdout.byteLength,
        truncated,
      }
    },
  }
}

/** dirname without importing node:path's dirname (keeps container paths POSIX). */
function dirnameShim(path: string) {
  const idx = path.lastIndexOf("/")
  if (idx <= 0) return "/"
  return path.slice(0, idx)
}
