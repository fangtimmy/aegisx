import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createDatabase } from "./index"
import { agents, runEvents, runs, SCHEMA_VERSION } from "./schema"

describe("schema v5 bootstrap", () => {
  test("fresh database migrates and sets user_version=4", () => {
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
      expect(names.has("runs")).toBe(true)
      expect(names.has("agents")).toBe(true)
      expect(names.has("run_events")).toBe(true)
      expect(names.has("submissions")).toBe(true)
      // v2-only tables are gone
      expect(names.has("messages")).toBe(false)
      expect(names.has("agent_usage")).toBe(false)
      // v1-only tables are gone
      expect(names.has("agent_inbox")).toBe(false)
      expect(names.has("run_agents")).toBe(false)
      expect(names.has("agent_messages")).toBe(false)
      // drizzle table symbols resolve
      expect(runs).toBeDefined()
      expect(agents).toBeDefined()
      expect(runEvents).toBeDefined()
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
      sqlite.run(`CREATE TABLE agent_inbox (id text PRIMARY KEY NOT NULL)`)
      sqlite.close()
      expect(() => createDatabase(dir)).toThrow(/v1 database/i)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("rejects v2 database with messages", () => {
    const dir = mkdtempSync(join(tmpdir(), "aegisx-db-v2-"))
    try {
      const path = join(dir, "aegisx.sqlite")
      const sqlite = new Database(path, { create: true })
      sqlite.run(`CREATE TABLE messages (id text PRIMARY KEY NOT NULL)`)
      sqlite.run(`CREATE TABLE agent_usage (id text PRIMARY KEY NOT NULL)`)
      sqlite.close()
      expect(() => createDatabase(dir)).toThrow(/v2 database/i)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("rejects v3 database (user_version=3)", () => {
    const dir = mkdtempSync(join(tmpdir(), "aegisx-db-v3-"))
    try {
      const path = join(dir, "aegisx.sqlite")
      const sqlite = new Database(path, { create: true })
      sqlite.run(`CREATE TABLE runs (id text PRIMARY KEY NOT NULL)`)
      sqlite.run(`PRAGMA user_version = 3`)
      sqlite.close()
      expect(() => createDatabase(dir)).toThrow(/older than v5/i)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("rejects v4 database (user_version=4)", () => {
    const dir = mkdtempSync(join(tmpdir(), "aegisx-db-v4-"))
    try {
      const path = join(dir, "aegisx.sqlite")
      const sqlite = new Database(path, { create: true })
      sqlite.run(`CREATE TABLE runs (id text PRIMARY KEY NOT NULL)`)
      sqlite.run(`PRAGMA user_version = 4`)
      sqlite.close()
      expect(() => createDatabase(dir)).toThrow(/older than v5/i)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
