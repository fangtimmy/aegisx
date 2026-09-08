import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { eq } from "drizzle-orm"

import { attachments, challengeFlags, challenges } from "../../src/db/schema"
import {
  loadTemplateMap,
  renderTemplate,
  seedBuiltinTemplates,
} from "../../src/orchestration/prompt-templates"
import { deriveCapabilities } from "../../src/orchestration/types"
import { buildSolverPromptContext, copyAttachments } from "../../src/run/prompt"
import { seedChallenge, seedEvent, setupDb } from "../helpers"

describe("copyAttachments", () => {
  test("materializes into a fresh workspace (creates the attachments dir)", () => {
    const { db, dir, close } = setupDb()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      const storageKey = "evt-1/ch-1/att-1"
      mkdirSync(join(dir, "attachments", "evt-1", "ch-1"), { recursive: true })
      writeFileSync(
        join(dir, "attachments", ...storageKey.split("/")),
        "print(1)"
      )
      db.insert(attachments)
        .values({
          id: "att-1",
          challengeId: "ch-1",
          originalName: "app.py",
          storageKey,
          size: 8,
          sha256: "0".repeat(64),
          remoteId: null,
          createdAt: new Date().toISOString(),
        })
        .run()

      const workspace = join(dir, "events", "evt-1", "ch-1", "workspace")
      const result = copyAttachments(db, dir, "ch-1", workspace)

      expect(result).toEqual([{ name: "app.py", path: "app.py", size: 8 }])
      expect(existsSync(join(workspace, "attachments", "app.py"))).toBe(true)
    } finally {
      close()
    }
  })

  test("attachment-less challenge → empty result, no attachments dir", () => {
    const { db, dir, close } = setupDb()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      const workspace = join(dir, "events", "evt-1", "ch-1", "workspace")
      const result = copyAttachments(db, dir, "ch-1", workspace)
      expect(result).toEqual([])
      expect(existsSync(join(workspace, "attachments"))).toBe(false)
    } finally {
      close()
    }
  })
})

describe("solver prompt: live multi-flag progress", () => {
  test("initial prompt injects the accepted flag list (not the frozen sync-time count)", () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db)
      // The frozen description still claims zero progress.
      seedChallenge(db, {
        id: "ch-1",
        description: "desc\n\n> 本题共有 3 个 flag（当前已正确 0 个）。",
      })
      const ts = new Date().toISOString()
      for (const [flag, status] of [
        ["flag{one}", "accepted"],
        ["flag{two}", "accepted"],
        ["flag{bad}", "rejected"],
      ] as const) {
        db.insert(challengeFlags)
          .values({
            id: `f-${flag}`,
            challengeId: "ch-1",
            flag,
            status,
            source: "agent",
            createdAt: ts,
            updatedAt: ts,
          })
          .run()
      }
      seedBuiltinTemplates(db)

      const challenge = db
        .select()
        .from(challenges)
        .where(eq(challenges.id, "ch-1"))
        .get()!
      const ctx = buildSolverPromptContext(
        {
          challenge,
          remote: undefined,
          challengeAttachments: [],
          environment: {
            type: "container",
            image: "img",
            cpus: 1,
            memoryMb: 512,
            pidsLimit: 64,
          },
          model: {
            provider: "p",
            modelId: "m",
            modelLabel: "M",
            thinkingLevel: "off",
          },
          agentId: "01234567-abcd-abcd-abcd-abcdabcdabcd",
          containerWorkspace: "/workspace",
        },
        db
      )
      const text = renderTemplate(loadTemplateMap(db), "initial", {
        ...ctx,
        capabilities: deriveCapabilities(["submit_flag", "finish_run"]),
      })

      expect(text).toContain("Confirmed flags")
      expect(text).toContain("flag{one}")
      expect(text).toContain("flag{two}")
      expect(text).not.toContain("flag{bad}")
    } finally {
      close()
    }
  })
})
