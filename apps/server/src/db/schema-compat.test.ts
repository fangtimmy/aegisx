import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { createDatabase } from "./index"
import { SCHEMA_VERSION, agents, messages, runs } from "./schema"

describe("schema v2 bootstrap", () => {
  test("fresh database migrates and sets user_version", () => {
    const dir = mkdtempSync(join(tmpdir(), "aegisx-db-"))
    try {
      const { db, sqlite, releaseLock } = createDatabase(dir)
      const version = (
        sqlite.query("PRAGMA user_version").get() as { user_version: number }
      ).user_version
      expect(version).toBe(SCHEMA_VERSION)
      const tables = sqlite
        .query(
          `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`
        )
        .all() as Array<{ name: string }>
      const names = new Set(tables.map((row) => row.name))
      expect(names.has("agents")).toBe(true)
      expect(names.has("messages")).toBe(true)
      expect(names.has("runs")).toBe(true)
      expect(names.has("agent_inbox")).toBe(false)
      expect(names.has("run_events")).toBe(false)
      // drizzle table symbols resolve
      expect(runs).toBeDefined()
      expect(agents).toBeDefined()
      expect(messages).toBeDefined()
      expect(db).toBeDefined()
      sqlite.close()
      releaseLock()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("rejects v1 database with agent_inbox", () => {
    const dir = mkdtempSync(join(tmpdir(), "aegisx-db-v1-"))
    try {
      const path = join(dir, "aegisx.sqlite")
      const sqlite = new Database(path, { create: true })
      sqlite.run(`
        CREATE TABLE agent_inbox (
          id text PRIMARY KEY NOT NULL,
          agent_id text NOT NULL,
          kind text NOT NULL,
          content text NOT NULL,
          created_at text NOT NULL
        )
      `)
      sqlite.close()
      expect(() => createDatabase(dir)).toThrow(/v1 database/i)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("rejects incomplete agents-without-messages database", () => {
    const dir = mkdtempSync(join(tmpdir(), "aegisx-db-bad-"))
    try {
      const path = join(dir, "aegisx.sqlite")
      const sqlite = new Database(path, { create: true })
      sqlite.run(`CREATE TABLE agents (id text PRIMARY KEY NOT NULL)`)
      sqlite.close()
      expect(() => createDatabase(dir)).toThrow(/incomplete|corrupted/i)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
