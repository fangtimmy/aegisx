import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { buildSingleFileTar } from "../workspace/backend"
import { createLocalContainerManager } from "./local-manager"

/**
 * Exercise the local container manager in a plain bun process and write the
 * outcome of every step as JSON. The bun test runner cannot spawn children
 * with pipe stdio (posix_spawn EBADF inside `bun test` under this Bun
 * version), so local-manager.test.ts runs this file as a subprocess with
 * ignored stdio and asserts on the JSON it leaves behind.
 */

type Step = { name: string; pass: boolean; error?: string }

const results: Step[] = []

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    results.push({ name, pass: true })
  } catch (error) {
    results.push({
      name,
      pass: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

const root = mkdtempSync(join(tmpdir(), "aegisx-local-mgr-"))
const workspace = join(root, "host-ws")
const challenges = join(root, "host-challenges")
// Container-internal paths live under the sandbox root too: create() plants
// symlinks at the container paths, which requires a writable parent (the
// real appliance runs as root inside its container).
const containerWorkspace = join(root, "container", "workspace")
const containerChallenges = join(root, "container", "challenges")
const manager = createLocalContainerManager()

async function setup(): Promise<string> {
  await manager.create({
    name: "aegisx-ws-test",
    image: "ignored",
    workingDir: containerWorkspace,
    binds: [`${workspace}:${containerWorkspace}`],
    extraBinds: [`${challenges}:${containerChallenges}:ro`],
    env: ["AEGISX_EVENT_ID=evt-1"],
    limits: { cpus: 1, memoryMb: 512, pidsLimit: 64 },
    tmpfsSize: "1g",
  })
  return "aegisx-ws-test"
}

await step("exec maps container workdir onto the bind host dir", async () => {
  const name = await setup()
  const chunks: Buffer[] = []
  const result = await manager.exec(name, "pwd", {
    workdir: `${containerWorkspace}/agents/ab12cd34`,
    onData: (data) => chunks.push(data),
  })
  assert(result.exitCode === 0, `exit ${result.exitCode}`)
  // bash pwd resolves symlinks (macOS /var → /private/var), so compare
  // against the real path of the bind source.
  assert(
    Buffer.concat(chunks).toString("utf8").trim() ===
      join(realpathSync(workspace), "agents/ab12cd34"),
    "unexpected pwd output"
  )
})

await step("exec merges container env and per-call env", async () => {
  const name = "aegisx-ws-test"
  const chunks: Buffer[] = []
  const result = await manager.exec(
    name,
    'printf %s:%s "$AEGISX_EVENT_ID" "$AEGISX_AGENT_ID"',
    {
      onData: (data) => chunks.push(data),
      env: ["AEGISX_AGENT_ID=agent-9"],
    }
  )
  assert(result.exitCode === 0, `exit ${result.exitCode}`)
  assert(
    Buffer.concat(chunks).toString("utf8") === "evt-1:agent-9",
    "unexpected env output"
  )
})

await step("exec reports non-zero exit codes", async () => {
  const result = await manager.exec("aegisx-ws-test", "exit 3", {
    onData: () => undefined,
  })
  assert(result.exitCode === 3, `exit ${result.exitCode}`)
})

await step("exec timeout kills the process group", async () => {
  const started = Date.now()
  const result = await manager.exec("aegisx-ws-test", "sleep 30", {
    timeout: 1,
    onData: () => undefined,
  })
  assert(result.exitCode === null && result.timedOut, `exit ${result.exitCode}`)
  assert(Date.now() - started < 10_000, "timeout took too long")
})

await step("exec abort signal kills the process group", async () => {
  const controller = new AbortController()
  const pending = manager.exec("aegisx-ws-test", "sleep 30", {
    signal: controller.signal,
    onData: () => undefined,
  })
  setTimeout(() => controller.abort(), 100)
  const result = await pending
  assert(result.aborted && result.exitCode === null, `exit ${result.exitCode}`)
})

await step("capture separates stdout/stderr across mounts", async () => {
  writeFileSync(join(challenges, "note.txt"), "hello")
  const result = await manager.capture(
    "aegisx-ws-test",
    `cat ${containerChallenges}/note.txt; echo oops 1>&2`
  )
  assert(result.exitCode === 0, `exit ${result.exitCode}`)
  assert(result.stdout.toString("utf8") === "hello", "unexpected stdout")
  assert(result.stderr === "oops\n", "unexpected stderr")
})

await step("putArchive extracts into the mapped path", async () => {
  const tar = await buildSingleFileTar("flag.txt", "CTF{local}")
  await manager.putArchive(
    "aegisx-ws-test",
    `${containerWorkspace}/agents/ab12cd34`,
    tar
  )
  assert(
    readFileSync(join(workspace, "agents/ab12cd34/flag.txt"), "utf8") ===
      "CTF{local}",
    "unexpected file content"
  )
})

await step(
  "bash reaches bind targets via container-internal absolute paths",
  async () => {
    writeFileSync(join(challenges, "solve.sh"), "echo solved\n")
    const result = await manager.capture(
      "aegisx-ws-test",
      `bash ${containerChallenges}/solve.sh`
    )
    assert(result.exitCode === 0, `exit ${result.exitCode}`)
    assert(result.stdout.toString("utf8") === "solved\n", "unexpected stdout")
  }
)

await step(
  "kill terminates running execs; remove forgets the workspace",
  async () => {
    const pending = manager.exec("aegisx-ws-test", "sleep 30 && echo done", {
      onData: () => undefined,
    })
    await manager.kill("aegisx-ws-test", "SIGKILL")
    const result = await pending
    assert(result.exitCode === null, `exit ${result.exitCode}`)
    await manager.remove("aegisx-ws-test")
    assert(
      !(await manager.isRunning("aegisx-ws-test")),
      "still running after remove"
    )
    let threw = false
    try {
      await manager.exec("aegisx-ws-test", "true", { onData: () => undefined })
    } catch {
      threw = true
    }
    assert(threw, "exec on removed workspace should throw")
  }
)

await step("isRunning false for never-created", async () => {
  assert(!(await manager.isRunning("nope")), "should not run")
})

rmSync(root, { recursive: true, force: true })
writeFileSync(process.argv[2], JSON.stringify({ results, cwd: process.cwd() }))
process.exit(results.every((r) => r.pass) ? 0 : 1)
