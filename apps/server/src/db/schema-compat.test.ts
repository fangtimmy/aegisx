import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  classifyDatabaseState,
  createDatabase,
  pendingMigrationCount,
} from "./index"
import { SCHEMA_VERSION } from "./schema"

describe("schema bootstrap", () => {
  test("fresh database migrates and sets user_version to the current schema", () => {
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
      expect(names.has("orchestrators")).toBe(true)
      expect(names.has("challenge_flags")).toBe(true)
      // drizzle migration tracking is present (the recognized-DB marker)
      expect(names.has("__drizzle_migrations")).toBe(true)
      // the legacy normalized event log is gone (session_entries is the source)
      expect(names.has("run_events")).toBe(false)
      expect(db).toBeDefined()
      sqlite.close()
      releaseLock()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("classifyDatabaseState", () => {
  test("fresh when there are no tables", () => {
    expect(classifyDatabaseState(new Set(), 0, SCHEMA_VERSION)).toEqual({
      kind: "fresh",
    })
  })

  test("recognized when __drizzle_migrations is present", () => {
    expect(
      classifyDatabaseState(
        new Set(["runs", "__drizzle_migrations"]),
        SCHEMA_VERSION,
        SCHEMA_VERSION
      )
    ).toEqual({ kind: "recognized" })
  })

  test("preBaseline when tables exist without __drizzle_migrations", () => {
    expect(
      classifyDatabaseState(new Set(["runs", "agents"]), 5, SCHEMA_VERSION)
    ).toEqual({ kind: "preBaseline" })
  })

  test("newerThanBinary when user_version exceeds the schema version", () => {
    expect(
      classifyDatabaseState(
        new Set(["runs", "__drizzle_migrations"]),
        SCHEMA_VERSION + 1,
        SCHEMA_VERSION
      )
    ).toEqual({
      kind: "newerThanBinary",
      userVersion: SCHEMA_VERSION + 1,
    })
  })
})

describe("pendingMigrationCount", () => {
  test("zero when applied equals known", () => {
    expect(pendingMigrationCount(1, 1)).toBe(0)
  })

  test("positive when known exceeds applied", () => {
    expect(pendingMigrationCount(3, 1)).toBe(2)
  })

  test("clamps to zero when applied exceeds known (downgrade)", () => {
    expect(pendingMigrationCount(1, 2)).toBe(0)
  })
})

describe("createDatabase classification", () => {
  test("rejects a pre-baseline database (predates the migration system)", () => {
    const dir = mkdtempSync(join(tmpdir(), "aegisx-db-prebaseline-"))
    try {
      const path = join(dir, "aegisx.sqlite")
      const sqlite = new Database(path, { create: true })
      // v1–v5 era DB: our tables, no drizzle tracking, stale user_version.
      sqlite.run(`CREATE TABLE runs (id text PRIMARY KEY NOT NULL)`)
      sqlite.run(`PRAGMA user_version = 5`)
      sqlite.close()
      expect(() => createDatabase(dir)).toThrow(
        /predates the migration system/i
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("rejects a database newer than the binary (downgrade)", () => {
    const dir = mkdtempSync(join(tmpdir(), "aegisx-db-newer-"))
    try {
      // bootstrap fresh, then bump user_version past the binary's version
      const boot = createDatabase(dir)
      boot.sqlite.run(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`)
      boot.sqlite.close()
      boot.releaseLock()
      expect(() => createDatabase(dir)).toThrow(/newer than this binary/i)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a recognized, up-to-date database opens without making a backup", () => {
    const dir = mkdtempSync(join(tmpdir(), "aegisx-db-current-"))
    try {
      const boot = createDatabase(dir)
      boot.sqlite.close()
      boot.releaseLock()
      // reopen: recognized + no pending migrations → no snapshot taken
      const before = readdirSync(dir).filter((f) =>
        f.startsWith("aegisx.sqlite.bak")
      )
      const second = createDatabase(dir)
      const after = readdirSync(dir).filter((f) =>
        f.startsWith("aegisx.sqlite.bak")
      )
      expect(after).toEqual(before)
      second.sqlite.close()
      second.releaseLock()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("backs up and restores when a migration fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "aegisx-db-fail-"))
    try {
      // Bootstrap a real DB and plant a sentinel row to prove restore preserves data.
      const boot = createDatabase(dir)
      boot.sqlite.run(
        `INSERT INTO events (id, name, created_at, updated_at) VALUES ('sentinel', 's', 't', 't')`
      )
      boot.sqlite.close()
      boot.releaseLock()

      // Force a pending migration by dropping the applied-migration record,
      // so migrate() tries to re-run the baseline and fails (tables already exist).
      const raw = new Database(join(dir, "aegisx.sqlite"))
      raw.run(`DELETE FROM __drizzle_migrations`)
      raw.close()

      const backupsBefore = readdirSync(dir).filter((f) =>
        f.startsWith("aegisx.sqlite.bak")
      ).length
      expect(() => createDatabase(dir)).toThrow(/restored from/i)
      const backupsAfter = readdirSync(dir).filter((f) =>
        f.startsWith("aegisx.sqlite.bak")
      )
      expect(backupsAfter.length).toBe(backupsBefore + 1)

      // The snapshot was restored: the sentinel row survives.
      const check = new Database(join(dir, "aegisx.sqlite"))
      const rows = check
        .query(`SELECT count(*) AS n FROM events WHERE id = 'sentinel'`)
        .get() as { n: number }
      check.close()
      expect(rows.n).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
