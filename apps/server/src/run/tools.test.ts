import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createLocalBackend } from "../agents/tools"
import { createRunTools } from "./tools"
import type { RunAggregate } from "./types"

describe("createRunTools", () => {
  test("main gets finish/spawn; child only workspace tools", () => {
    const dir = mkdtempSync(join(tmpdir(), "aegisx-tools-"))
    try {
      const backend = createLocalBackend(dir)
      const base = {
        runId: "r",
        agentId: "main",
        challengeId: "c",
        challenge: {
          platformIntegrated: false,
          targetCapable: false,
        },
        backend,
        getRun: (): RunAggregate | null => null,
        requestFinish: () => undefined,
        getAgent: () => undefined,
        messagesForAgent: () => [],
        spawnChild: async () => {
          throw new Error("no")
        },
      }
      const mainTools = createRunTools({ ...base, isMain: true })
      const names = mainTools.map((t) => t.name)
      expect(names).toContain("finish_run")
      expect(names).toContain("spawn_agent")
      expect(names).toContain("bash")

      const childTools = createRunTools({
        ...base,
        agentId: "child",
        isMain: false,
      })
      const childNames = childTools.map((t) => t.name)
      expect(childNames).not.toContain("finish_run")
      expect(childNames).not.toContain("spawn_agent")
      expect(childNames).toContain("bash")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
