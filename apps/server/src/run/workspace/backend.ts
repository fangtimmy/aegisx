import { isAbsolute, join, relative } from "node:path"
import tarStream from "tar-stream"
import type { ContainerManager } from "../container/container-manager"

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
 * Build a single-file tar for Docker `putArchive`. The entry is the bare
 * filename (putArchive extracts the archive at the target directory, supplied
 * separately). Binary-safe — content is stored verbatim.
 */
export function buildSingleFileTar(
  name: string,
  content: string | Uint8Array,
  mode = 0o644
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pack = tarStream.pack()
    const chunks: Buffer[] = []
    pack.on("data", (chunk: Uint8Array) => chunks.push(Buffer.from(chunk)))
    pack.on("end", () => resolve(Buffer.concat(chunks)))
    pack.on("error", reject)
    pack.entry(
      { name, mode, mtime: new Date(), type: "file" },
      Buffer.from(content)
    )
    pack.finalize()
  })
}

/**
 * WorkspaceBackend whose every operation runs inside the run's tool-box
 * container over dockerode exec (read=cat, list=ls, exec=bash) and putArchive
 * (write). Local and remote containers are identical here — the difference is
 * only the docker daemon the ContainerManager talks to.
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

  async function run(command: string, opts?: { signal?: AbortSignal }) {
    return manager.capture(containerName, command, { signal: opts?.signal })
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
      const dir = dirnameShim(target)
      const name = target.slice(target.lastIndexOf("/") + 1)
      // putArchive extracts the archive at `dir`, so ensure it exists first.
      const mkdir = await run(`mkdir -p ${shellQuote(dir)}`, { signal })
      if (mkdir.exitCode !== 0) {
        throw new Error(
          mkdir.stderr.trim() || `write failed (exit ${mkdir.exitCode})`
        )
      }
      const tar = await buildSingleFileTar(name, content)
      await manager.putArchive(containerName, dir, tar)
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
