import { describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createDatabase } from "./index"
import { buildLegacyDatabase } from "./migration-fixtures"

describe("legacy execution-dir sweep", () => {
  test("a fresh or already-current boot leaves user runs/ and channel-files/ alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "aegisx-sweep-current-"))
    try {
      // Planted before the first (fresh) boot and still present after the
      // second (recognized, no pending migrations) boot.
      mkdirSync(join(dir, "runs", "mine"), { recursive: true })
      writeFileSync(join(dir, "runs", "mine", "keep.txt"), "keep")
      mkdirSync(join(dir, "channel-files"), { recursive: true })
      writeFileSync(join(dir, "channel-files", "keep.txt"), "keep")

      const first = createDatabase(dir)
      first.sqlite.close()
      first.releaseLock()

      const second = createDatabase(dir)
      second.sqlite.close()
      second.releaseLock()

      expect(readFileSync(join(dir, "runs", "mine", "keep.txt"), "utf8")).toBe(
        "keep"
      )
      expect(existsSync(join(dir, "channel-files", "keep.txt"))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a boot that applies migrations still sweeps the legacy dirs", () => {
    const dir = mkdtempSync(join(tmpdir(), "aegisx-sweep-legacy-"))
    try {
      const sqlite = buildLegacyDatabase(dir, { entries: 13, version: 18 })
      sqlite.close()
      mkdirSync(join(dir, "runs", "runA"), { recursive: true })
      writeFileSync(join(dir, "runs", "runA", "solve.sh"), "echo")
      mkdirSync(join(dir, "channel-files", "1"), { recursive: true })
      writeFileSync(join(dir, "channel-files", "1", "x.txt"), "abc")

      const boot = createDatabase(dir)
      try {
        expect(existsSync(join(dir, "runs"))).toBe(false)
        expect(existsSync(join(dir, "channel-files"))).toBe(false)
      } finally {
        boot.sqlite.close()
        boot.releaseLock()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
