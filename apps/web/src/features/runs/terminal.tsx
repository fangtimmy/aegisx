import { FitAddon, Ghostty, Terminal } from "ghostty-web"
import wasmUrl from "ghostty-web/ghostty-vt.wasm?url"
import { useEffect, useRef, useState } from "react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Spinner } from "@/components/ui/spinner"

// Load the Ghostty WASM core once for the whole app.
let ghosttyPromise: Promise<Ghostty> | undefined
function getGhostty(): Promise<Ghostty> {
  if (!ghosttyPromise) ghosttyPromise = Ghostty.load(wasmUrl)
  return ghosttyPromise
}

function ptyUrl(runId: string) {
  const proto = window.location.protocol === "https:" ? "wss" : "ws"
  return `${proto}://${window.location.host}/api/runs/${runId}/pty`
}

export type TerminalStatus = "connecting" | "open" | "reconnecting" | "closed"

/**
 * Renders a run's pi TTY via ghostty-web and bridges it over a binary WS to the
 * server PTY. Binary frames = stdin/stdout bytes; a text frame carries the JSON
 * resize control. Typing steers pi mid-run (shared TTY).
 */
export function RunTerminal({
  runId,
  active,
}: {
  runId: string
  /** Whether the terminal tab is visible (controls WS lifecycle). */
  active: boolean
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<TerminalStatus>("connecting")

  useEffect(() => {
    if (!active) return
    const container = containerRef.current
    if (!container) return

    let term: Terminal | undefined
    let fit: FitAddon | undefined
    let ws: WebSocket | undefined
    let resizeObserver: ResizeObserver | undefined
    let disposed = false

    void getGhostty().then((ghostty) => {
      if (disposed) return
      term = new Terminal({
        ghostty,
        fontSize: 13,
        scrollback: 5000,
        theme: {
          background: "#0b0c0f",
          foreground: "#e6e6e6",
          cursor: "#e6e6e6",
        },
      })
      fit = new FitAddon()
      term.loadAddon(fit)
      term.open(container)
      term.onData((data) => {
        if (ws?.readyState === WebSocket.OPEN) {
          // Send as binary so the server treats it as stdin, not a control frame.
          ws.send(new TextEncoder().encode(data))
        }
      })
      term.onResize(({ cols, rows }) => {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "resize", cols, rows }))
        }
      })

      // ghostty-web forces scroll-to-bottom on every write when the viewport is
      // scrolled back (writeInternal runs `viewportY !== 0 && scrollToBottom()`).
      // pi emits continuously, so browsing history is impossible unless we honor
      // the user's position: only re-stick to the bottom when already there.
      // Overriding the instance method works because writeInternal calls
      // `this.scrollToBottom()` and JS resolves own-instance props before proto.
      let stickToBottom = true
      term.onScroll((viewportY) => {
        stickToBottom = viewportY <= 0
      })
      const origScrollToBottom = term.scrollToBottom.bind(term)
      term.scrollToBottom = () => {
        if (stickToBottom) origScrollToBottom()
      }

      const connect = () => {
        setStatus((s) => (s === "open" ? "reconnecting" : "connecting"))
        ws = new WebSocket(ptyUrl(runId))
        ws.binaryType = "arraybuffer"
        ws.onopen = () => {
          setStatus("open")
          // Send the current size once attached. term.open() already fired
          // onResize before the WS existed (lost); fit() won't re-fire it when
          // the size is unchanged, so push the current cols/rows explicitly.
          fit?.fit()
          if (term) {
            ws?.send(
              JSON.stringify({
                type: "resize",
                cols: term.cols,
                rows: term.rows,
              })
            )
          }
        }
        ws.onmessage = (event) => {
          if (event.data instanceof ArrayBuffer) {
            term?.write(new Uint8Array(event.data))
          } else if (typeof event.data === "string") {
            // Server control frames (closed/error). Ignore for rendering.
          }
        }
        ws.onclose = () => {
          if (disposed) return
          setStatus("closed")
        }
        ws.onerror = () => {
          setStatus("closed")
        }
      }
      connect()

      resizeObserver = new ResizeObserver(() => fit?.fit())
      resizeObserver.observe(container)
    })

    return () => {
      disposed = true
      resizeObserver?.disconnect()
      ws?.close()
      term?.dispose()
    }
  }, [runId, active])

  return (
    <div className="relative h-full min-h-0 w-full">
      <div className="h-full min-h-0 w-full" ref={containerRef} />
      {status !== "open" && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          {status === "connecting" || status === "reconnecting" ? (
            <div
              className="pointer-events-auto flex items-center gap-2 rounded-md bg-background/80 px-3 py-2 text-muted-foreground text-sm backdrop-blur"
              role="status"
            >
              <Spinner aria-hidden="true" />
              {status === "connecting" ? "Connecting TTY…" : "Reconnecting…"}
            </div>
          ) : (
            <Alert className="pointer-events-auto m-4 w-auto" variant="warning">
              <AlertDescription>
                TTY disconnected. The run may have stopped — reload to retry.
              </AlertDescription>
            </Alert>
          )}
        </div>
      )}
    </div>
  )
}
