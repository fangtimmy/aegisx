import { basename, dirname } from "node:path"

import {
  type AgentToolResult,
  defineTool,
} from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"

import { type WorkspaceBackend } from "./backend"
import { applyExactEdit } from "./edit-apply"
import {
  EDIT_DESCRIPTION,
  READ_DESCRIPTION,
  WRITE_DESCRIPTION,
} from "./tool-prompts"

const defaultMaxOutput = 64_000
const defaultReadLimit = 2000
const maxLineLength = 2000
/** Cap on image bytes attached to a read result. Image content is expensive
 * (base64 + vision tokens); above this the model is pointed at the file path
 * instead of being fed the bytes directly. */
const maxImageBytes = 5 * 1024 * 1024

export type WorkspaceToolOptions = {
  /** Max text output per tool call, in bytes. */
  maxOutput?: number
  /** Whether the active model accepts image input (`model.input` includes
   * "image"). When true, `read` attaches image bytes for image files (under
   * {@link maxImageBytes}); when false, it returns a text hint so a
   * text-only model isn't fed bytes it can't use. */
  multimodal?: boolean
}

// ── output helpers ──────────────────────────────────────────────────────────

function formatNumberedLines(
  lines: string[],
  startLine: number,
  maxOutput: number
) {
  const formatted: string[] = []
  let bytes = 0
  let truncated = false
  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index] ?? ""
    if (line.length > maxLineLength) {
      line = `${line.slice(0, maxLineLength)}... (line truncated to ${maxLineLength} chars)`
    }
    const entry = `${startLine + index}: ${line}`
    const nextBytes =
      bytes + Buffer.byteLength(entry) + (formatted.length ? 1 : 0)
    if (nextBytes > maxOutput) {
      truncated = true
      break
    }
    formatted.push(entry)
    bytes = nextBytes
  }
  return {
    text: formatted.join("\n"),
    linesReturned: formatted.length,
    truncated: truncated || formatted.length < lines.length,
    outputBytes: bytes,
  }
}

function detectImageMime(bytes: Uint8Array): string | null {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg"
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png"
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return "image/gif"
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp"
  }
  return null
}

function looksBinary(bytes: Uint8Array) {
  const sample = bytes.subarray(0, Math.min(bytes.length, 8000))
  for (const value of sample) {
    if (value === 0) return true
  }
  return false
}

// ── "did you mean" suggestions for read misses ──────────────────────────────

function commonPrefixLength(a: string, b: string) {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a[i] === b[i]) i += 1
  return i
}

function similarityScore(query: string, candidate: string) {
  if (query === candidate) return 100
  if (candidate.startsWith(query) || query.startsWith(candidate)) return 80
  if (candidate.includes(query) || query.includes(candidate)) return 60
  const prefix = commonPrefixLength(query, candidate)
  if (prefix >= 3) {
    const lengthPenalty = Math.abs(query.length - candidate.length)
    return 40 + prefix * 2 - lengthPenalty
  }
  const shorter = query.length <= candidate.length ? query : candidate
  const longer = query.length <= candidate.length ? candidate : query
  let hits = 0
  for (const ch of shorter) {
    if (longer.includes(ch)) hits += 1
  }
  const ratio = hits / Math.max(longer.length, 1)
  return ratio >= 0.7 ? Math.floor(ratio * 40) : 0
}

async function suggestSimilarPaths(
  backend: WorkspaceBackend,
  filePath: string,
  signal?: AbortSignal
): Promise<string[]> {
  try {
    const parent = dirname(filePath) || "."
    const base = basename(filePath).toLowerCase()
    if (!base) return []
    const entries = await backend.list(parent === "" ? "." : parent, signal)
    return entries
      .map((entry) => ({
        entry,
        score: similarityScore(base, entry.name.toLowerCase()),
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((item) => {
        const dir = parent === "." || parent === "" ? "" : `${parent}/`
        return `${dir}${item.entry.name}${item.entry.directory ? "/" : ""}`
      })
  } catch {
    return []
  }
}

// ── tools ────────────────────────────────────────────────────────────────────

/**
 * read / write / edit backed by a WorkspaceBackend (every operation runs
 * inside the run's container). bash (the workhorse for search included) is
 * NOT defined here — it stays the self-implemented bash tool forwarded over
 * docker exec. Returned ToolDefinitions are dropped into `customTools`,
 * overriding the SDK built-ins of the same name.
 */
export function createWorkspaceTools(
  backend: WorkspaceBackend,
  options: WorkspaceToolOptions = {}
) {
  const maxOutput = options.maxOutput ?? defaultMaxOutput
  const multimodal = options.multimodal === true

  // Per-file write/edit serialization. Scoped to this backend instance (per
  // run) so the lock map is reclaimed when the run's tools are discarded,
  // instead of a process-global map that outlives every run.
  const fileMutationQueues = new Map<string, Promise<void>>()

  async function withFileLock<T>(
    key: string,
    task: () => Promise<T>
  ): Promise<T> {
    const previous = fileMutationQueues.get(key) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate
    })
    const chain = previous.then(() => gate)
    fileMutationQueues.set(key, chain)
    await previous
    try {
      return await task()
    } finally {
      release()
      if (fileMutationQueues.get(key) === chain) fileMutationQueues.delete(key)
    }
  }

  const read = defineTool({
    name: "read",
    label: "Read",
    description: READ_DESCRIPTION,
    parameters: Type.Object({
      filePath: Type.String({
        description:
          "Path to the file to read (workspace-relative, /workspace/x, or /opt/solver/** in the container).",
      }),
      offset: Type.Optional(
        Type.Integer({
          minimum: 1,
          description:
            "Line number to start reading from (1-indexed). Defaults to 1.",
        })
      ),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          description: `Maximum number of lines to read (defaults to ${defaultReadLimit})`,
        })
      ),
    }),
    execute: async (_id, params, signal): Promise<AgentToolResult<unknown>> => {
      let bytes: Uint8Array
      try {
        bytes = await backend.read(params.filePath, signal)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const suggestions = await suggestSimilarPaths(
          backend,
          params.filePath,
          signal
        )
        const hint =
          suggestions.length > 0
            ? `\n\nDid you mean one of these?\n${suggestions.map((item) => `- ${item}`).join("\n")}`
            : ""
        throw new Error(`File not found: ${params.filePath}. ${message}${hint}`)
      }
      const mime = detectImageMime(bytes)
      if (mime) {
        // Attach the image when the active model accepts image input AND it is
        // under the size cap; otherwise fall back to a text hint so a text-only
        // model (or a too-large image) isn't fed bytes it can't use.
        const attach = multimodal && bytes.byteLength <= maxImageBytes
        if (attach) {
          const data = Buffer.from(bytes).toString("base64")
          return {
            content: [
              {
                type: "text" as const,
                text: `Image: ${params.filePath} (${mime}, ${bytes.byteLength} bytes). The image is attached.`,
              },
              { type: "image" as const, data, mimeType: mime },
            ],
            details: {
              filePath: params.filePath,
              kind: "image",
              mimeType: mime,
              bytes: bytes.byteLength,
              attached: true,
            },
          }
        }
        const reason = !multimodal
          ? "the active model does not accept image input"
          : `image exceeds the ${maxImageBytes}-byte attach cap`
        return {
          content: [
            {
              type: "text" as const,
              text: `Image file: ${params.filePath} (${mime}, ${bytes.byteLength} bytes). ${reason}; analyze with bash (file/xxd/strings/zbarimg/steghide) instead.`,
            },
          ],
          details: {
            filePath: params.filePath,
            kind: "image",
            mimeType: mime,
            bytes: bytes.byteLength,
            attached: false,
          },
        }
      }
      if (looksBinary(bytes)) {
        throw new Error(
          `File appears to be binary: ${params.filePath}. Use bash (file/xxd/strings) instead of read.`
        )
      }
      const text = new TextDecoder().decode(bytes)
      const allLines = text.split("\n")
      const offset = params.offset ?? 1
      const limit = params.limit ?? defaultReadLimit
      const slice = allLines.slice(offset - 1, offset - 1 + limit)
      const numbered = formatNumberedLines(slice, offset, maxOutput)
      const notices: string[] = []
      if (
        numbered.truncated ||
        offset - 1 + numbered.linesReturned < allLines.length
      ) {
        const nextOffset = offset + numbered.linesReturned
        notices.push(
          `Showing lines ${offset}-${offset + numbered.linesReturned - 1} of ${allLines.length}. Call again with offset=${nextOffset} to continue.`
        )
      }
      const body = [numbered.text, ...notices].filter(Boolean).join("\n\n")
      return {
        content: [{ type: "text" as const, text: body || "(empty file)" }],
        details: {
          filePath: params.filePath,
          offset,
          lines: numbered.linesReturned,
          totalLines: allLines.length,
          outputBytes: numbered.outputBytes,
          truncated: numbered.truncated,
        },
      }
    },
  })

  const write = defineTool({
    name: "write",
    label: "Write",
    description: WRITE_DESCRIPTION,
    parameters: Type.Object({
      filePath: Type.String({
        description:
          "Path to the file to write (workspace-relative or /workspace/x).",
      }),
      content: Type.String({ description: "Content to write to the file" }),
    }),
    executionMode: "sequential",
    execute: async (_id, params, signal) => {
      const target = backend.resolvePath(params.filePath, true)
      await withFileLock(target, () =>
        backend.write(params.filePath, params.content, signal)
      )
      return {
        content: [{ type: "text" as const, text: `Wrote ${params.filePath}` }],
        details: {
          filePath: params.filePath,
          bytes: Buffer.byteLength(params.content),
        },
      }
    },
  })

  const edit = defineTool({
    name: "edit",
    label: "Edit",
    description: EDIT_DESCRIPTION,
    parameters: Type.Object({
      filePath: Type.String({
        description:
          "Path to the file to modify (workspace-relative or /workspace/x).",
      }),
      oldString: Type.String({
        description:
          "The exact text to replace. Must be unique in the file unless replaceAll is true.",
      }),
      newString: Type.String({
        description:
          "The text to replace it with (must be different from oldString)",
      }),
      replaceAll: Type.Optional(
        Type.Boolean({
          description:
            "Replace all occurrences of oldString (default false). Use for renames.",
        })
      ),
    }),
    executionMode: "sequential",
    execute: async (_id, params, signal) => {
      const target = backend.resolvePath(params.filePath, true)
      return withFileLock(target, async () => {
        const original = new TextDecoder().decode(
          await backend.read(params.filePath, signal)
        )
        const result = applyExactEdit(
          original,
          params.filePath,
          params.oldString,
          params.newString,
          params.replaceAll === true
        )
        await backend.write(params.filePath, result.content, signal)
        return {
          content: [{ type: "text" as const, text: result.diff }],
          details: {
            filePath: params.filePath,
            replacements: result.replacements,
            usedFuzzyMatch: result.usedFuzzyMatch,
          },
        }
      })
    },
  })

  return [read, write, edit]
}
