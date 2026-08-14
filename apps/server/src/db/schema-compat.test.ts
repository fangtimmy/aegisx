import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createDatabase } from "./index"
import { SCHEMA_VERSION } from "./schema"

describe("schema bootstrap", () => {
  test("fresh database migrates to SCHEMA_VERSION and drops the merged orchestrators table", () => {
    const dir = mkdtempSync(join(tmpdir(), "aegisx-db-"))
    try {
      const { db, sqlite, releaseLock } = createDatabase(dir)
      const version = (
        sqlite.query("PRAGMA user_version").get() as { user_version: number }
      ).user_version
      expect(version).toBe(SCHEMA_VERSION)
      const names = new Set(
        (
          sqlite
            .query(
              `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`
            )
            .all() as Array<{ name: string }>
        ).map((row) => row.name)
      )
      // v8+ execution + new tables present
      for (const t of [
        "runs",
        "agents",
        "sessions",
        "session_entries",
        "run_queue",
        "scheduler_config",
        "prompt_templates",
        "challenge_flags",
      ]) {
        expect(names.has(t)).toBe(true)
      }
      // orchestrators merged into runs; drizzle tracking present
      expect(names.has("orchestrators")).toBe(false)
      expect(names.has("__drizzle_migrations")).toBe(true)
      expect(db).toBeDefined()
      sqlite.close()
      releaseLock()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("v8 preserved columns: single canonical model ref on runs/agents, session_entries.meta", () => {
    const dir = mkdtempSync(join(tmpdir(), "aegisx-cols-"))
    try {
      const { sqlite, releaseLock } = createDatabase(dir)
      const runCols = new Set(
        (
          sqlite.query(`PRAGMA table_info(runs)`).all() as Array<{
            name: string
          }>
        ).map((c) => c.name)
      )
      expect(runCols.has("scope_type")).toBe(true)
      expect(runCols.has("orchestration")).toBe(true)
      expect(runCols.has("finishing")).toBe(true)
      expect(runCols.has("queue_item_id")).toBe(true)
      expect(runCols.has("params")).toBe(true)
      expect(runCols.has("last_timeout_at")).toBe(true)
      // v9: single canonical model ref column (not provider/model_id/etc.)
      expect(runCols.has("model")).toBe(true)
      expect(runCols.has("provider")).toBe(false)
      expect(runCols.has("model_id")).toBe(false)
      expect(runCols.has("halfway_notified_at")).toBe(false)

      const agentCols = new Set(
        (
          sqlite.query(`PRAGMA table_info(agents)`).all() as Array<{
            name: string
          }>
        ).map((c) => c.name)
      )
      for (const c of ["slot", "is_entry", "system_prompt", "tools", "model"]) {
        expect(agentCols.has(c)).toBe(true)
      }
      // v11: tool-definition snapshot column (nullable)
      expect(agentCols.has("tool_definitions")).toBe(true)
      expect(agentCols.has("model_id")).toBe(false)
      expect(agentCols.has("provider")).toBe(false)

      const sessionCols = (
        sqlite.query(`PRAGMA table_info(sessions)`).all() as Array<{
          name: string
        }>
      ).map((c) => c.name)
      expect(sessionCols).toEqual(["id", "agent_id", "cwd", "created_at"])

      // v10: session_entries.meta (nullable timing JSON column)
      const entryCols = new Set(
        (
          sqlite.query(`PRAGMA table_info(session_entries)`).all() as Array<{
            name: string
          }>
        ).map((c) => c.name)
      )
      expect(entryCols.has("meta")).toBe(true)
      sqlite.close()
      releaseLock()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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
