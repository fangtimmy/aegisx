import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createLocalBackend, createWorkspaceTools } from "../src/agent-tools"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 2000
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for state")
    await Bun.sleep(20)
  }
}

test("local bash abort terminates its process group", async () => {
  const root = mkdtempSync(join(tmpdir(), "aegisx-tools-"))
  roots.push(root)
  const bash = createWorkspaceTools(createLocalBackend(root)).find(
    (tool) => tool.name === "bash"
  )
  if (!bash) throw new Error("bash tool is unavailable")

  const controller = new AbortController()
  const executing = bash.execute(
    "bash-test",
    {
      command:
        'sleep 30 & child=$!; printf "%s" "$child" > child.pid; wait "$child"',
    },
    controller.signal
  )
  const pidFile = join(root, "child.pid")
  await waitFor(() => existsSync(pidFile))
  const childPid = Number(readFileSync(pidFile, "utf8"))

  controller.abort()
  await expect(executing).rejects.toThrow("aborted")
  await waitFor(() => {
    try {
      process.kill(childPid, 0)
      return false
    } catch {
      return true
    }
  })
})

test("bash limits visible output and saves the captured log", async () => {
  const root = mkdtempSync(join(tmpdir(), "aegisx-tools-"))
  roots.push(root)
  const bash = createWorkspaceTools(createLocalBackend(root)).find(
    (tool) => tool.name === "bash"
  )
  if (!bash) throw new Error("bash tool is unavailable")

  const result = await bash.execute("bash-output", {
    command: "yes output | head -n 10000",
  })
  const details = result.details as {
    outputBytes: number
    outputPath?: string
    truncated: boolean
  }
  const text = result.content.find((part) => part.type === "text")?.text

  expect(details).toMatchObject({ outputBytes: 70_000, truncated: true })
  expect(details.outputPath).toMatch(/^\.aegisx\/tool-output\/.*\.log$/)
  expect(text).toContain("Output was limited to 12000 bytes")
  expect(text?.length).toBeLessThan(13_000)
  expect(
    readFileSync(join(root, details.outputPath as string), "utf8")
  ).toHaveLength(70_000)
})

test("bash preserves nonzero command failures", async () => {
  const root = mkdtempSync(join(tmpdir(), "aegisx-tools-"))
  roots.push(root)
  const bash = createWorkspaceTools(createLocalBackend(root)).find(
    (tool) => tool.name === "bash"
  )
  if (!bash) throw new Error("bash tool is unavailable")

  await expect(
    bash.execute("bash-failure", { command: "printf failed >&2; exit 3" })
  ).rejects.toThrow("Command exited with status 3")
})
