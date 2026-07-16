import { spawn } from "node:child_process"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import {
  dirname,
  isAbsolute,
  join,
  matchesGlob,
  relative,
  resolve,
} from "node:path"
import type { AgentTool } from "@earendil-works/pi-agent-core"
import { type TSchema, Type } from "typebox"

const maxOutput = 200_000

export function defineAgentTool<T extends TSchema>(tool: AgentTool<T>) {
  return tool
}

export type WorkspaceEntry = {
  name: string
  path: string
  directory: boolean
}

export type WorkspaceBackend = {
  cwd: string
  resolvePath(path: string, write?: boolean): string
  read(path: string, signal?: AbortSignal): Promise<Uint8Array>
  write(path: string, content: string, signal?: AbortSignal): Promise<void>
  list(path: string, signal?: AbortSignal): Promise<WorkspaceEntry[]>
  exec(
    command: string,
    options: { signal?: AbortSignal; timeout?: number }
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>
}

function inside(root: string, path: string) {
  const value = relative(root, path)
  return value === "" || (!value.startsWith("..") && !isAbsolute(value))
}

export function createLocalBackend(root: string, cwd = root): WorkspaceBackend {
  const runRoot = resolve(root)
  const workingDirectory = resolve(cwd)
  const resolvePath = (path: string, write = false) => {
    const value = resolve(workingDirectory, path)
    if (
      !inside(runRoot, value) ||
      (write && !inside(workingDirectory, value))
    ) {
      throw new Error("Path is outside the allowed workspace")
    }
    return value
  }
  return {
    cwd: workingDirectory,
    resolvePath,
    read: (path) => readFile(resolvePath(path)),
    write: async (path, content) => {
      const target = resolvePath(path, true)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, content)
    },
    list: async (path) => {
      const target = resolvePath(path)
      return (await readdir(target, { withFileTypes: true })).map((entry) => ({
        name: entry.name,
        path: join(target, entry.name),
        directory: entry.isDirectory(),
      }))
    },
    exec: (command, options) =>
      new Promise((resolvePromise, reject) => {
        const child = spawn("/bin/sh", ["-lc", command], {
          cwd: workingDirectory,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        })
        let stdout = ""
        let stderr = ""
        let timedOut = false
        child.stdout.on("data", (chunk) => {
          if (stdout.length < maxOutput) stdout += String(chunk)
        })
        child.stderr.on("data", (chunk) => {
          if (stderr.length < maxOutput) stderr += String(chunk)
        })
        const stop = () => {
          if (child.pid) {
            try {
              process.kill(-child.pid, "SIGTERM")
            } catch {
              child.kill()
            }
          }
        }
        const timer = options.timeout
          ? setTimeout(() => {
              timedOut = true
              stop()
            }, options.timeout * 1000)
          : undefined
        options.signal?.addEventListener("abort", stop, { once: true })
        child.once("error", reject)
        child.once("close", (code) => {
          if (timer) clearTimeout(timer)
          options.signal?.removeEventListener("abort", stop)
          if (options.signal?.aborted) return reject(new Error("aborted"))
          if (timedOut) return reject(new Error("Command timed out"))
          resolvePromise({
            stdout: stdout.slice(0, maxOutput),
            stderr: stderr.slice(0, maxOutput),
            exitCode: code ?? 1,
          })
        })
      }),
  }
}

async function walk(
  backend: WorkspaceBackend,
  path: string,
  signal?: AbortSignal,
  limit = 10_000
) {
  const result: WorkspaceEntry[] = []
  const queue = [backend.resolvePath(path)]
  while (queue.length && result.length < limit) {
    if (signal?.aborted) throw new Error("aborted")
    const current = queue.shift() as string
    for (const entry of await backend.list(current, signal)) {
      result.push(entry)
      if (entry.directory) queue.push(entry.path)
      if (result.length >= limit) break
    }
  }
  return result
}

export function createWorkspaceTools(backend: WorkspaceBackend): AgentTool[] {
  const read = defineAgentTool({
    name: "read",
    label: "Read",
    description: "Read a text file in the run workspace",
    parameters: Type.Object({
      path: Type.String(),
      offset: Type.Optional(Type.Integer({ minimum: 1 })),
      limit: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
    execute: async (_id, params, signal) => {
      const text = new TextDecoder().decode(
        await backend.read(params.path, signal)
      )
      const offset = params.offset ?? 1
      const lines = text
        .split("\n")
        .slice(offset - 1, params.limit ? offset - 1 + params.limit : undefined)
      return {
        content: [{ type: "text", text: lines.join("\n").slice(0, maxOutput) }],
        details: { path: params.path, offset, lines: lines.length },
      }
    },
  })
  const bash = defineAgentTool({
    name: "bash",
    label: "Bash",
    description: "Run a shell command in the agent workspace",
    parameters: Type.Object({
      command: Type.String(),
      timeout: Type.Optional(Type.Number({ minimum: 0.1, maximum: 3600 })),
    }),
    execute: async (_id, params, signal) => {
      const result = await backend.exec(params.command, {
        signal,
        timeout: params.timeout,
      })
      const text = [result.stdout, result.stderr].filter(Boolean).join("\n")
      if (result.exitCode !== 0) {
        throw new Error(text || `Command exited with status ${result.exitCode}`)
      }
      return {
        content: [{ type: "text", text: text.slice(0, maxOutput) }],
        details: { exitCode: result.exitCode },
      }
    },
  })
  const write = defineAgentTool({
    name: "write",
    label: "Write",
    description: "Create or overwrite a text file in the agent workspace",
    parameters: Type.Object({ path: Type.String(), content: Type.String() }),
    execute: async (_id, params, signal) => {
      await backend.write(params.path, params.content, signal)
      return {
        content: [{ type: "text", text: `Wrote ${params.path}` }],
        details: {
          path: params.path,
          bytes: Buffer.byteLength(params.content),
        },
      }
    },
  })
  const edit = defineAgentTool({
    name: "edit",
    label: "Edit",
    description: "Replace exact text in a file in the agent workspace",
    parameters: Type.Object({
      path: Type.String(),
      edits: Type.Array(
        Type.Object({ oldText: Type.String(), newText: Type.String() }),
        { minItems: 1 }
      ),
    }),
    executionMode: "sequential",
    execute: async (_id, params, signal) => {
      let text = new TextDecoder().decode(
        await backend.read(params.path, signal)
      )
      for (const change of params.edits) {
        if (!text.includes(change.oldText)) {
          throw new Error("Edit target was not found")
        }
        text = text.replace(change.oldText, change.newText)
      }
      await backend.write(params.path, text, signal)
      return {
        content: [{ type: "text", text: `Edited ${params.path}` }],
        details: { path: params.path, edits: params.edits.length },
      }
    },
  })
  const ls = defineAgentTool({
    name: "ls",
    label: "List",
    description: "List files in a run workspace directory",
    parameters: Type.Object({ path: Type.Optional(Type.String()) }),
    execute: async (_id, params, signal) => {
      const entries = await backend.list(params.path ?? ".", signal)
      return {
        content: [
          {
            type: "text",
            text: entries
              .map((entry) => `${entry.name}${entry.directory ? "/" : ""}`)
              .join("\n")
              .slice(0, maxOutput),
          },
        ],
        details: { count: entries.length },
      }
    },
  })
  const find = defineAgentTool({
    name: "find",
    label: "Find",
    description: "Find files by glob in the run workspace",
    parameters: Type.Object({
      pattern: Type.String(),
      path: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000 })),
    }),
    execute: async (_id, params, signal) => {
      const root = backend.resolvePath(params.path ?? ".")
      const entries = (await walk(backend, root, signal)).filter((entry) => {
        const name = relative(root, entry.path).replaceAll("\\", "/")
        return (
          matchesGlob(name, params.pattern) ||
          matchesGlob(entry.name, params.pattern)
        )
      })
      const values = entries.slice(0, params.limit ?? 1000)
      return {
        content: [
          {
            type: "text",
            text: values
              .map((entry) => relative(backend.cwd, entry.path))
              .join("\n")
              .slice(0, maxOutput),
          },
        ],
        details: { count: values.length },
      }
    },
  })
  const grep = defineAgentTool({
    name: "grep",
    label: "Grep",
    description: "Search text files in the run workspace",
    parameters: Type.Object({
      pattern: Type.String(),
      path: Type.Optional(Type.String()),
      glob: Type.Optional(Type.String()),
      ignoreCase: Type.Optional(Type.Boolean()),
      literal: Type.Optional(Type.Boolean()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000 })),
    }),
    execute: async (_id, params, signal) => {
      const root = backend.resolvePath(params.path ?? ".")
      const flags = params.ignoreCase ? "i" : ""
      const pattern = params.literal
        ? null
        : (() => {
            try {
              return new RegExp(params.pattern, flags)
            } catch {
              throw new Error("Invalid regular expression")
            }
          })()
      const needle = params.ignoreCase
        ? params.pattern.toLowerCase()
        : params.pattern
      const matches: string[] = []
      for (const entry of await walk(backend, root, signal)) {
        if (
          entry.directory ||
          (params.glob && !matchesGlob(entry.name, params.glob))
        )
          continue
        let text: string
        try {
          text = new TextDecoder().decode(
            await backend.read(entry.path, signal)
          )
        } catch {
          continue
        }
        for (const [index, line] of text.split("\n").entries()) {
          const value = params.ignoreCase ? line.toLowerCase() : line
          if (pattern ? pattern.test(line) : value.includes(needle)) {
            matches.push(
              `${relative(backend.cwd, entry.path)}:${index + 1}:${line}`
            )
          }
          if (matches.length >= (params.limit ?? 100)) break
        }
        if (matches.length >= (params.limit ?? 100)) break
      }
      return {
        content: [
          {
            type: "text",
            text: (matches.join("\n") || "No matches found").slice(
              0,
              maxOutput
            ),
          },
        ],
        details: { count: matches.length },
      }
    },
  })
  return [read, bash, edit, write, grep, find, ls]
}
