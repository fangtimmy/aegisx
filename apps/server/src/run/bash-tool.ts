import { randomUUID } from "node:crypto"

import type { AgentToolResult } from "@earendil-works/pi-agent-core"
import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"

import type { ContainerManager } from "./container/container-manager"
import { buildSingleFileTar, shellQuote } from "./workspace/backend"

/**
 * Self-implemented bash tool (we do NOT use pi's createBashToolDefinition).
 *
 * Why: the SDK factory bakes in its own (terse) description and a no-default
 * timeout schema, neither of which we control. A CTF solver container also
 * needs a container-aware contract: cwd is already /workspace, foreground
 * commands must be bounded, oversized output must land in a workspace file the
 * agent can read/grep (pi writes its overflow to a *host* temp file the
 * containerized agent cannot see), and exit-code null must distinguish
 * timeout/abort from success. All of that lives here.
 *
 * Execution reuses the dockerode-backed `manager.exec` (merged stdout+stderr,
 * demuxed stream, per-call abort + timeout). Every exec runs in the
 * agent's own directory (agents/<id8>) within the challenge workspace —
 * `containerCwd` — while the container WorkingDir stays /workspace.
 */

/** Foreground default. Applied when the agent omits `timeout`. */
const DEFAULT_TIMEOUT_SEC = 600
/** Hard ceiling. Even an explicit larger `timeout` is clamped to this. */
const MAX_TIMEOUT_SEC = 1800
/** Tail window shown to the model: last N lines or N bytes, whichever trips. */
const MAX_LINES = 2000
const MAX_BYTES = 64_000
/** In-memory capture cap. Bounds RAM on pathological commands; output beyond
 *  this is dropped (the tail + total are still reported accurately). */
const CAPTURE_CAP = 16 * 1024 * 1024
/** Workspace-relative dir for oversized outputs (container-readable). */
const OVERFLOW_DIR_REL = ".aegisx/tool-output"

function clampTimeout(requested: number | undefined): number {
  const base =
    typeof requested === "number" && requested > 0
      ? requested
      : DEFAULT_TIMEOUT_SEC
  return Math.min(base, MAX_TIMEOUT_SEC)
}

type Accumulator = {
  chunks: Buffer[]
  retained: number
  total: number
  capped: boolean
}

function makeAccumulator(): Accumulator {
  return { chunks: [], retained: 0, total: 0, capped: false }
}

function pushChunk(acc: Accumulator, data: Buffer): void {
  acc.total += data.byteLength
  if (acc.retained >= CAPTURE_CAP) {
    acc.capped = true
    return
  }
  const room = CAPTURE_CAP - acc.retained
  if (data.byteLength <= room) {
    acc.chunks.push(data)
    acc.retained += data.byteLength
  } else if (room > 0) {
    acc.chunks.push(data.subarray(0, room))
    acc.retained += room
    acc.capped = true
  } else {
    acc.capped = true
  }
}

function concatenated(acc: Accumulator): Buffer {
  return Buffer.concat(acc.chunks, acc.retained)
}

/** Cheap tail (no totals): used for throttled streaming partials. */
function cheapTail(buf: Buffer): string {
  let bytes = buf
  if (buf.byteLength > MAX_BYTES)
    bytes = buf.subarray(buf.byteLength - MAX_BYTES)
  let text = bytes.toString("utf8")
  const lines = text.split("\n")
  if (lines.length > MAX_LINES)
    text = lines.slice(lines.length - MAX_LINES).join("\n")
  return text
}

/** Full tail with totals + overflow write, used for the final result. */
async function finalizeTail(
  acc: Accumulator,
  overflowDirAbs: string,
  manager: ContainerManager,
  containerName: string
): Promise<{
  text: string
  shownBytes: number
  totalBytes: number
  totalLines: number
  shownLines: number
  truncated: boolean
  fullOutputPath?: string
}> {
  const all = concatenated(acc).toString("utf8")
  const totalBytesAll = Buffer.byteLength(all, "utf8")
  const totalLines = all.length === 0 ? 0 : all.split("\n").length

  let working = all
  let bytesTruncated = false
  if (totalBytesAll > MAX_BYTES) {
    const head = Buffer.from(all, "utf8")
    working = head.subarray(head.byteLength - MAX_BYTES).toString("utf8")
    bytesTruncated = true
  }
  const workingLines = working.split("\n")
  let shownLines = workingLines.length
  if (workingLines.length > MAX_LINES) {
    working = workingLines.slice(workingLines.length - MAX_LINES).join("\n")
    shownLines = MAX_LINES
  }

  const truncated =
    acc.capped ||
    bytesTruncated ||
    shownLines < totalLines ||
    acc.total > totalBytesAll

  let fullOutputPath: string | undefined
  if (truncated) {
    const id = randomUUID()
    fullOutputPath = await writeOverflow(
      manager,
      containerName,
      overflowDirAbs,
      id,
      all
    ).catch(() => undefined)
  }

  return {
    text: working,
    shownBytes: Buffer.byteLength(working, "utf8"),
    totalBytes: acc.total,
    totalLines,
    shownLines,
    truncated,
    fullOutputPath,
  }
}

/** Best-effort write of the full captured output to <overflowDirAbs>/<id>.log
 *  via docker putArchive (single-file tar). The path is container-internal
 *  (/workspace/.aegisx/tool-output/<id>.log), so read/grep can reach it. */
async function writeOverflow(
  manager: ContainerManager,
  containerName: string,
  overflowDirAbs: string,
  id: string,
  content: string
): Promise<string> {
  const name = `${id}.log`
  // Ensure the target dir exists inside the container.
  await manager
    .capture(containerName, `mkdir -p ${shellQuote(overflowDirAbs)}`)
    .catch(() => undefined)
  const tar = await buildSingleFileTar(name, content)
  await manager.putArchive(containerName, overflowDirAbs, tar)
  return `${overflowDirAbs}/${name}`
}

function bashDescription(containerCwd: string): string {
  // Solver agents run from their own derived directory (agents/<id8>);
  // the scheduler runs from the workspace root (no write restriction note).
  const solverNote = /\/agents\/[^/]+$/.test(containerCwd)
    ? `- Write only inside your own directory: the workspace root, \`shared/\`, \`attachments/\`, and sibling agents' directories are read-only for you.
`
    : ""
  return `Run a shell command inside the Kali container (stdout and stderr are merged into one output).

## Working directory & paths
- The shell starts in your working directory (\`${containerCwd}\`) — the same directory the write/edit file tools operate on. Reference files as paths relative to it or as absolute paths; do not prefix commands with \`cd\`.
${solverNote}- The full CTF toolchain is on PATH: python3 (venv with pwntools/angr/impacket/pycryptodome/...), nmap, gdb/pwndbg, ghidra-analyze, fd, rg, ...
- Search and file discovery happen here: \`rg\` for content search, \`fd\` for finding files, \`ls\` for listing.

## Output
- Output is tailed to the last ${MAX_LINES} lines / ${MAX_BYTES} bytes (whichever trips first). For search results, pipe to \`head\`/\`sed -n\` to keep the FIRST matches (e.g. \`rg -n pattern | head -50\`, \`rg -l pattern | head\`).
- When output is truncated, the full output is saved to ${OVERFLOW_DIR_REL}/<id>.log in the workspace and the path is returned — read or grep that file instead of re-running the command.
- A non-zero exit code is reported in the result (the output is still attached). Keep output bounded: pipe through head/grep/awk and sample before dumping large results into context.

## Timing
- Foreground commands must finish promptly: pass \`timeout\` (seconds) for anything non-trivial (default ${DEFAULT_TIMEOUT_SEC}s, hard max ${MAX_TIMEOUT_SEC}s). For genuinely long jobs, start them backgrounded (\`nohup ... > out.log 2>&1 &\`) and poll the log with read/grep — never block a single call for many minutes.
- Avoid interactive commands (REPLs, pagers, \`ssh\`/credential prompts without -o BatchMode=yes); they hang until the timeout.
- Fire independent probes as parallel bash calls when they do not depend on each other.

## Python scripts
For multi-step logic (especially the \`aegisx\` management SDK), write ONE script with a heredoc instead of chaining \`python3 -c\` one-liners (quote hell):

    python3 - <<'PY'
    import aegisx
    snap = aegisx.snapshot()
    ...
    PY

Single quotes around PY stop shell interpolation of $/backticks. The container has PYTHONPATH preset so \`import aegisx\` just works. A script failure prints a traceback — read it, fix the script, re-run (do not switch to a different mechanism).`
}

export function createBashTool(
  /** Container-internal working directory for every exec (the agent's own
   * dir, or the workspace root for the scheduler). */
  containerCwd: string,
  containerName: string,
  manager: ContainerManager,
  /** Per-call exec env ("KEY=value" entries) — per-agent identity for the
   * container-side aegisx SDK (AEGISX_AGENT_ID) on shared solver
   * containers. */
  execEnv?: string[]
): ToolDefinition {
  const overflowDirAbs =
    `${containerCwd.replace(/\/+$/, "")}/${OVERFLOW_DIR_REL}`.replace(
      /\/{2,}/g,
      "/"
    )

  return defineTool({
    name: "bash",
    label: "bash",
    description: bashDescription(containerCwd),
    executionMode: "parallel",
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to execute." }),
      timeout: Type.Optional(
        Type.Integer({
          minimum: 1,
          description: `Timeout in seconds (default ${DEFAULT_TIMEOUT_SEC}, max ${MAX_TIMEOUT_SEC}). Pass this for long jobs — a shell-level \`timeout\` wrapper does not extend the tool's limit.`,
        })
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      const timeout = clampTimeout(params.timeout)
      const acc = makeAccumulator()
      let updateTimer: ReturnType<typeof setTimeout> | undefined
      let dirty = false

      const flush = () => {
        if (!dirty || !onUpdate) return
        dirty = false
        const text = cheapTail(concatenated(acc))
        onUpdate({
          content: [{ type: "text", text }],
          details: { streaming: true },
        })
      }
      const schedule = () => {
        dirty = true
        if (updateTimer) return
        updateTimer = setTimeout(() => {
          updateTimer = undefined
          flush()
        }, 120)
      }

      const handleData = (data: Buffer): void => {
        pushChunk(acc, data)
        schedule()
      }

      let exitCode: number | null = null
      let timedOut = false
      let aborted = false
      if (signal?.aborted) {
        aborted = true
      } else {
        try {
          const res = await manager.exec(containerName, params.command, {
            onData: handleData,
            signal,
            timeout,
            env: execEnv,
            workdir: containerCwd,
          })
          exitCode = res.exitCode
          timedOut = res.timedOut
          aborted = res.aborted
        } finally {
          if (updateTimer) clearTimeout(updateTimer)
        }
      }

      const tail = await finalizeTail(
        acc,
        overflowDirAbs,
        manager,
        containerName
      )
      const truncated = tail.truncated

      let text = tail.text
      if (truncated && tail.fullOutputPath) {
        text += `\n\n[Output truncated to last ${tail.shownLines} lines / ${tail.shownBytes} bytes of ${tail.totalBytes} bytes total. Full output saved to: ${tail.fullOutputPath}. Read or grep that file instead of re-running.]`
      } else if (truncated) {
        text += `\n\n[Output truncated to last ${tail.shownLines} lines / ${tail.shownBytes} bytes of ${tail.totalBytes} bytes total.]`
      }

      // Return a result instead of throwing. The SDK's createErrorToolResult
      // discards `details` (sets {}) on throw, which would lose exitCode /
      // truncated / fullOutputPath for the frontend and force the pipeline to
      // classify the terminal reason by parsing prose. Returning structured
      // details keeps them intact into the persisted toolResult; the failure is
      // still surfaced to the model via the content text, and the pipeline
      // reads `details.terminal` to mark the tool result as an error.
      let terminal: "timed_out" | "cancelled" | "failed" | undefined
      if (aborted) {
        text += "\n\nCommand aborted"
        terminal = "cancelled"
      } else if (timedOut || exitCode === null) {
        text += `\n\nCommand timed out after ${timeout} seconds`
        terminal = "timed_out"
      } else if (exitCode !== 0) {
        text += `\n\nCommand exited with code ${exitCode}`
        terminal = "failed"
      }

      const details = {
        exitCode,
        timedOut,
        outputBytes: tail.totalBytes,
        truncated,
        fullOutputPath: tail.fullOutputPath,
        terminal,
      }

      const result: AgentToolResult<typeof details> = {
        content: [{ type: "text", text }],
        details,
      }
      return result
    },
  })
}
