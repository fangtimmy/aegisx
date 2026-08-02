import { existsSync } from "node:fs"
import Docker from "dockerode"

/**
 * dockerode-backed container lifecycle for v4 runs. The container is a
 * long-lived tool box (Cmd `sleep infinity`); bash is forwarded into it over
 * `docker exec`. There is no PTY attach — the agent loop runs host-side.
 *
 * create/start/wait/kill/remove use plain dockerode HTTP (Bun-safe). Command
 * execution uses the `docker exec` CLI via Bun.spawn: dockerode's exec.start
 * hijack hits the same node:http upgrade hole as PTY attach under Bun, while
 * the CLI streams cleanly.
 */

export type ContainerLimits = {
  cpus: number
  memoryMb: number
  pidsLimit: number
}

export type CreateOptions = {
  name: string
  image: string
  /** Container-internal workspace path (bind target), e.g. "/workspace". */
  workingDir: string
  /** host binds, e.g. ["<abs>:/workspace"]. */
  binds: string[]
  limits: ContainerLimits
  tmpfsSize: string
}

export type ExecOptions = {
  /** Container-internal working directory for the command (default /workspace). */
  workdir?: string
  /** Extra env (KEY=VALUE) injected into the exec. */
  env?: string[]
  onData: (data: Buffer) => void
  signal?: AbortSignal
  timeout?: number
}

export type ContainerManager = ReturnType<typeof createContainerManager>

export function createContainerManager(options?: { socketPath?: string }) {
  const socketPath =
    options?.socketPath ?? process.env.DOCKER_SOCKET ?? "/var/run/docker.sock"
  const docker = existsSync(socketPath)
    ? new Docker({ socketPath })
    : new Docker()

  function get(name: string) {
    return docker.getContainer(name)
  }

  async function exists(name: string): Promise<boolean> {
    try {
      await get(name).inspect()
      return true
    } catch {
      return false
    }
  }

  async function remove(name: string, force = true) {
    try {
      await get(name).remove({ force, v: true })
    } catch (error) {
      if (!/no such (container|image)/i.test(String(error))) throw error
    }
  }

  /** Create + start a sleep-infinity tool-box container. */
  async function create(opts: CreateOptions): Promise<{ id: string }> {
    await remove(opts.name)
    const container = await docker.createContainer({
      name: opts.name,
      Image: opts.image,
      // The image CMD is already `sleep infinity`; state it explicitly so a
      // misconfigured image cannot hijack the tool-box role.
      Cmd: ["sleep", "infinity"],
      WorkingDir: opts.workingDir,
      Tty: false,
      HostConfig: {
        AutoRemove: true,
        Binds: opts.binds,
        NanoCpus: Math.round(opts.limits.cpus * 1e9),
        Memory: opts.limits.memoryMb * 1024 * 1024,
        PidsLimit: opts.limits.pidsLimit,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges"],
        IpcMode: "none",
        Tmpfs: {
          "/tmp": `rw,nosuid,nodev,noexec,size=${opts.tmpfsSize}`,
        },
        ExtraHosts: ["host.docker.internal:host-gateway"],
      },
    })
    await container.start()
    return { id: container.id }
  }

  async function kill(name: string, signal: "SIGTERM" | "SIGKILL") {
    try {
      await get(name).kill({ signal })
    } catch (error) {
      if (!/is not running|no such/i.test(String(error))) throw error
    }
  }

  /** Resolves when the container's main process exits. */
  function wait(name: string): Promise<{ StatusCode: number }> {
    return get(name).wait() as Promise<{ StatusCode: number }>
  }

  async function isRunning(name: string): Promise<boolean> {
    try {
      const info = await get(name).inspect()
      return Boolean(info.State?.Running)
    } catch {
      return false
    }
  }

  /**
   * Run a command inside a running container via `docker exec`, streaming
   * merged stdout+stderr to onData. Resolves with the process exit code
   * (null if killed by signal/timeout). Bun-safe (plain Bun.spawn).
   */
  async function exec(
    name: string,
    command: string,
    opts: ExecOptions
  ): Promise<{ exitCode: number | null }> {
    const workdir = opts.workdir ?? "/workspace"
    const argv = ["docker", "exec"]
    if (opts.env) {
      for (const entry of opts.env) argv.push("-e", entry)
    }
    argv.push("-w", workdir, name, "bash", "-lc", command)

    const proc = Bun.spawn(argv, {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    })

    let timedOut = false
    const onAbort = () => {
      try {
        proc.kill()
      } catch {
        // ignore
      }
    }
    opts.signal?.addEventListener("abort", onAbort, { once: true })

    let timer: ReturnType<typeof setTimeout> | undefined
    if (opts.timeout && opts.timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true
        try {
          proc.kill()
        } catch {
          // ignore
        }
      }, opts.timeout)
    }

    const pump = async (stream: ReadableStream<Uint8Array> | null) => {
      if (!stream) return
      const reader = stream.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) opts.onData(Buffer.from(value))
      }
    }

    try {
      await Promise.all([pump(proc.stdout), pump(proc.stderr)])
      const exitCode = await proc.exited
      return { exitCode: timedOut ? null : exitCode }
    } finally {
      if (timer) clearTimeout(timer)
      opts.signal?.removeEventListener("abort", onAbort)
    }
  }

  async function readStream(stream: ReadableStream<Uint8Array> | null) {
    if (!stream) return Buffer.alloc(0)
    const reader = stream.getReader()
    const chunks: Buffer[] = []
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks)
  }

  /**
   * Run a command inside a running container, capturing stdout and stderr
   * separately (stdin optional). Used by workspace file tools (read/write/grep/
   * find/ls) which need structured output, unlike the streaming bash tool.
   */
  async function capture(
    name: string,
    command: string,
    opts?: {
      workdir?: string
      env?: string[]
      signal?: AbortSignal
      timeout?: number
      stdin?: Uint8Array | string
    }
  ): Promise<{ stdout: Buffer; stderr: string; exitCode: number | null }> {
    const workdir = opts?.workdir ?? "/workspace"
    const argv = ["docker", "exec"]
    if (opts?.env) {
      for (const entry of opts.env) argv.push("-e", entry)
    }
    argv.push("-i", "-w", workdir, name, "bash", "-lc", command)
    const proc = Bun.spawn(argv, {
      stdout: "pipe",
      stderr: "pipe",
      stdin: opts?.stdin !== undefined ? "pipe" : "ignore",
    })
    if (opts?.stdin !== undefined && proc.stdin) {
      proc.stdin.write(opts.stdin)
      await proc.stdin.end()
    }
    let timedOut = false
    const onAbort = () => {
      try {
        proc.kill()
      } catch {
        // ignore
      }
    }
    opts?.signal?.addEventListener("abort", onAbort, { once: true })
    let timer: ReturnType<typeof setTimeout> | undefined
    if (opts?.timeout && opts.timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true
        try {
          proc.kill()
        } catch {
          // ignore
        }
      }, opts.timeout)
    }
    try {
      const [stdout, stderr] = await Promise.all([
        readStream(proc.stdout),
        readStream(proc.stderr),
      ])
      const exitCode = await proc.exited
      return {
        stdout,
        stderr: stderr.toString("utf8"),
        exitCode: timedOut ? null : exitCode,
      }
    } finally {
      if (timer) clearTimeout(timer)
      opts?.signal?.removeEventListener("abort", onAbort)
    }
  }

  return {
    create,
    kill,
    wait,
    remove,
    exists,
    isRunning,
    exec,
    capture,
    get,
  }
}
