import { existsSync } from "node:fs"
import { type Readable, Writable } from "node:stream"
import Docker from "dockerode"

/**
 * dockerode-backed container lifecycle + execution for v4 runs. The container
 * is a long-lived tool box (Cmd `sleep infinity`); bash and the workspace file
 * tools run inside it over dockerode `exec` (hijacked stream, demuxed) and
 * `putArchive`. No PTY attach, no `docker` CLI dependency — the agent loop runs
 * host-side and every daemon call goes through dockerode.
 *
 * Lifecycle (create/start/wait/kill/remove/inspect) is plain dockerode HTTP.
 * Exec uses hijacked `exec.start` + `modem.demuxStream`, which works under Bun
 * for reads. Writes go through `putArchive` rather than stdin, sidestepping the
 * dockerode+stdin exec hang fixed only in Bun 1.4.0 (oven-sh/bun#29012).
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

  /** Writable that collects every chunk into a buffer list. */
  function collectSink(into: Buffer[]): NodeJS.WritableStream {
    return new Writable({
      write(chunk, _encoding, cb) {
        into.push(Buffer.from(chunk))
        cb()
      },
    })
  }

  /** Writable that forwards every chunk to onData (merged stdout+stderr). */
  function onDataSink(onData: (chunk: Buffer) => void): NodeJS.WritableStream {
    return new Writable({
      write(chunk, _encoding, cb) {
        onData(Buffer.from(chunk))
        cb()
      },
    })
  }

  /**
   * Resolve an exec's ExitCode after its hijacked stream closed. The daemon may
   * briefly keep Running:true, so poll a few times.
   */
  async function pollExitCode(execInst: {
    inspect(): Promise<{ Running?: boolean; ExitCode?: number | null }>
  }): Promise<number | null> {
    for (let i = 0; i < 10; i++) {
      const info = await execInst.inspect()
      if (info.Running === false && info.ExitCode != null) {
        return info.ExitCode
      }
      await new Promise((r) => setTimeout(r, 30))
    }
    const info = await execInst.inspect()
    return info.ExitCode ?? null
  }

  /**
   * Run a command inside a running container over dockerode exec, streaming
   * merged stdout+stderr onto onData. Docker multiplexes by frame in arrival
   * order, so demuxing both streams onto the same sink preserves interleaving.
   * Resolves with the exit code (null on timeout). Abort/timeout destroys the
   * hijacked stream; closing it lets the daemon terminate the exec process —
   * matching the old `docker exec` client-kill semantics.
   */
  async function exec(
    name: string,
    command: string,
    opts: ExecOptions
  ): Promise<{ exitCode: number | null }> {
    const workdir = opts.workdir ?? "/workspace"
    const execInst = await get(name).exec({
      Cmd: ["bash", "-lc", command],
      WorkingDir: workdir,
      AttachStdout: true,
      AttachStderr: true,
      Env: opts.env,
      Tty: false,
    })

    let timedOut = false
    let stream: Readable | undefined
    const destroyStream = () => {
      try {
        stream?.destroy()
      } catch {
        // ignore
      }
    }
    opts.signal?.addEventListener("abort", destroyStream, { once: true })
    let timer: ReturnType<typeof setTimeout> | undefined
    if (opts.timeout && opts.timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true
        destroyStream()
      }, opts.timeout)
    }

    try {
      stream = await execInst.start({ Detach: false, Tty: false })
      docker.modem.demuxStream(
        stream,
        onDataSink(opts.onData),
        onDataSink(opts.onData)
      )
      await new Promise<void>((resolve, reject) => {
        if (!stream) return resolve()
        stream.on("end", resolve)
        stream.on("close", resolve)
        stream.on("error", reject)
      })
      const exitCode = await pollExitCode(execInst)
      return { exitCode: timedOut ? null : exitCode }
    } finally {
      if (timer) clearTimeout(timer)
      opts.signal?.removeEventListener("abort", destroyStream)
    }
  }

  /**
   * Run a command inside a running container, capturing stdout and stderr
   * separately. Used by workspace file tools (read/grep/find/ls) which need
   * structured output, unlike the streaming bash tool.
   */
  async function capture(
    name: string,
    command: string,
    opts?: {
      workdir?: string
      env?: string[]
      signal?: AbortSignal
      timeout?: number
    }
  ): Promise<{ stdout: Buffer; stderr: string; exitCode: number | null }> {
    const workdir = opts?.workdir ?? "/workspace"
    const execInst = await get(name).exec({
      Cmd: ["bash", "-lc", command],
      WorkingDir: workdir,
      AttachStdout: true,
      AttachStderr: true,
      Env: opts?.env,
      Tty: false,
    })

    let timedOut = false
    let stream: Readable | undefined
    const destroyStream = () => {
      try {
        stream?.destroy()
      } catch {
        // ignore
      }
    }
    opts?.signal?.addEventListener("abort", destroyStream, { once: true })
    let timer: ReturnType<typeof setTimeout> | undefined
    if (opts?.timeout && opts.timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true
        destroyStream()
      }, opts.timeout)
    }

    try {
      stream = await execInst.start({ Detach: false, Tty: false })
      const outChunks: Buffer[] = []
      const errChunks: Buffer[] = []
      docker.modem.demuxStream(
        stream,
        collectSink(outChunks),
        collectSink(errChunks)
      )
      await new Promise<void>((resolve, reject) => {
        if (!stream) return resolve()
        stream.on("end", resolve)
        stream.on("close", resolve)
        stream.on("error", reject)
      })
      const exitCode = await pollExitCode(execInst)
      return {
        stdout: Buffer.concat(outChunks),
        stderr: Buffer.concat(errChunks).toString("utf8"),
        exitCode: timedOut ? null : exitCode,
      }
    } finally {
      if (timer) clearTimeout(timer)
      opts?.signal?.removeEventListener("abort", destroyStream)
    }
  }

  /** Extract a tar archive at `path` inside the container (Docker putArchive). */
  async function putArchive(
    name: string,
    path: string,
    tar: Buffer | NodeJS.ReadableStream
  ): Promise<void> {
    await get(name).putArchive(tar, { path })
  }

  /** Stream a tar archive of `path` out of the container (Docker getArchive). */
  async function getArchive(
    name: string,
    path: string
  ): Promise<NodeJS.ReadableStream> {
    return get(name).getArchive({ path })
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
    putArchive,
    getArchive,
    get,
  }
}
