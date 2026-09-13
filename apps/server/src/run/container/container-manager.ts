import { existsSync } from "node:fs"
import { type Readable, Writable } from "node:stream"

import Docker from "dockerode"

import type { Clock, ClockTimer } from "../clock"
import { createTimerHub, systemClock } from "../clock"

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

type ContainerLimits = {
  cpus: number
  memoryMb: number
  pidsLimit: number
}

/** Writable that collects chunks into a buffer list, dropping bytes beyond
 * `maxCapture` while still counting them — bounds RAM on pathological output
 * (e.g. `cat core.dump`) without losing the true byte count. Returns the sink
 * plus a `bytes()` readout of the total bytes seen. */
export function collectSink(
  into: Buffer[],
  maxCapture?: number
): { sink: NodeJS.WritableStream; bytes: () => number } {
  let total = 0
  let buffered = 0
  return {
    sink: new Writable({
      write(chunk, _encoding, cb) {
        const buf = Buffer.from(chunk)
        total += buf.length
        if (maxCapture === undefined) {
          into.push(buf)
          buffered += buf.length
        } else if (buffered < maxCapture) {
          const room = Math.min(buf.length, maxCapture - buffered)
          into.push(buf.subarray(0, room))
          buffered += room
        }
        cb()
      },
    }),
    bytes: () => total,
  }
}

export type CreateOptions = {
  name: string
  image: string
  /** Container-internal workspace path (bind target), e.g. "/workspace". */
  workingDir: string
  /** host binds, e.g. ["<abs>:/workspace"]. */
  binds: string[]
  /** Extra read-only-ish binds beyond the workspace (e.g. the scheduler SDK
   * mount). Appended to `binds`. */
  extraBinds?: string[]
  /** Container env as "KEY=value" entries (dockerode Env). */
  env?: string[]
  limits: ContainerLimits
  tmpfsSize: string
  /** Docker network mode (HostConfig.NetworkMode). Empty/undefined = default
   * bridge. Set to `container:<name>` to share another container's netns
   * (e.g. a self-managed VPN container), so solvers reach VPN routes without
   * their own NET_ADMIN. */
  networkMode?: string
}

export type ExecOptions = {
  /** Container-internal working directory; omitted = inherit the container's
   * WorkingDir (set at create time from the container.workspace setting). */
  workdir?: string
  onData: (data: Buffer) => void
  signal?: AbortSignal
  /** Timeout in seconds (matches the bash tool schema; converted to ms in exec). */
  timeout?: number
  /** Per-call env additions as "KEY=value" entries (dockerode exec Env).
   * Per-exec identity injection for the in-container SDK — e.g. the solver
   * SDK's AEGISX_AGENT_ID + AEGISX_TOKEN. */
  env?: string[]
}

/**
 * Structural slice of the dockerode client this manager touches. Exists as the
 * test seam: passing a fake via {@link createContainerManager} options drives
 * hijacked exec streams without a Docker daemon; when omitted the real client
 * is constructed from the socket path exactly as before.
 */
export type DockerLike = {
  getContainer(name: string): {
    exec(opts: {
      Cmd?: string[]
      WorkingDir?: string
      AttachStdout?: boolean
      AttachStderr?: boolean
      Tty?: boolean
      Env?: string[]
    }): Promise<{
      start(opts: { Detach: boolean; Tty: boolean }): Promise<Readable>
      inspect(): Promise<{ Running?: boolean; ExitCode?: number | null }>
    }>
    inspect(): Promise<{ State: { Running: boolean } }>
    remove(opts?: { force?: boolean; v?: boolean }): Promise<unknown>
    kill(opts?: { signal?: string }): Promise<unknown>
    putArchive(
      tar: Buffer | NodeJS.ReadableStream,
      opts: { path: string }
    ): Promise<unknown>
  }
  createContainer(opts: object): Promise<{
    id: string
    start(): Promise<unknown>
  }>
  /** Daemon-wide container list (the boot orphan sweep's name-prefix scan). */
  listContainers(opts: {
    all?: boolean
    filters?: string
  }): Promise<Array<{ Id: string; Names?: string[] }>>
  getVolume(name: string): {
    remove(): Promise<unknown>
  }
  modem: {
    demuxStream(
      stream: NodeJS.ReadableStream,
      stdout: NodeJS.WritableStream,
      stderr: NodeJS.WritableStream
    ): void
  }
}

export type ContainerManager = ReturnType<typeof createContainerManager>

/**
 * Convert a per-call timeout (seconds, as exposed by the bash tool schema and
 * the workspace file tools) into the milliseconds setTimeout expects. Returns
 * undefined when no timeout applies. Centralized so the seconds→ms contract has
 * a single definition (and a single test) — passing seconds straight into
 * setTimeout used to be a 1000× off bug that silently dropped all output.
 */
export function execTimeoutMs(timeoutSec?: number): number | undefined {
  if (!timeoutSec || timeoutSec <= 0) return undefined
  return timeoutSec * 1000
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
async function pollExitCode(
  clock: Clock,
  execInst: {
    inspect(): Promise<{ Running?: boolean; ExitCode?: number | null }>
  }
): Promise<number | null> {
  for (let i = 0; i < 10; i++) {
    const info = await execInst.inspect()
    if (info.Running === false && info.ExitCode != null) {
      return info.ExitCode
    }
    await clock.sleep(30)
  }
  const info = await execInst.inspect()
  return info.ExitCode ?? null
}

export function createContainerManager(options?: {
  socketPath?: string
  /** Test seam: used in place of a daemon-backed dockerode client when given. */
  docker?: DockerLike
  /** Time layer (default: the system clock); drives the exec timeout and the
   * pollExitCode backoff. */
  clock?: Clock
}) {
  const socketPath =
    options?.socketPath ?? process.env.DOCKER_SOCKET ?? "/var/run/docker.sock"
  const docker: DockerLike =
    options?.docker ??
    (existsSync(socketPath) ? new Docker({ socketPath }) : new Docker())
  const clock = options?.clock ?? systemClock
  // Exec timeouts are per-call and cleared in each call's finally, but they
  // still live in a hub so timer creation stays registry-owned.
  const timers = createTimerHub(clock)

  function get(name: string) {
    return docker.getContainer(name)
  }

  async function remove(name: string, force = true) {
    try {
      await get(name).remove({ force, v: true })
    } catch (error) {
      if (!/no such (container|image)/i.test(String(error))) throw error
    }
  }

  /** Names of every daemon container whose name starts with `prefix` (docker
   * name filters match substrings, so the result is narrowed here). The boot
   * orphan sweep lists by our naming prefixes. */
  async function list(prefix: string): Promise<string[]> {
    const containers = await docker.listContainers({
      all: true,
      filters: JSON.stringify({ name: [prefix] }),
    })
    return containers
      .flatMap((c) => c.Names ?? [])
      .map((name) => name.replace(/^\//, ""))
      .filter((name) => name.startsWith(prefix))
  }

  /** Remove a named volume (the challenge cache volume; best-effort 404). */
  async function removeVolume(name: string): Promise<void> {
    try {
      await docker.getVolume(name).remove()
    } catch (error) {
      if (!/no such/i.test(String(error))) throw error
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
      Env: opts.env,
      HostConfig: {
        AutoRemove: true,
        Binds: [...opts.binds, ...(opts.extraBinds ?? [])],
        NanoCpus: Math.round(opts.limits.cpus * 1e9),
        Memory: opts.limits.memoryMb * 1024 * 1024,
        PidsLimit: opts.limits.pidsLimit,
        // NET_RAW restored after the drop: nmap -sS / scapy raw sockets /
        // naabu / tshark capture need it. Packaged binaries' file caps are
        // stripped in the image, but packages apt-installed at runtime bring
        // their own back (e.g. tcpdump ships cap_net_admin), and execing such
        // a binary fails with EPERM under no-new-privileges — SETFCAP lets
        // the agent strip them again with `setcap -r`. No escalation risk:
        // with an empty bounding set + no-new-privileges, even a mis-set file
        // cap stays unusable (its exec still fails with EPERM).
        CapDrop: ["ALL"],
        CapAdd: ["NET_RAW", "SETFCAP"],
        SecurityOpt: ["no-new-privileges"],
        IpcMode: "none",
        Tmpfs: {
          // exec must be explicit: docker defaults tmpfs mounts to noexec
          // once any option string is given.
          "/tmp": `rw,exec,size=${opts.tmpfsSize}`,
        },
        ...(opts.networkMode ? { NetworkMode: opts.networkMode } : {}),
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

  async function isRunning(name: string): Promise<boolean> {
    try {
      const info = await get(name).inspect()
      return info.State.Running
    } catch {
      return false
    }
  }

  /**
   * Drive a hijacked docker exec stream to completion, demuxing stdout/stderr
   * onto the supplied sinks. Shared by {@link exec} (merged onto one onData
   * sink) and {@link capture} (separate collected buffers). Resolves with the
   * exit code (null on timeout). Abort/timeout destroys the hijacked stream;
   * closing it lets the daemon terminate the exec process — matching the old
   * `docker exec` client-kill semantics.
   */
  async function runHijacked(
    name: string,
    command: string,
    opts: {
      workdir?: string
      signal?: AbortSignal
      timeout?: number
      env?: string[]
      stdoutSink: NodeJS.WritableStream
      stderrSink: NodeJS.WritableStream
    }
  ): Promise<{ exitCode: number | null; timedOut: boolean; aborted: boolean }> {
    // Inherit the container's WorkingDir (set at create time from the
    // container.workspace setting) when no override is given.
    const workdir = opts.workdir
    const execInst = await get(name).exec({
      Cmd: ["bash", "-c", command],
      WorkingDir: workdir,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      Env: opts.env,
    })

    let timedOut = false
    let aborted = opts.signal?.aborted ?? false
    let stream: Readable | undefined
    const destroyStream = () => {
      try {
        stream?.destroy()
      } catch {
        // ignore
      }
    }
    const onAbort = () => {
      aborted = true
      destroyStream()
    }
    if (opts.signal && !aborted) {
      opts.signal.addEventListener("abort", onAbort, { once: true })
    }
    let timer: ClockTimer | undefined
    const ms = execTimeoutMs(opts.timeout)
    if (ms !== undefined) {
      timer = timers.setTimeout(() => {
        timedOut = true
        destroyStream()
      }, ms)
    }

    try {
      stream = await execInst.start({ Detach: false, Tty: false })
      docker.modem.demuxStream(stream, opts.stdoutSink, opts.stderrSink)
      await new Promise<void>((resolve, reject) => {
        if (!stream) return resolve()
        stream.on("end", resolve)
        stream.on("close", resolve)
        stream.on("error", reject)
      })
      const exitCode = await pollExitCode(clock, execInst)
      return { exitCode: timedOut ? null : exitCode, timedOut, aborted }
    } finally {
      if (timer) timers.clear(timer)
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort)
    }
  }

  /**
   * Run a command inside a running container, streaming merged stdout+stderr
   * onto onData. Docker multiplexes by frame in arrival order, so demuxing both
   * streams onto the same sink preserves interleaving.
   */
  async function exec(
    name: string,
    command: string,
    opts: ExecOptions
  ): Promise<{ exitCode: number | null; timedOut: boolean; aborted: boolean }> {
    const sink = onDataSink(opts.onData)
    const { exitCode, timedOut, aborted } = await runHijacked(name, command, {
      workdir: opts.workdir,
      signal: opts.signal,
      timeout: opts.timeout,
      env: opts.env,
      stdoutSink: sink,
      stderrSink: sink,
    })
    return { exitCode, timedOut, aborted }
  }

  /**
   * Run a command inside a running container, capturing stdout and stderr
   * separately. Used by the workspace file backend (read = cat, list = ls,
   * exec = bash — the read/write/edit + bash host tool set) which needs
   * structured output, unlike the streaming bash tool.
   */
  async function capture(
    name: string,
    command: string,
    opts?: {
      workdir?: string
      signal?: AbortSignal
      /** Timeout in seconds (converted to ms in runHijacked). */
      timeout?: number
      /** Per-call env additions ("KEY=value" entries). */
      env?: string[]
      /** In-memory capture cap (bytes). Output beyond it is dropped from
       * `stdout` but counted in `totalBytes`; `truncated` reports the drop. */
      maxCapture?: number
    }
  ): Promise<{
    stdout: Buffer
    stderr: string
    exitCode: number | null
    truncated: boolean
    totalBytes: number
  }> {
    const outChunks: Buffer[] = []
    const errChunks: Buffer[] = []
    const stdoutCollector = collectSink(outChunks, opts?.maxCapture)
    const stderrCollector = collectSink(errChunks, opts?.maxCapture)
    const { exitCode } = await runHijacked(name, command, {
      workdir: opts?.workdir,
      signal: opts?.signal,
      timeout: opts?.timeout,
      env: opts?.env,
      stdoutSink: stdoutCollector.sink,
      stderrSink: stderrCollector.sink,
    })
    return {
      stdout: Buffer.concat(outChunks),
      stderr: Buffer.concat(errChunks).toString("utf8"),
      exitCode,
      truncated:
        opts?.maxCapture !== undefined &&
        stdoutCollector.bytes() > opts.maxCapture,
      totalBytes: stdoutCollector.bytes(),
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

  return {
    create,
    kill,
    remove,
    list,
    removeVolume,
    isRunning,
    exec,
    capture,
    putArchive,
    get,
  }
}
