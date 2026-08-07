import { basename, dirname, relative } from "node:path"

import {
  type AgentToolResult,
  defineTool,
} from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"

import { shellQuote, type WorkspaceBackend } from "./backend"
import { applyExactEdit } from "./edit-apply"
import {
  EDIT_DESCRIPTION,
  FIND_DESCRIPTION,
  GREP_DESCRIPTION,
  LS_DESCRIPTION,
  READ_DESCRIPTION,
  WRITE_DESCRIPTION,
} from "./tool-prompts"

const defaultMaxOutput = 64_000
const defaultReadLimit = 2000
const maxLineLength = 2000
const defaultLsLimit = 500
const defaultGrepLimit = 100
const defaultFindLimit = 1000

export type WorkspaceToolLimits = {
  maxOutput: number
}

// ── output helpers ──────────────────────────────────────────────────────────

function truncateText(value: string, limit: number) {
  const bytes = Buffer.from(value)
  return bytes.byteLength > limit ? bytes.subarray(0, limit).toString() : value
}

function boundedText(value: string, maxOutput: number) {
  const outputBytes = Buffer.byteLength(value)
  const truncated = outputBytes > maxOutput
  return {
    text: truncated
      ? `${truncateText(value, maxOutput)}\n\nOutput truncated. Narrow the request or use pagination.`
      : value,
    outputBytes,
    truncated,
  }
}

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

// ── ripgrep / fd shells (run inside the container) ───────────────────────────

async function requireBinary(
  backend: WorkspaceBackend,
  names: string[],
  label: string,
  signal?: AbortSignal
) {
  const checks = names
    .map((name) => `command -v ${shellQuote(name)}`)
    .join(" || ")
  const result = await backend.exec(checks, { signal, timeout: 5 })
  const found = result.stdout.trim().split("\n").filter(Boolean)[0]
  if (result.exitCode !== 0 || !found) {
    throw new Error(
      `${label} is required but was not found on PATH (tried: ${names.join(", ")}). Install it in the execution environment.`
    )
  }
  return found
}

export type GrepOutputMode = "content" | "files_with_matches" | "count"

async function runRipgrep(
  backend: WorkspaceBackend,
  params: {
    pattern: string
    path?: string
    glob?: string
    ignoreCase?: boolean
    literal?: boolean
    outputMode: GrepOutputMode
    context?: number
    before?: number
    after?: number
    type?: string
    multiline?: boolean
    offset: number
    limit: number
  },
  signal?: AbortSignal
) {
  const rg = await requireBinary(backend, ["rg"], "ripgrep (rg)", signal)
  const root = backend.resolvePath(params.path ?? ".")
  const args = [shellQuote(rg)]
  if (params.outputMode === "files_with_matches") args.push("-l")
  else if (params.outputMode === "count") args.push("-c")
  else {
    args.push("-n", "--no-heading")
    const before = params.before ?? params.context
    const after = params.after ?? params.context
    if (
      params.context !== undefined &&
      params.before === undefined &&
      params.after === undefined &&
      params.context > 0
    ) {
      args.push(`-C${Math.floor(params.context)}`)
    } else {
      if (before !== undefined && before > 0)
        args.push(`-B${Math.floor(before)}`)
      if (after !== undefined && after > 0) args.push(`-A${Math.floor(after)}`)
    }
  }
  if (params.ignoreCase) args.push("-i")
  if (params.literal) args.push("-F")
  if (params.multiline) args.push("-U", "--multiline-dotall")
  if (params.type) args.push("--type", shellQuote(params.type))
  if (params.glob) args.push("-g", shellQuote(params.glob))
  args.push("--", shellQuote(params.pattern), shellQuote(root))
  const start = Math.max(0, params.offset) + 1
  const end = Math.max(0, params.offset) + Math.max(1, params.limit)
  const command = `set -o pipefail; ${args.join(" ")} | sed -n '${start},${end}p'`
  const result = await backend.exec(command, { signal, timeout: 120 })
  if (result.exitCode > 1 && result.exitCode !== 141) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || "rg failed")
  }
  const text = result.stdout.replace(/\n$/, "")
  const lines = text ? text.split("\n") : []
  return {
    text: text || "No matches found",
    count: lines.length && text ? lines.length : 0,
    truncated: lines.length >= params.limit,
  }
}

async function runFd(
  backend: WorkspaceBackend,
  params: { pattern: string; path?: string; limit: number },
  signal?: AbortSignal
) {
  const fd = await requireBinary(backend, ["fd", "fdfind"], "fd", signal)
  const root = backend.resolvePath(params.path ?? ".")
  const command = [
    shellQuote(fd),
    "-g",
    shellQuote(params.pattern),
    "--max-results",
    String(Math.max(1, params.limit)),
    shellQuote(root),
  ].join(" ")
  const result = await backend.exec(command, { signal, timeout: 120 })
  if (result.exitCode !== 0) {
    if (!result.stdout.trim() && !result.stderr.trim()) {
      return { text: "No files found", count: 0, truncated: false }
    }
    if (result.stderr.trim() && !result.stdout.trim()) {
      throw new Error(result.stderr.trim())
    }
  }
  const text = result.stdout.replace(/\n$/, "")
  const lines = text ? text.split("\n") : []
  const relativeLines = lines.map((line) => {
    const abs = line.trim()
    if (!abs) return abs
    try {
      return relative(backend.cwd, abs) || abs
    } catch {
      return abs
    }
  })
  return {
    text: relativeLines.join("\n") || "No files found",
    count: relativeLines.filter(Boolean).length,
    truncated: relativeLines.length >= params.limit,
  }
}

// ── tools ────────────────────────────────────────────────────────────────────

/**
 * read / write / edit / ls / find / grep backed by a WorkspaceBackend (every
 * operation runs inside the run's container). bash is NOT included — it stays
 * the SDK bash tool forwarded over docker exec. Returned ToolDefinitions are
 * dropped into `customTools`, overriding the SDK built-ins of the same name.
 */
export function createWorkspaceTools(
  backend: WorkspaceBackend,
  limits: WorkspaceToolLimits = { maxOutput: defaultMaxOutput }
) {
  const { maxOutput } = limits

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
        return {
          content: [
            {
              type: "text" as const,
              text: `Image file: ${params.filePath} (${mime}, ${bytes.byteLength} bytes). Image bytes are not attached; analyze with workspace tools or bash if needed.`,
            },
          ],
          details: {
            filePath: params.filePath,
            kind: "image",
            mimeType: mime,
            bytes: bytes.byteLength,
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

  const ls = defineTool({
    name: "ls",
    label: "List",
    description: LS_DESCRIPTION,
    parameters: Type.Object({
      path: Type.Optional(
        Type.String({
          description:
            "Directory to list (default: current workspace directory)",
        })
      ),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 10_000,
          description: `Maximum number of entries to return (default: ${defaultLsLimit})`,
        })
      ),
    }),
    execute: async (_id, params, signal) => {
      const entries = await backend.list(params.path ?? ".", signal)
      const limit = params.limit ?? defaultLsLimit
      const sliced = entries.slice(0, limit)
      const lines = sliced.map(
        (entry) => `${entry.name}${entry.directory ? "/" : ""}`
      )
      const truncated = entries.length > sliced.length
      const body = [
        lines.join("\n"),
        truncated
          ? `Listing truncated to ${limit} entries (${entries.length} total).`
          : null,
      ]
        .filter(Boolean)
        .join("\n\n")
      const output = boundedText(body, maxOutput)
      return {
        content: [{ type: "text" as const, text: output.text }],
        details: {
          count: sliced.length,
          total: entries.length,
          outputBytes: output.outputBytes,
          truncated: output.truncated || truncated,
        },
      }
    },
  })

  const find = defineTool({
    name: "find",
    label: "Find",
    description: FIND_DESCRIPTION,
    parameters: Type.Object({
      pattern: Type.String({
        description:
          "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
      }),
      path: Type.Optional(
        Type.String({
          description: "Directory to search in (default: workspace root)",
        })
      ),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 10_000,
          description: `Maximum number of results (default: ${defaultFindLimit})`,
        })
      ),
    }),
    execute: async (_id, params, signal) => {
      const result = await runFd(
        backend,
        {
          pattern: params.pattern,
          path: params.path,
          limit: params.limit ?? defaultFindLimit,
        },
        signal
      )
      const output = boundedText(result.text, maxOutput)
      return {
        content: [{ type: "text" as const, text: output.text }],
        details: {
          count: result.count,
          truncated: result.truncated || output.truncated,
          outputBytes: output.outputBytes,
        },
      }
    },
  })

  const grep = defineTool({
    name: "grep",
    label: "Grep",
    description: GREP_DESCRIPTION,
    parameters: Type.Object({
      pattern: Type.String({
        description:
          "The regular expression pattern to search for in file contents",
      }),
      path: Type.Optional(
        Type.String({
          description:
            "File or directory to search in. Defaults to the workspace root.",
        })
      ),
      glob: Type.Optional(
        Type.String({
          description:
            'Glob pattern to filter files (e.g. "*.js") — maps to rg --glob',
        })
      ),
      outputMode: Type.Optional(
        Type.Union(
          [
            Type.Literal("content"),
            Type.Literal("files_with_matches"),
            Type.Literal("count"),
          ],
          {
            description:
              'Output mode: "content" shows matching lines, "files_with_matches" shows only file paths (default), "count" shows per-file match counts.',
          }
        )
      ),
      ignoreCase: Type.Optional(
        Type.Boolean({ description: "Case-insensitive search (rg -i)" })
      ),
      literal: Type.Optional(
        Type.Boolean({
          description:
            "Treat pattern as a literal string instead of regex (rg -F)",
        })
      ),
      context: Type.Optional(
        Type.Integer({
          minimum: 0,
          description:
            'Lines of context before and after each match (rg -C). Only applies when outputMode is "content".',
        })
      ),
      before: Type.Optional(
        Type.Integer({
          minimum: 0,
          description:
            'Lines before each match (rg -B). Only for outputMode "content".',
        })
      ),
      after: Type.Optional(
        Type.Integer({
          minimum: 0,
          description:
            'Lines after each match (rg -A). Only for outputMode "content".',
        })
      ),
      type: Type.Optional(
        Type.String({
          description: 'File type filter for rg --type (e.g. "py", "js").',
        })
      ),
      multiline: Type.Optional(
        Type.Boolean({
          description:
            "Enable multiline matching (rg -U --multiline-dotall). Default false.",
        })
      ),
      offset: Type.Optional(
        Type.Integer({
          minimum: 0,
          description: "Skip the first N output lines (default 0).",
        })
      ),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 10_000,
          description: `Maximum number of output lines (default ${defaultGrepLimit}).`,
        })
      ),
    }),
    execute: async (_id, params, signal) => {
      const result = await runRipgrep(
        backend,
        {
          pattern: params.pattern,
          path: params.path,
          glob: params.glob,
          ignoreCase: params.ignoreCase,
          literal: params.literal,
          outputMode: params.outputMode ?? "files_with_matches",
          context: params.context,
          before: params.before,
          after: params.after,
          type: params.type,
          multiline: params.multiline,
          offset: params.offset ?? 0,
          limit: params.limit ?? defaultGrepLimit,
        },
        signal
      )
      const output = boundedText(result.text, maxOutput)
      return {
        content: [{ type: "text" as const, text: output.text }],
        details: {
          count: result.count,
          truncated: result.truncated || output.truncated,
          outputBytes: output.outputBytes,
        },
      }
    },
  })

  return [read, write, edit, ls, find, grep]
}
