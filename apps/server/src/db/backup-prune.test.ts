import { describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { pruneBackups } from "./index"

describe("migration backup pruning", () => {
  test("keeps only the newest 3 backups", () => {
    const dir = mkdtempSync(join(tmpdir(), "aegisx-prune-"))
    try {
      for (const stamp of [
        "2026-08-14T00-00-00-000Z",
        "2026-08-15T00-00-00-000Z",
        "2026-08-16T00-00-00-000Z",
        "2026-08-17T00-00-00-000Z",
        "2026-08-18T00-00-00-000Z",
      ]) {
        writeFileSync(join(dir, `aegisx.sqlite.bak-${stamp}`), "")
      }
      pruneBackups(dir)
      const remaining = readdirSync(dir).sort()
      expect(remaining).toEqual([
        "aegisx.sqlite.bak-2026-08-16T00-00-00-000Z",
        "aegisx.sqlite.bak-2026-08-17T00-00-00-000Z",
        "aegisx.sqlite.bak-2026-08-18T00-00-00-000Z",
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("non-backup files and fewer-than-keep backups are untouched", () => {
    const dir = mkdtempSync(join(tmpdir(), "aegisx-prune-"))
    try {
      writeFileSync(join(dir, "aegisx.sqlite"), "")
      writeFileSync(join(dir, "aegisx.sqlite.bak-2026-08-18T00-00-00-000Z"), "")
      pruneBackups(dir)
      expect(readdirSync(dir).sort()).toEqual([
        "aegisx.sqlite",
        "aegisx.sqlite.bak-2026-08-18T00-00-00-000Z",
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
