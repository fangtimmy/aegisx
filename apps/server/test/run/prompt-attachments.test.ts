import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { attachments } from "../../src/db/schema"
import { copyAttachments } from "../../src/run/prompt"
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
