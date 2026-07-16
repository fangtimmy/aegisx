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
