import { describe, expect, test } from "bun:test"
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { CONFIG_DOCUMENT_VERSION } from "@aegisx/shared"

import { createConfigStore } from "./config-store"

function tempDir() {
  return mkdtempSync(join(tmpdir(), "aegisx-config-store-"))
}

function seedDocument(dir: string, providers: unknown) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({
      version: CONFIG_DOCUMENT_VERSION,
      settings: {},
      providers,
      updatedAt: "2025-01-01T00:00:00.000Z",
    })
  )
}

describe("config store providers normalization", () => {
  test("zero providers stay zero across a reload", () => {
    const dir = tempDir()
    try {
      const first = createConfigStore(dir)
      first.updateProviders([])
      expect(first.getProviders()).toEqual([])

      const second = createConfigStore(dir)
      expect(second.getProviders()).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("an explicit empty providers array on disk loads as empty", () => {
    const dir = tempDir()
    try {
      seedDocument(dir, [])
      const store = createConfigStore(dir)
      expect(store.getProviders()).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a non-array providers field still falls back to the seeds", () => {
    const dir = tempDir()
    try {
      seedDocument(dir, "garbage")
      const store = createConfigStore(dir)
      expect(store.getProviders()).toHaveLength(1)
      expect(store.getProviders()[0]?.id).toBe("default-provider")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("corrupt JSON is backed up and defaults rewritten", () => {
    const dir = tempDir()
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, "config.json"), "{ not json")
      const store = createConfigStore(dir)
      expect(store.getProviders()).toHaveLength(1)
      expect(store.getProviders()[0]?.id).toBe("default-provider")
      const backups = readdirSync(dir).filter((f) =>
        f.startsWith("config.json.bak.")
      )
      expect(backups).toHaveLength(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
