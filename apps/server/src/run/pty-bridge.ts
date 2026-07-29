import type { ContainerManager } from "./container-manager"

/** Default scrollback replay window per run (bytes). */
const DEFAULT_RING_BUFFER_BYTES = 256 * 1024

/** Minimal connection surface the WS layer must satisfy. */
export interface PtyConnection {
  send(data: string | ArrayBuffer | Uint8Array): void
  close(code?: number, reason?: string): void
}

type ControlFrame =
  | { type: "resize"; cols: number; rows: number }
  | { type: "stdin" }
  | { type: "ping" }

/** Bounded ring buffer of recent container output, replayed on (re)connect. */
class RingBuffer {
  private chunks: Buffer[] = []
  private bytes = 0
  constructor(private readonly cap: number) {}

  push(chunk: Buffer) {
    this.chunks.push(chunk)
    this.bytes += chunk.byteLength
    while (this.bytes > this.cap && this.chunks.length > 1) {
      const dropped = this.chunks.shift()
      if (dropped) this.bytes -= dropped.byteLength
    }
  }

  snapshot(): Buffer {
    return Buffer.concat(this.chunks)
  }

  clear() {
    this.chunks = []
    this.bytes = 0
  }
}

export type PtyBridge = ReturnType<typeof createPtyBridge>

/**
 * Pipe a container's PTY duplex stream to N browser WS connections with ring
 * buffer replay. The container keeps running while browsers disconnect; closing
 * the WS only stops forwarding to that connection. All connected browsers share
 * the same TTY (typing = steering pi mid-run).
 */
export function createPtyBridge(options: {
  runId: string
  containerName: string
  stream: NodeJS.ReadWriteStream
  manager: ContainerManager
  capBytes?: number
}) {
  const { runId, containerName, stream, manager } = options
  const buffer = new RingBuffer(options.capBytes ?? DEFAULT_RING_BUFFER_BYTES)
  const connections = new Set<PtyConnection>()
  let closed = false

  function broadcast(buf: Buffer) {
    for (const conn of connections) {
      try {
        conn.send(buf)
      } catch {
        connections.delete(conn)
      }
    }
  }

  function broadcastText(text: string) {
    for (const conn of connections) {
      try {
        conn.send(text)
      } catch {
        connections.delete(conn)
      }
    }
  }

  const onData = (chunk: Buffer | string) => {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    buffer.push(data)
    broadcast(data)
  }
  const onClose = () => {
    if (closed) return
    closed = true
    broadcastText(JSON.stringify({ type: "closed" }))
  }
  const onError = (error: unknown) => {
    broadcastText(
      JSON.stringify({
        type: "error",
        message: error instanceof Error ? error.message : "pty stream error",
      })
    )
  }

  stream.on("data", onData)
  stream.once("close", onClose)
  stream.once("end", onClose)
  stream.on("error", onError)

  function addConnection(conn: PtyConnection) {
    // Replay recent output so the renderer rebuilds the screen, then join live.
    const snapshot = buffer.snapshot()
    if (snapshot.byteLength > 0) {
      try {
        conn.send(snapshot)
      } catch {
        /* ignore */
      }
    }
    connections.add(conn)
  }

  function removeConnection(conn: PtyConnection) {
    connections.delete(conn)
  }

  /** A browser frame: binary = stdin bytes; text = JSON control frame. */
  function onMessage(conn: PtyConnection, data: string | ArrayBuffer) {
    if (closed) return
    if (typeof data === "string") {
      handleControl(conn, data)
      return
    }
    // ArrayBuffer: raw stdin bytes.
    const bytes = Buffer.from(data)
    if (bytes.byteLength > 0) stream.write(bytes)
  }

  function handleControl(conn: PtyConnection, text: string) {
    let frame: ControlFrame
    try {
      frame = JSON.parse(text) as ControlFrame
    } catch {
      return // ignore malformed control frames
    }
    switch (frame.type) {
      case "resize":
        void manager
          .resize(containerName, frame.cols, frame.rows)
          .catch(() => undefined)
        break
      case "ping":
        try {
          conn.send(JSON.stringify({ type: "pong" }))
        } catch {
          /* ignore */
        }
        break
    }
  }

  function dispose() {
    closed = true
    try {
      stream.removeListener("data", onData)
      stream.removeListener("close", onClose)
      stream.removeListener("end", onClose)
      stream.removeListener("error", onError)
    } catch {
      /* ignore */
    }
    for (const conn of connections) {
      try {
        conn.close(1001, "run ended")
      } catch {
        /* ignore */
      }
    }
    connections.clear()
    buffer.clear()
  }

  return {
    runId,
    addConnection,
    removeConnection,
    onMessage,
    dispose,
    get connectionCount() {
      return connections.size
    },
  }
}
