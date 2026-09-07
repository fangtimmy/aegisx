import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { parseJson } from "../../lib/guards"
import { localContainerWorkspace } from "./local-manager"

type ProbeStep = { name: string; pass: boolean; error?: string }

function parseProbeResults(raw: string): ProbeStep[] {
  const { results } = parseJson<{ results: ProbeStep[] }>(raw)
  if (!Array.isArray(results)) {
    throw new Error("probe output has an unexpected shape")
  }
  return results
}

/**
 * The bun test runner cannot spawn children with pipe stdio (posix_spawn
 * EBADF inside `bun test` under this Bun version), so the real exercise runs
 * in local-manager.probe.ts as a plain bun subprocess; this file drives it
 * and asserts on the recorded per-step outcomes.
 */
describe("local container manager", () => {
  test("per-workspace container roots are unique across workspaces", () => {
    const challenge = localContainerWorkspace(
      "4f2a1b3c-9d8e-7f6a-5b4c-3d2e1f0a9b8c"
    )
    const scheduler = localContainerWorkspace(
      "orch:aa11bb22-cc33-dd44-ee55-ff6677889900"
    )
    expect(challenge).toBe("/opt/aegisx-ws/4f2a1b3c")
    expect(scheduler).toBe("/opt/aegisx-ws/orch-aa11bb22")
    expect(challenge).not.toBe(scheduler)
  })

  test("probe suite passes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aegisx-local-mgr-out-"))
    try {
      const outFile = join(dir, "results.json")
      const proc = Bun.spawn(
        ["bun", join(import.meta.dir, "local-manager.probe.ts"), outFile],
        { stdin: "ignore", stdout: "ignore", stderr: "ignore" }
      )
      await proc.exited
      const results = parseProbeResults(readFileSync(outFile, "utf8"))
      expect(results.length).toBeGreaterThan(0)
      for (const result of results) {
        expect(
          result.pass,
          `${result.name}${result.error ? `: ${result.error}` : ""}`
        ).toBe(true)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
