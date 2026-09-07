import { spawn } from "node:child_process"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"
import { Writable } from "node:stream"

import { extract } from "tar-stream"

// The bun-provided child_process types omit the EventEmitter surface of
// ChildProcess; restore it so spawn children can be awaited normally.
declare module "node:child_process" {
  interface ChildProcess extends NodeJS.EventEmitter {}
}

import {
  collectSink,
  type CreateOptions,
  type ExecOptions,
  execTimeoutMs,
} from "./container-manager"

/**
 * Same-container execution backend for the single-image appliance: the agent
 * loop and the tool box share one container, so "exec in the tool box" is a
 * local `bash -c` child process instead of a dockerode exec. Path mapping
 * reproduces the bind mounts the docker backend would create — every bind
 * `<host>:<containerPath>` becomes a translation rule, so workspace file
 * tools (which speak container paths like /workspace/agents/<id8>) and the
 * scheduler's read-only /challenges mount keep working unmodified.
 *
 * Differences from the docker backend, accepted for the local single-user
 * deployment: no inter-challenge isolation (all bash runs in the server's
 * namespace), and the container resource limits (cpus/memory/pids/tmpfs)
 * are ignored — timeouts and aborts still kill whole process groups.
 */

export function isLocalExecBackend(): boolean {
  return process.env.AEGISX_EXEC_BACKEND === "local"
}

/**
 * Container-internal workspace root for one workspace under the local
 * backend. The docker backend isolates workspaces by giving every container
 * its own /workspace bind; the local backend shares one filesystem, so each
 * workspace gets a unique container path (symlinked to its host dir at
 * create time) — otherwise the second workspace's /workspace references
 * would resolve into the first one's files.
 */
export function localContainerWorkspace(key: string): string {
  const id8 = key.startsWith("orch:")
    ? `orch-${key.slice(5, 13)}`
    : key.slice(0, 8)
  return `/opt/aegisx-ws/${id8}`
}

type MountRule = { containerPath: string; hostPath: string }

type LocalWorkspace = {
  mounts: MountRule[]
  /** Default workdir as a container path (create-time workingDir). */
  workdir: string
  env: Record<string, string>
  /** Live exec processes (group leaders) — killed on workspace teardown. */
  procs: Set<number>
}

function parseEnvEntries(
  entries: string[] | undefined
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const entry of entries ?? []) {
    const eq = entry.indexOf("=")
    if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1)
  }
  return env
}

function parseBinds(binds: string[]): MountRule[] {
  const rules: MountRule[] = []
  for (const spec of binds) {
    const parts = spec.split(":")
    if (parts.length < 2 || !parts[0] || !parts[1]) continue
    rules.push({
      containerPath: parts[1].replace(/\/$/, ""),
      hostPath: parts[0],
    })
  }
  return rules
}

function under(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`)
}

function toHost(ws: LocalWorkspace, containerPath: string): string {
  let best: MountRule | undefined
  for (const rule of ws.mounts) {
    if (under(containerPath, rule.containerPath)) {
      if (!best || rule.containerPath.length > best.containerPath.length) {
        best = rule
      }
    }
  }
  if (!best) return containerPath
  return join(best.hostPath, containerPath.slice(best.containerPath.length))
}

type RunOptions = {
  workdir?: string
  signal?: AbortSignal
  timeout?: number
  env?: string[]
  stdoutSink: NodeJS.WritableStream
  stderrSink: NodeJS.WritableStream
}

type RunResult = {
  exitCode: number | null
  timedOut: boolean
  aborted: boolean
}

function runLocal(
  ws: LocalWorkspace,
  command: string,
  opts: RunOptions
): Promise<RunResult> {
  return new Promise((resolve) => {
    const cwd = toHost(ws, opts.workdir ?? ws.workdir)
    mkdirSync(cwd, { recursive: true })
    const env = {
      ...process.env,
      ...ws.env,
      ...parseEnvEntries(opts.env),
    }
    // Keep stdio loosely typed: the precise tuple overload yields a
    // ChildProcessByStdio type that loses the event-emitter surface.
    const stdio: Array<"ignore" | "pipe"> = ["ignore", "pipe", "pipe"]
    const child = spawn("bash", ["-c", command], {
      cwd,
      env,
      detached: true,
      stdio,
    })

    let timedOut = false
    let aborted = opts.signal?.aborted ?? false
    let settled = false

    const killGroup = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL")
        } catch {
          // group already gone
        }
      }
    }

    if (child.pid) ws.procs.add(child.pid)
    const untrack = () => {
      if (child.pid) ws.procs.delete(child.pid)
    }

    const onAbort = () => {
      aborted = true
      killGroup()
    }
    if (opts.signal && !aborted) {
      opts.signal.addEventListener("abort", onAbort, { once: true })
    }

    const ms = execTimeoutMs(opts.timeout)
    const timer =
      ms !== undefined
        ? setTimeout(() => {
            timedOut = true
            killGroup()
          }, ms)
        : undefined

    const finish = (result: RunResult) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      opts.signal?.removeEventListener("abort", onAbort)
      untrack()
      resolve(result)
    }

    if (child.stdout) child.stdout.pipe(opts.stdoutSink)
    if (child.stderr) child.stderr.pipe(opts.stderrSink)

    child.on("error", (error) => {
      opts.stderrSink.write(
        `local exec failed: ${error instanceof Error ? error.message : String(error)}\n`
      )
      finish({ exitCode: 127, timedOut: false, aborted })
    })
    child.on("close", (code, signal) => {
      const exitCode = timedOut || aborted || signal ? null : code
      finish({ exitCode, timedOut, aborted })
    })
  })
}

export function createLocalContainerManager() {
  const workspaces = new Map<string, LocalWorkspace>()

  function requireWorkspace(name: string): LocalWorkspace {
    const ws = workspaces.get(name)
    if (!ws) throw new Error(`Unknown local workspace: ${name}`)
    return ws
  }

  async function create(opts: CreateOptions): Promise<{ id: string }> {
    await remove(opts.name)
    const mounts = parseBinds([...opts.binds, ...(opts.extraBinds ?? [])])
    for (const rule of mounts) {
      if (!existsSync(rule.hostPath))
        mkdirSync(rule.hostPath, { recursive: true })
      // Reproduce the bind mount: a docker bind exposes the host dir at the
      // container path for EVERY access (bash, cwd, file tools). The local
      // equivalent is a symlink at the container path — commands using
      // container-internal absolute paths (/workspace/..., /challenges/...)
      // keep working unmodified.
      if (
        !existsSync(rule.containerPath) &&
        !lstatSync(rule.containerPath, { throwIfNoEntry: false })
      ) {
        mkdirSync(dirname(rule.containerPath), { recursive: true })
        symlinkSync(rule.hostPath, rule.containerPath)
      }
    }
    workspaces.set(opts.name, {
      mounts,
      workdir: opts.workingDir,
      env: parseEnvEntries(opts.env),
      procs: new Set(),
    })
    return { id: opts.name }
  }

  async function kill(
    name: string,
    _signal: "SIGTERM" | "SIGKILL"
  ): Promise<void> {
    const ws = workspaces.get(name)
    if (!ws) return
    for (const pid of ws.procs) {
      try {
        process.kill(-pid, "SIGKILL")
      } catch {
        // group already gone
      }
    }
    ws.procs.clear()
  }

  async function remove(name: string): Promise<void> {
    await kill(name, "SIGKILL")
    workspaces.delete(name)
  }

  async function isRunning(name: string): Promise<boolean> {
    return workspaces.has(name)
  }

  async function exec(
    name: string,
    command: string,
    opts: ExecOptions
  ): Promise<RunResult> {
    const ws = requireWorkspace(name)
    const sink: NodeJS.WritableStream = new Writable({
      write(chunk, _encoding, cb) {
        opts.onData(Buffer.from(chunk))
        cb()
      },
    })
    return runLocal(ws, command, {
      ...opts,
      stdoutSink: sink,
      stderrSink: sink,
    })
  }

  async function capture(
    name: string,
    command: string,
    opts?: {
      workdir?: string
      signal?: AbortSignal
      timeout?: number
      env?: string[]
      maxCapture?: number
    }
  ) {
    const ws = requireWorkspace(name)
    const outChunks: Buffer[] = []
    const errChunks: Buffer[] = []
    const stdout = collectSink(outChunks, opts?.maxCapture)
    const stderr = collectSink(errChunks, opts?.maxCapture)
    const { exitCode } = await runLocal(ws, command, {
      workdir: opts?.workdir,
      signal: opts?.signal,
      timeout: opts?.timeout,
      env: opts?.env,
      stdoutSink: stdout.sink,
      stderrSink: stderr.sink,
    })
    return {
      stdout: Buffer.concat(outChunks),
      stderr: Buffer.concat(errChunks).toString("utf8"),
      exitCode,
      truncated:
        opts?.maxCapture !== undefined && stdout.bytes() > opts.maxCapture,
      totalBytes: stdout.bytes(),
    }
  }

  async function putArchive(
    name: string,
    path: string,
    tar: Buffer | NodeJS.ReadableStream
  ): Promise<void> {
    const ws = requireWorkspace(name)
    const target = toHost(ws, path)
    await new Promise<void>((resolve, reject) => {
      const ex = extract()
      ex.on("entry", (header, stream, next) => {
        const dest = join(target, header.name)
        try {
          if (header.type === "directory") {
            mkdirSync(dest, { recursive: true })
            stream.resume()
            next()
            return
          }
          const chunks: Buffer[] = []
          stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
          stream.on("end", () => {
            try {
              mkdirSync(dirname(dest), { recursive: true })
              writeFileSync(dest, Buffer.concat(chunks), {
                mode: (header.mode ?? 0o644) & 0o777,
              })
              next()
            } catch (error) {
              ex.destroy(
                error instanceof Error ? error : new Error(String(error))
              )
            }
          })
        } catch (error) {
          ex.destroy(error instanceof Error ? error : new Error(String(error)))
        }
      })
      ex.on("finish", () => resolve())
      ex.on("error", reject)
      if (Buffer.isBuffer(tar)) ex.end(tar)
      else tar.pipe(ex)
    })
  }

  return {
    create,
    kill,
    remove,
    isRunning,
    exec,
    capture,
    putArchive,
    get: (_name: string) => {
      throw new Error("The local execution backend has no docker containers")
    },
  }
}
