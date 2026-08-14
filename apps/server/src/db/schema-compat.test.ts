import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import {
  classifyDatabaseState,
  createDatabase,
  pendingMigrationCount,
} from "./index"
import { SCHEMA_VERSION } from "./schema"

const DRIZZLE_DIR = resolve(import.meta.dir, "../../drizzle")

/** Apply a migration SQL file (split on drizzle statement breakpoints) and
 * return its drizzle hash (sha256 of the raw file content). Used to build a
 * genuine prior-version database for the upgrade test. */
function applyMigrationFile(sqlite: Database, tag: string): string {
  const raw = readFileSync(join(DRIZZLE_DIR, `${tag}.sql`), "utf8")
  for (const chunk of raw.split("--> statement-breakpoint")) {
    const stmt = chunk.trim()
    if (stmt) sqlite.run(stmt)
  }
  return createHash("sha256").update(raw).digest("hex")
}

/** Build a real v7 database (0000 + 0001 applied, hashes recorded, user_version
 * = 7) so createDatabase sees a recognized DB with the v8/v9 migrations
 * pending. */
function buildV7Database(dir: string) {
  const sqlite = new Database(join(dir, "aegisx.sqlite"), { create: true })
  sqlite.run("PRAGMA foreign_keys = ON")
  const h0 = applyMigrationFile(sqlite, "0000_broken_snowbird")
  const h1 = applyMigrationFile(sqlite, "0001_challenge_flags_solve_state")
  sqlite.run(
    `CREATE TABLE IF NOT EXISTS __drizzle_migrations (id integer PRIMARY KEY AUTOINCREMENT NOT NULL, hash text NOT NULL, created_at numeric)`
  )
  sqlite.run(
    `INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)`,
    [h0, 1785818785132]
  )
  sqlite.run(
    `INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)`,
    [h1, 1785986800000]
  )
  sqlite.run(`PRAGMA user_version = 7`)
  return sqlite
}

describe("schema bootstrap", () => {
  test("fresh database migrates to v10 and drops the merged orchestrators table", () => {
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
      // v8/v9 execution + new tables present
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

  test("fresh runs/agents/sessions carry the v9 columns (single model ref; no halfway_notified) and v10 session_entries.meta", () => {
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

describe("v7 → v9 migration (preserve catalog, wipe execution state)", () => {
  test("catalog/history rows survive; execution-state tables are wiped; challenge_flags keep a historical runId", () => {
    const dir = mkdtempSync(join(tmpdir(), "aegisx-upg-"))
    try {
      const seed = buildV7Database(dir)
      seed.run(
        `INSERT INTO events (id, name, prompt_hint, created_at, updated_at) VALUES ('ev1','Evt','hint','t','t')`
      )
      seed.run(
        `INSERT INTO challenges (id, event_id, name, description, category, points, manual_solve_state, created_at, updated_at) VALUES ('ch1','ev1','C','desc','web',100,'unsolved','t','t')`
      )
      // execution rows first (challenge_flags.run_id FK still active in v7)
      seed.run(
        `INSERT INTO runs (id, challenge_id, status, provider, model_id, thinking_level, image, cpus, memory_mb, pids_limit, container_name, workspace_path, session_dir, created_at, started_at, updated_at, source) VALUES ('old-run-1','ch1','idle','p','m','off','img',1,1,1,'c','w','s','t','t','t','manual')`
      )
      seed.run(
        `INSERT INTO agents (id, run_id, role, status, created_at, updated_at) VALUES ('old-agent-1','old-run-1','main','idle','t','t')`
      )
      seed.run(
        `INSERT INTO orchestrators (event_id, enabled, instruction, status, container_name, image, cpus, memory_mb, pids_limit, workspace_path, session_dir, created_at, updated_at) VALUES ('ev1',1,'do x','idle','oc','img',1,1,1,'w','s','t','t')`
      )
      seed.run(
        `INSERT INTO challenge_flags (id, challenge_id, flag, status, source, run_id, created_at, updated_at) VALUES ('fl1','ch1','flag{a}','accepted','run','old-run-1','t','t')`
      )
      seed.run(`PRAGMA wal_checkpoint(TRUNCATE)`)
      seed.close()

      // upgrade
      const reopened = createDatabase(dir)
      const sqlite = reopened.sqlite

      expect(
        (sqlite.query("PRAGMA user_version").get() as { user_version: number })
          .user_version
      ).toBe(SCHEMA_VERSION)

      // catalog preserved
      expect(
        (
          sqlite.query(`SELECT count(*) AS n FROM events`).get() as {
            n: number
          }
        ).n
      ).toBe(1)
      expect(
        (
          sqlite.query(`SELECT count(*) AS n FROM challenges`).get() as {
            n: number
          }
        ).n
      ).toBe(1)
      const flag = sqlite.query(`SELECT * FROM challenge_flags`).get() as {
        status: string
        run_id: string
      }
      expect(flag.status).toBe("accepted")
      // run-sourced flag keeps its historical runId (now dangling; no FK in v8)
      expect(flag.run_id).toBe("old-run-1")

      // execution wiped
      expect(
        (sqlite.query(`SELECT count(*) AS n FROM runs`).get() as { n: number })
          .n
      ).toBe(0)
      expect(
        (
          sqlite.query(`SELECT count(*) AS n FROM agents`).get() as {
            n: number
          }
        ).n
      ).toBe(0)

      // orchestrators gone; new tables present
      const names = new Set(
        (
          sqlite
            .query(`SELECT name FROM sqlite_master WHERE type='table'`)
            .all() as Array<{ name: string }>
        ).map((r) => r.name)
      )
      expect(names.has("orchestrators")).toBe(false)
      for (const t of ["run_queue", "scheduler_config", "prompt_templates"]) {
        expect(names.has(t)).toBe(true)
      }

      sqlite.close()
      reopened.releaseLock()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("schema constraints", () => {
  // A fresh run + a sample challenge to satisfy FKs. v9 stores the model as a
  // single canonical ref string column (no provider/model_id columns).
  function freshRun(sqlite: Database, runId = "r1") {
    sqlite.run(
      `INSERT INTO events (id, name, prompt_hint, created_at, updated_at) VALUES ('ev1','E','','t','t')`
    )
    sqlite.run(
      `INSERT INTO challenges (id, event_id, name, description, manual_solve_state, created_at, updated_at) VALUES ('ch1','ev1','C','d','unsolved','t','t')`
    )
    sqlite.run(
      `INSERT INTO runs (id, scope_type, event_id, challenge_id, orchestration, status, model, image, cpus, memory_mb, pids_limit, container_name, workspace_path, session_dir, source, created_at, updated_at) VALUES ('${runId}','challenge','ev1','ch1','classic','idle','p/m:off','img',1,1,1,'c','w','s','manual','t','t')`
    )
  }

  function agentInsert(
    sqlite: Database,
    id: string,
    runId: string,
    isEntry: boolean
  ) {
    sqlite.run(
      `INSERT INTO agents (id, run_id, slot, role, is_entry, model, system_prompt, tools, status, created_at, updated_at) VALUES ('${id}','${runId}','${id}','solver',${isEntry ? 1 : 0},'p/m:off','sp','[]','idle','t','t')`
    )
  }

  test("at most one entry agent per run (partial unique index)", () => {
    const dir = mkdtempSync(join(tmpdir(), "aegisx-entry-"))
    try {
      const { sqlite, releaseLock } = createDatabase(dir)
      freshRun(sqlite)
      agentInsert(sqlite, "a1", "r1", true)
      expect(() => agentInsert(sqlite, "a2", "r1", true)).toThrow()
      // a non-entry agent for the same run is fine
      expect(() => agentInsert(sqlite, "a3", "r1", false)).not.toThrow()
      sqlite.close()
      releaseLock()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("unique(runId, slot)", () => {
    const dir = mkdtempSync(join(tmpdir(), "aegisx-slot-"))
    try {
      const { sqlite, releaseLock } = createDatabase(dir)
      freshRun(sqlite)
      agentInsert(sqlite, "a1", "r1", false)
      // same slot, different id → rejected
      expect(() =>
        sqlite.run(
          `INSERT INTO agents (id, run_id, slot, role, is_entry, model, system_prompt, tools, status, created_at, updated_at) VALUES ('a2','r1','a1','solver',0,'p/m:off','sp','[]','idle','t','t')`
        )
      ).toThrow()
      sqlite.close()
      releaseLock()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("at most one event-scoped (scheduler) run per event", () => {
    const dir = mkdtempSync(join(tmpdir(), "aegisx-sched-"))
    try {
      const { sqlite, releaseLock } = createDatabase(dir)
      sqlite.run(
        `INSERT INTO events (id, name, prompt_hint, created_at, updated_at) VALUES ('ev1','E','','t','t')`
      )
      sqlite.run(
        `INSERT INTO runs (id, scope_type, event_id, orchestration, status, model, image, cpus, memory_mb, pids_limit, container_name, workspace_path, session_dir, source, created_at, updated_at) VALUES ('s1','event','ev1','scheduler','idle','p/m:off','img',1,1,1,'c','w','s','manual','t','t')`
      )
      expect(() =>
        sqlite.run(
          `INSERT INTO runs (id, scope_type, event_id, orchestration, status, model, image, cpus, memory_mb, pids_limit, container_name, workspace_path, session_dir, source, created_at, updated_at) VALUES ('s2','event','ev1','scheduler','idle','p/m:off','img',1,1,1,'c','w','s','manual','t','t')`
        )
      ).toThrow()
      // a challenge-scope run for the same event is unrelated and allowed
      sqlite.run(
        `INSERT INTO challenges (id, event_id, name, description, manual_solve_state, created_at, updated_at) VALUES ('ch1','ev1','C','d','unsolved','t','t')`
      )
      expect(() =>
        sqlite.run(
          `INSERT INTO runs (id, scope_type, event_id, challenge_id, orchestration, status, model, image, cpus, memory_mb, pids_limit, container_name, workspace_path, session_dir, source, created_at, updated_at) VALUES ('c1','challenge','ev1','ch1','classic','idle','p/m:off','img',1,1,1,'c','w','s','manual','t','t')`
        )
      ).not.toThrow()
      sqlite.close()
      releaseLock()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("agents.status allows 'aborted'; role is free text", () => {
    const dir = mkdtempSync(join(tmpdir(), "aegisx-abort-"))
    try {
      const { sqlite, releaseLock } = createDatabase(dir)
      freshRun(sqlite)
      expect(() =>
        sqlite.run(
          `INSERT INTO agents (id, run_id, slot, role, model, system_prompt, tools, status, created_at, updated_at) VALUES ('a1','r1','s1','solver','p/m:off','sp','[]','aborted','t','t')`
        )
      ).not.toThrow()
      sqlite.close()
      releaseLock()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("runs.source allows 'scheduler', rejects 'orchestrator'", () => {
    const dir = mkdtempSync(join(tmpdir(), "aegisx-src-"))
    try {
      const { sqlite, releaseLock } = createDatabase(dir)
      sqlite.run(
        `INSERT INTO events (id, name, prompt_hint, created_at, updated_at) VALUES ('ev1','E','','t','t')`
      )
      expect(() =>
        sqlite.run(
          `INSERT INTO runs (id, scope_type, event_id, orchestration, status, model, image, cpus, memory_mb, pids_limit, container_name, workspace_path, session_dir, source, created_at, updated_at) VALUES ('s1','event','ev1','scheduler','idle','p/m:off','img',1,1,1,'c','w','s','scheduler','t','t')`
        )
      ).not.toThrow()
      expect(() =>
        sqlite.run(
          `INSERT INTO runs (id, scope_type, event_id, orchestration, status, model, image, cpus, memory_mb, pids_limit, container_name, workspace_path, session_dir, source, created_at, updated_at) VALUES ('s2','event','ev1','scheduler','idle','p/m:off','img',1,1,1,'c','w','s','orchestrator','t','t')`
        )
      ).toThrow()
      sqlite.close()
      releaseLock()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("challenge_flags.run_id has no FK: historical runId survives even with no matching run", () => {
    const dir = mkdtempSync(join(tmpdir(), "aegisx-cf-"))
    try {
      const { sqlite, releaseLock } = createDatabase(dir)
      sqlite.run(
        `INSERT INTO events (id, name, prompt_hint, created_at, updated_at) VALUES ('ev1','E','','t','t')`
      )
      sqlite.run(
        `INSERT INTO challenges (id, event_id, name, description, manual_solve_state, created_at, updated_at) VALUES ('ch1','ev1','C','d','unsolved','t','t')`
      )
      // no runs row exists; a dangling runId must still insert (no FK in v8)
      expect(() =>
        sqlite.run(
          `INSERT INTO challenge_flags (id, challenge_id, flag, status, source, run_id, created_at, updated_at) VALUES ('fl1','ch1','flag{x}','accepted','run','nonexistent-run','t','t')`
        )
      ).not.toThrow()
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
