import { EventEmitter } from "node:events"
import { existsSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import Docker from "dockerode"

/**
 * dockerode-backed container lifecycle for v3 runs. Each run is a single
 * container whose main process is the pi interactive TUI.
 *
 * NOTE on the PTY stream: dockerode's hijacked attach (`container.attach` with
 * `stdin:true`) hangs under Bun — Bun's node:http does not emit the `upgrade`
 * event docker-modem relies on (the same call resolves in ~2ms under Node, and
 * the daemon itself supports hijack via the CLI). Everything else (create /
 * start / wait / kill / resize / remove) is plain HTTP and works under Bun, so
 * only the PTY attach is reimplemented as a raw unix-socket hijack against the
 * Docker Engine `/containers/{id}/attach` endpoint.
 */

export type ContainerLimits = {
  cpus: number
  memoryMb: number
  pidsLimit: number
}

export type LaunchOptions = {
  name: string
  image: string
  /** argv array (exec style, no shell). */
  cmd: string[]
  env: string[]
  workingDir: string
  /** host binds, e.g. ["<abs>:/workspace", "<abs>:/root/.pi/agent"]. */
  binds: string[]
  limits: ContainerLimits
  tmpfsSize: string
}

export type LaunchedContainer = {
  id: string
  /** Raw PTY duplex (Tty:true → stdout/stderr merged, stdin writes reach pi). */
  stream: NodeJS.ReadWriteStream
}

/**
 * Bidirectional PTY stream over a raw unix-socket hijack of the Docker Engine
 * attach endpoint. Emits NodeJS.ReadWriteStream-style events ('data'/'close'/
 * 'end'/'error') so the pty-bridge can use it unchanged.
 */
class HijackPtyStream extends EventEmitter {
  private socket: import("bun").Socket | undefined
  private headerDone = false
  private buf = Buffer.alloc(0)
  private ended = false

  constructor(
    private readonly socketPath: string,
    private readonly container: string
  ) {
    super()
  }

  connect() {
    Bun.connect({
      unix: this.socketPath,
      socket: {
        data: (_socket, data) => this.onRaw(data as Buffer),
        open: (socket) => {
          this.socket = socket
          socket.write(
            `POST /containers/${this.container}/attach?stream=1&stdin=1&stdout=1&stderr=1 HTTP/1.1\r\n` +
              "Host: docker\r\n" +
              "Connection: Upgrade\r\n" +
              "Upgrade: tcp\r\n" +
              "\r\n"
          )
        },
        close: () => this.onClose(),
        error: (_socket, error) => {
          this.emit("error", error)
        },
      },
    })
  }

  private onRaw(data: Buffer) {
    if (!this.headerDone) {
      this.buf = Buffer.concat([this.buf, data])
      const idx = this.buf.indexOf("\r\n\r\n")
      if (idx === -1) return
      const statusLine = this.buf.subarray(0, idx).toString().split("\r\n")[0]
      if (!/\s101\s/.test(statusLine) && !/upgraded/i.test(statusLine)) {
        this.emit(
          "error",
          new Error(`docker attach did not upgrade: ${statusLine}`)
        )
        this.onClose()
        return
      }
      this.headerDone = true
      const rest = this.buf.subarray(idx + 4)
      this.buf = Buffer.alloc(0)
      if (rest.length > 0) this.emit("data", rest)
    } else {
      this.emit("data", data)
    }
  }

  private onClose() {
    if (this.ended) return
    this.ended = true
    this.emit("close")
    this.emit("end")
  }

  write(chunk: Uint8Array | string): boolean {
    this.socket?.write(chunk)
    return true
  }
}

export type ContainerManager = ReturnType<typeof createContainerManager>

export function createContainerManager(options?: { socketPath?: string }) {
  const socketPath =
    options?.socketPath ?? process.env.DOCKER_SOCKET ?? "/var/run/docker.sock"
  const docker = existsSync(socketPath)
    ? new Docker({ socketPath })
    : new Docker()

  /** Raw PTY stream for a running container (Bun-native hijack). */
  function attachPty(container: string) {
    const stream = new HijackPtyStream(socketPath, container)
    stream.connect()
    return stream as unknown as NodeJS.ReadWriteStream
  }

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

  /**
   * Create + start + attach. The PTY stream is attached AFTER start via a raw
   * unix-socket hijack (dockerode's attach(stdin) hangs under Bun).
   */
  async function launch(opts: LaunchOptions): Promise<LaunchedContainer> {
    await remove(opts.name)

    const container = await docker.createContainer({
      name: opts.name,
      Image: opts.image,
      Cmd: opts.cmd,
      Env: opts.env,
      WorkingDir: opts.workingDir,
      Tty: true,
      OpenStdin: true,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      HostConfig: {
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
    const stream = attachPty(container.id)
    return { id: container.id, stream }
  }

  async function resize(name: string, cols: number, rows: number) {
    await get(name).resize({ h: rows, w: cols })
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

  /** Attach to an already-running container (server restart resilience). */
  async function reattach(name: string): Promise<NodeJS.ReadWriteStream> {
    return attachPty(name)
  }

  async function isRunning(name: string): Promise<boolean> {
    try {
      const info = await get(name).inspect()
      return Boolean(info.State?.Running)
    } catch {
      return false
    }
  }

  return {
    launch,
    reattach,
    resize,
    kill,
    wait,
    remove,
    exists,
    isRunning,
    get,
  }
}

/**
 * Discover the pi session id for a run by scanning its pi-agent volume.
 *
 * pi stores sessions under a per-project subdirectory:
 *   sessions/<project-slug>/<timestamp>_<uuid>.jsonl
 * (the slug derives from the working directory, e.g. "/workspace" → "--workspace--").
 * Each run has an exclusive mounted volume, so the newest jsonl wins. The id is
 * the UUID portion of the filename (pi --session does partial-UUID matching).
 */
export function discoverPiSessionId(piAgentDir: string): {
  sessionId: string | null
  sessionFile: string | null
} {
  const sessionsDir = join(piAgentDir, "sessions")
  if (!existsSync(sessionsDir)) return { sessionId: null, sessionFile: null }
  const candidates: Array<{
    file: string
    mtime: number
    uuid: string | null
  }> = []
  try {
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(full)
        } else if (entry.name.endsWith(".jsonl")) {
          const match = entry.name.match(
            /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
          )
          candidates.push({
            file: entry.name,
            mtime: statSync(full).mtimeMs,
            uuid: match ? match[0] : null,
          })
        }
      }
    }
    walk(sessionsDir)
  } catch {
    return { sessionId: null, sessionFile: null }
  }
  if (candidates.length === 0) return { sessionId: null, sessionFile: null }
  candidates.sort((a, b) => b.mtime - a.mtime)
  const newest = candidates[0]
  return {
    sessionId: newest.uuid ?? newest.file.replace(/\.jsonl$/, ""),
    sessionFile: newest.file,
  }
}
