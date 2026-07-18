import { posix } from "node:path"
import type { WorkspaceBackend } from "./agent-tools"

const workspace = "/workspace"
const decoder = new TextDecoder()
const maxCapturedShellOutput = 1_000_000

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
  image: string,
  limits: { cpus: number; memoryMb: number; pidsLimit: number }
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
    String(limits.pidsLimit),
    "--memory",
    `${limits.memoryMb}m`,
    "--cpus",
    String(limits.cpus),
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
  options: {
    input?: string
    signal?: AbortSignal
    timeout?: number
    maxOutputBytes?: number
  } = {}
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
      captureOutput(process.stdout, options.maxOutputBytes),
      captureOutput(process.stderr, options.maxOutputBytes),
      process.exited,
    ])
    if (options.signal?.aborted) throw new Error("aborted")
    if (timedOut) throw new Error(`timeout:${options.timeout}`)
    return {
      stdout: stdout.content,
      stderr: decoder.decode(stderr.content).trim(),
      exitCode,
      outputBytes: stdout.bytes + stderr.bytes,
      truncated: stdout.truncated || stderr.truncated,
    }
  } finally {
    if (timer) clearTimeout(timer)
    options.signal?.removeEventListener("abort", abort)
  }
}

async function captureOutput(
  stream: ReadableStream<Uint8Array> | null,
  limit?: number
) {
  if (!stream) return { content: Buffer.alloc(0), bytes: 0, truncated: false }
  if (limit === undefined) {
    const content = Buffer.from(await new Response(stream).arrayBuffer())
    return { content, bytes: content.byteLength, truncated: false }
  }
  const chunks: Buffer[] = []
  const reader = stream.getReader()
  let bytes = 0
  let captured = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.byteLength
    const remaining = limit - captured
    if (remaining > 0) {
      const chunk = Buffer.from(value)
      chunks.push(chunk.subarray(0, remaining))
      captured += Math.min(chunk.byteLength, remaining)
    }
  }
  return {
    content: Buffer.concat(chunks),
    bytes,
    truncated: bytes > captured,
  }
}

function containerPath(value: string, cwd = workspace, write = false) {
  const resolved = posix.resolve(cwd, value)
  if (resolved !== workspace && !resolved.startsWith(`${workspace}/`)) {
    throw new Error("Path is outside the run workspace")
  }
  if (write && resolved !== cwd && !resolved.startsWith(`${cwd}/`)) {
    throw new Error("Path is outside the agent workspace")
  }
  return resolved
}

async function requireExec(
  name: string,
  args: string[],
  options: { input?: string; signal?: AbortSignal } = {}
) {
  const result = await dockerExec(name, [name, ...args], options)
  if (result.exitCode !== 0) throw new Error("Container operation failed")
  return result.stdout
}

export function createContainerBackend(
  name: string,
  cwd = workspace
): WorkspaceBackend {
  const resolvePath = (path: string, write = false) =>
    containerPath(path, cwd, write)
  return {
    cwd,
    resolvePath,
    read: (path, signal) =>
      requireExec(name, ["cat", resolvePath(path)], { signal }),
    write: async (path, content, signal) => {
      const target = resolvePath(path, true)
      await requireExec(name, ["mkdir", "-p", posix.dirname(target)], {
        signal,
      })
      await requireExec(
        name,
        ["sh", "-c", 'cat > "$1"', "aegisx-write", target],
        { input: content, signal }
      )
    },
    list: async (path, signal) => {
      const target = resolvePath(path)
      const output = decoder.decode(
        await requireExec(name, ["ls", "-1Ap", target], { signal })
      )
      return output
        .split("\n")
        .filter(Boolean)
        .map((value) => ({
          name: value.endsWith("/") ? value.slice(0, -1) : value,
          path: posix.join(target, value.replace(/\/$/, "")),
          directory: value.endsWith("/"),
        }))
    },
    exec: async (command, options) => {
      const result = await dockerExec(
        name,
        ["--workdir", cwd, name, "sh", "-lc", command],
        { ...options, maxOutputBytes: maxCapturedShellOutput }
      )
      return {
        stdout: decoder.decode(result.stdout),
        stderr: result.stderr,
        exitCode: result.exitCode,
        outputBytes: result.outputBytes,
        truncated: result.truncated,
      }
    },
  }
}
