import { posix } from "node:path"
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  defineTool,
  type FindOperations,
} from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"

const workspace = "/workspace"
const decoder = new TextDecoder()

export function containerName(runId: string) {
  return `aegisx-run-${runId}`
}

function runDockerSync(args: string[]) {
  return Bun.spawnSync({
    cmd: ["docker", ...args],
    stdout: "ignore",
    stderr: "ignore",
  }).exitCode
}

export function removeContainer(name: string) {
  runDockerSync(["rm", "--force", name])
}

export function createContainer(
  name: string,
  workspacePath: string,
  image: string
) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/.test(image)) {
    throw new Error("Container image is invalid")
  }
  removeContainer(name)
  const exitCode = runDockerSync([
    "create",
    "--name",
    name,
    "--network",
    "bridge",
    "--ipc",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "128",
    "--memory",
    "512m",
    "--cpus",
    "1",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,noexec,size=64m",
    "--mount",
    `type=bind,src=${workspacePath},dst=${workspace}`,
    "--workdir",
    workspace,
    image,
    "tail",
    "-f",
    "/dev/null",
  ])
  if (exitCode !== 0 || runDockerSync(["start", name]) !== 0) {
    removeContainer(name)
    throw new Error("Container could not be started")
  }
}

function stopContainer(name: string) {
  runDockerSync(["stop", "--time", "0", name])
}

async function dockerExec(
  name: string,
  args: string[],
  options: { input?: string; signal?: AbortSignal; timeout?: number } = {}
) {
  if (options.signal?.aborted) throw new Error("aborted")
  const process = Bun.spawn(
    ["docker", "exec", ...(options.input === undefined ? [] : ["-i"]), ...args],
    {
      stdin: options.input === undefined ? "ignore" : "pipe",
      stdout: "pipe",
      stderr: "pipe",
    }
  )
  if (options.input !== undefined) {
    if (!process.stdin) throw new Error("Container input is unavailable")
    process.stdin.write(options.input)
    process.stdin.end()
  }

  let timedOut = false
  const abort = () => {
    process.kill()
    stopContainer(name)
  }
  const timer =
    options.timeout && options.timeout > 0
      ? setTimeout(() => {
          timedOut = true
          abort()
        }, options.timeout * 1000)
      : undefined
  options.signal?.addEventListener("abort", abort, { once: true })
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).arrayBuffer(),
      new Response(process.stderr).arrayBuffer(),
      process.exited,
    ])
    if (options.signal?.aborted) throw new Error("aborted")
    if (timedOut) throw new Error(`timeout:${options.timeout}`)
    return {
      stdout: Buffer.from(stdout),
      stderr: decoder.decode(stderr).trim(),
      exitCode,
    }
  } finally {
    if (timer) clearTimeout(timer)
    options.signal?.removeEventListener("abort", abort)
  }
}

function containerPath(value: string) {
  const resolved = posix.resolve(workspace, value)
  if (resolved !== workspace && !resolved.startsWith(`${workspace}/`)) {
    throw new Error("Path is outside the run workspace")
  }
  return resolved
}

async function requireExec(name: string, args: string[], input?: string) {
  const result = await dockerExec(name, [name, ...args], { input })
  if (result.exitCode !== 0) throw new Error("Container operation failed")
  return result.stdout
}

export function createContainerTools(name: string) {
  const readFile = (path: string) =>
    requireExec(name, ["cat", containerPath(path)])
  const access = async (path: string) => {
    await requireExec(name, ["test", "-r", containerPath(path)])
  }
  const writeFile = async (path: string, content: string) => {
    await requireExec(
      name,
      ["sh", "-c", 'cat > "$1"', "aegisx-write", containerPath(path)],
      content
    )
  }
  const mkdir = async (path: string) => {
    await requireExec(name, ["mkdir", "-p", containerPath(path)])
  }
  const findOperations: FindOperations = {
    exists: async (path) =>
      (await dockerExec(name, [name, "test", "-e", containerPath(path)]))
        .exitCode === 0,
    glob: async (pattern, cwd, options) => {
      const root = containerPath(cwd)
      const result = await requireExec(name, ["find", root, "-print0"])
      return decoder
        .decode(result)
        .split("\0")
        .filter(Boolean)
        .filter((path) => {
          const relative = posix.relative(root, path)
          return (
            relative &&
            !options.ignore.some((ignored) =>
              posix.matchesGlob(relative, ignored)
            ) &&
            (posix.matchesGlob(relative, pattern) ||
              posix.matchesGlob(posix.basename(relative), pattern))
          )
        })
        .slice(0, options.limit)
    },
  }

  const grep = defineTool({
    name: "grep",
    label: "grep",
    description:
      "Search file contents for a pattern in the container workspace",
    parameters: Type.Object({
      pattern: Type.String(),
      path: Type.Optional(Type.String()),
      glob: Type.Optional(Type.String()),
      ignoreCase: Type.Optional(Type.Boolean()),
      literal: Type.Optional(Type.Boolean()),
      context: Type.Optional(Type.Number({ minimum: 0 })),
      limit: Type.Optional(Type.Number({ minimum: 1 })),
    }),
    execute: async (_id, params, signal) => {
      const root = containerPath(params.path ?? ".")
      const limit = Math.floor(params.limit ?? 100)
      const grepArgs = ["grep", "-H", "-n", params.literal ? "-F" : "-E"]
      if (params.ignoreCase) grepArgs.push("-i")
      if (params.context && params.context > 0) {
        grepArgs.push("-C", String(Math.floor(params.context)))
      }
      grepArgs.push("-e", params.pattern, "{}", "+")
      const findArgs = [name, "find", root, "-type", "f"]
      if (params.glob) findArgs.push("-name", params.glob)
      findArgs.push("-exec", ...grepArgs, ";")
      const result = await dockerExec(name, findArgs, { signal })
      if (result.exitCode !== 0) throw new Error("Container search failed")
      const lines = decoder.decode(result.stdout).split("\n").filter(Boolean)
      const truncated = lines.length > limit
      const output = lines.slice(0, limit).join("\n").slice(0, 200_000)
      return {
        content: [
          {
            type: "text" as const,
            text: output || "No matches found",
          },
        ],
        details: truncated ? { matchLimitReached: limit } : undefined,
      }
    },
  })

  return [
    createReadTool(workspace, {
      autoResizeImages: false,
      operations: { readFile, access, detectImageMimeType: async () => null },
    }),
    createBashTool(workspace, {
      operations: {
        exec: async (command, _cwd, { onData, signal, timeout }) => {
          const result = await dockerExec(
            name,
            ["--workdir", workspace, name, "sh", "-lc", command],
            { signal, timeout }
          )
          onData(result.stdout)
          if (result.stderr) onData(Buffer.from(result.stderr))
          return { exitCode: result.exitCode }
        },
      },
    }),
    createEditTool(workspace, { operations: { readFile, writeFile, access } }),
    createWriteTool(workspace, { operations: { writeFile, mkdir } }),
    grep,
    createFindTool(workspace, { operations: findOperations }),
    createLsTool(workspace, {
      operations: {
        exists: findOperations.exists,
        stat: async (path) => ({
          isDirectory: () =>
            runDockerSync(["exec", name, "test", "-d", containerPath(path)]) ===
            0,
        }),
        readdir: async (path) =>
          decoder
            .decode(await requireExec(name, ["ls", "-1A", containerPath(path)]))
            .split("\n")
            .filter(Boolean),
      },
    }),
  ]
}
