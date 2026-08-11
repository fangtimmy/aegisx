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
 * demuxed stream, per-call abort + timeout). The container's WorkingDir is
 * /workspace, so we never forward a cwd.
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

export const BASH_DESCRIPTION = `Run a shell command inside the Kali container.

Working directory & paths:
- The shell already starts in the workspace (/workspace). read and bash run there. Do NOT prefix commands with \`cd /workspace\` — reference files as workspace-relative or /workspace/<path>.
- The full CTF toolchain is on PATH: python3 (venv with pwntools/angr/impacket/pycryptodome/...), nmap, gdb/pwndbg, ghidra-analyze, fd, rg, ...

Execution:
- Search and file discovery are done here: use \`rg\` for content search, \`fd\` for finding files, \`ls\` for listing. This tool tails output to the LAST ${MAX_LINES} lines / ${MAX_BYTES} bytes, so for search results pipe to \`head\`/\`sed -n\` to keep the FIRST matches (e.g. \`rg -n pattern | head -50\`, \`rg -l pattern | head\`).
- Non-zero exit is returned as an error result (stdout+stderr still attached); the outcome is also reflected in the exit code shown to you. Keep output bounded: pipe through head/grep/awk and sample before dumping large results into context.
- Output is tailed to the last ${MAX_LINES} lines / ${MAX_BYTES} bytes. When truncated, the full output is saved to ${OVERFLOW_DIR_REL}/<id>.log in the workspace and the path is returned — read or grep that file instead of re-running the command.
- Foreground commands must finish promptly: pass \`timeout\` (seconds) for anything non-trivial (default ${DEFAULT_TIMEOUT_SEC}s, hard max ${MAX_TIMEOUT_SEC}s). For genuinely long jobs, start them backgrounded (\`nohup ... > out.log 2>&1 &\`) and poll the log with read/grep — never block a single call for many minutes.
- Avoid interactive commands (REPLs, pagers, \`ssh\`/credential prompts without -o BatchMode=yes); they hang until the timeout.
- Fire independent probes as parallel bash calls when they do not depend on each other.`

export function createBashTool(
  containerWorkspace: string,
  containerName: string,
  manager: ContainerManager
): ToolDefinition {
  const overflowDirAbs = `${containerWorkspace}/${OVERFLOW_DIR_REL}`.replace(
    /\/+/g,
    "/"
  )

  return defineTool({
    name: "bash",
    label: "bash",
    description: BASH_DESCRIPTION,
    executionMode: "parallel",
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to execute." }),
      timeout: Type.Optional(
        Type.Integer({
          minimum: 1,
          description: `Timeout in seconds (default ${DEFAULT_TIMEOUT_SEC}, max ${MAX_TIMEOUT_SEC}).`,
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

      let exitCode: number | null
      let timedOut = false
      try {
        const res = await manager.exec(containerName, params.command, {
          onData: handleData,
          signal,
          timeout,
        })
        exitCode = res.exitCode
        timedOut = res.timedOut
      } finally {
        if (updateTimer) clearTimeout(updateTimer)
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
      if (signal?.aborted) {
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
