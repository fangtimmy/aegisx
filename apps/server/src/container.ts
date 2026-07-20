import { posix } from "node:path"
import type { WorkspaceBackend } from "./agents/tools"

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

async function runDocker(args: string[], timeoutMs = 30_000) {
  const process = Bun.spawn(["docker", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    process.kill()
  }, timeoutMs)
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      process.stdout
        ? new Response(process.stdout).text()
        : Promise.resolve(""),
      process.stderr
        ? new Response(process.stderr).text()
        : Promise.resolve(""),
      process.exited,
    ])
    if (timedOut) throw new Error("Docker command timed out")
    return { stdout, stderr, exitCode }
  } finally {
    clearTimeout(timer)
  }
}

export function removeContainer(name: string) {
  runDockerSync(["rm", "--force", name])
}

export async function removeContainerAsync(name: string) {
  const result = await runDocker(["rm", "--force", name])
  if (
    result.exitCode !== 0 &&
    !/no such container|is not a container/i.test(result.stderr)
  ) {
    throw new Error("Container could not be removed")
  }
}

export async function containerRunningAsync(name: string) {
  try {
    const result = await runDocker([
      "inspect",
      "--format",
      "{{.State.Running}}",
      name,
    ])
    return result.exitCode === 0 && result.stdout.trim() === "true"
  } catch {
    return false
  }
}

function containerCreateArgs(
  name: string,
  workspacePath: string,
  image: string,
  limits: { cpus: number; memoryMb: number; pidsLimit: number }
) {
  return [
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
  ]
}

export async function createContainerAsync(
  name: string,
  workspacePath: string,
  image: string,
  limits: { cpus: number; memoryMb: number; pidsLimit: number }
) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/.test(image)) {
    throw new Error("Container image is invalid")
  }
  await removeContainerAsync(name)
  const created = await runDocker(
    containerCreateArgs(name, workspacePath, image, limits)
  )
  if (created.exitCode !== 0) {
    await removeContainerAsync(name)
    throw new Error("Container could not be created")
  }
  const started = await runDocker(["start", name])
  if (started.exitCode !== 0) {
    await removeContainerAsync(name)
    throw new Error("Container could not be started")
  }
}

async function dockerExec(
  args: string[],
  options: {
    input?: string
    signal?: AbortSignal
    timeout?: number
    maxOutputBytes?: number
    onFatal?: () => void
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
  }
  const timer =
    options.timeout && options.timeout > 0
      ? setTimeout(() => {
          timedOut = true
          abort()
          options.onFatal?.()
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

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`
}

async function requireExec(
  name: string,
  args: string[],
  options: {
    input?: string
    signal?: AbortSignal
    onFatal?: () => void
  } = {}
) {
  const result = await dockerExec([name, ...args], options)
  if (result.exitCode !== 0) {
    if (!(await containerRunningAsync(name))) options.onFatal?.()
    throw new Error("Container operation failed")
  }
  return result.stdout
}

export function createContainerBackend(
  name: string,
  cwd = workspace,
  onFatal?: () => void
): WorkspaceBackend {
  const resolvePath = (path: string, write = false) =>
    containerPath(path, cwd, write)
  return {
    cwd,
    resolvePath,
    read: (path, signal) =>
      requireExec(name, ["cat", resolvePath(path)], { signal, onFatal }),
    write: async (path, content, signal) => {
      const target = resolvePath(path, true)
      await requireExec(name, ["mkdir", "-p", posix.dirname(target)], {
        signal,
        onFatal,
      })
      await requireExec(
        name,
        ["sh", "-c", 'cat > "$1"', "aegisx-write", target],
        { input: content, signal, onFatal }
      )
    },
    list: async (path, signal) => {
      const target = resolvePath(path)
      const output = decoder.decode(
        await requireExec(name, ["ls", "-1Ap", target], { signal, onFatal })
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
      const boundedCommand =
        options.timeout && options.timeout > 0
          ? `timeout -k 2s ${options.timeout}s sh -lc ${shellQuote(command)}`
          : command
      const result = await dockerExec(
        ["--workdir", cwd, name, "sh", "-lc", boundedCommand],
        {
          ...options,
          maxOutputBytes: maxCapturedShellOutput,
          ...(options.timeout
            ? { timeout: options.timeout + 5, onFatal }
            : { onFatal }),
        }
      )
      if (result.exitCode !== 0 && !(await containerRunningAsync(name))) {
        onFatal?.()
      }
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
