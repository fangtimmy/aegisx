import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createDatabase } from "./index"
import { SCHEMA_VERSION } from "./schema"

describe("schema bootstrap", () => {
  test("fresh database migrates to SCHEMA_VERSION with the v19 table set", () => {
    const dir = mkdtempSync(join(tmpdir(), "aegisx-db-"))
    try {
      const { db, sqlite, releaseLock } = createDatabase(dir)
      const version = sqlite
        .query<{ user_version: number }, []>("PRAGMA user_version")
        .get()!.user_version
      expect(version).toBe(SCHEMA_VERSION)
      const names = new Set(
        sqlite
          .query<{ name: string }, []>(
            `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`
          )
          .all()
          .map((row) => row.name)
      )
      for (const t of [
        "agents",
        "sessions",
        "session_entries",
        "spawn_queue",
        "scheduler_config",
        "channel_messages",
        "channel_reads",
        "prompt_templates",
        "challenge_flags",
        "queue_state",
      ]) {
        expect(names.has(t)).toBe(true)
      }
      // v18 (0012): the channels directory table is dropped — a channel is
      // a derived key on the message rows, not a table row.
      expect(names.has("channels")).toBe(false)
      // v19 (0013): the run layer is dropped (agents anchor challenges
      // directly; the queue spawns agents; channel attachments are shared/
      // workspace copies).
      expect(names.has("runs")).toBe(false)
      expect(names.has("run_queue")).toBe(false)
      expect(names.has("channel_files")).toBe(false)
      // orchestrators merged into runs in v8; runs dropped in v19.
      expect(names.has("orchestrators")).toBe(false)
      expect(names.has("__drizzle_migrations")).toBe(true)
      expect(db).toBeDefined()
      sqlite.close()
      releaseLock()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("v19 column shapes: agents anchor events/challenges; spawn_queue carries agent_id", () => {
    const dir = mkdtempSync(join(tmpdir(), "aegisx-db-cols-"))
    try {
      const { sqlite, releaseLock } = createDatabase(dir)
      const agentCols = new Set(
        sqlite
          .query<
            {
              name: string
            },
            []
          >(`PRAGMA table_info(agents)`)
          .all()
          .map((c) => c.name)
      )
      for (const c of [
        "event_id",
        "challenge_id",
        "role",
        "model",
        "system_prompt",
        "tools",
        "tool_definitions",
        "status",
        "session_file",
        "prompt",
        "source",
        "timeout_ms",
        "deadline_at",
        "last_timeout_at",
        "queue_item_id",
        "summary",
      ]) {
        expect(agentCols.has(c)).toBe(true)
      }
      // The run-layer and v8-v18 inheritance columns are gone.
      for (const gone of [
        "run_id",
        "slot",
        "is_entry",
        "parent_agent_id",
        "task",
        "model_id",
        "provider",
      ]) {
        expect(agentCols.has(gone)).toBe(false)
      }

      const sessionCols = sqlite
        .query<
          {
            name: string
          },
          []
        >(`PRAGMA table_info(sessions)`)
        .all()
        .map((c) => c.name)
      expect(sessionCols).toEqual(["id", "agent_id", "cwd", "created_at"])

      const entryCols = new Set(
        sqlite
          .query<
            {
              name: string
            },
            []
          >(`PRAGMA table_info(session_entries)`)
          .all()
          .map((c) => c.name)
      )
      // v10 meta + v19 run_id removal.
      expect(entryCols.has("meta")).toBe(true)
      expect(entryCols.has("run_id")).toBe(false)

      // 0006: queue_state rows + scheduler_config.paused (W2/W3)
      const queueStateCols = new Set(
        sqlite
          .query<
            {
              name: string
            },
            []
          >(`PRAGMA table_info(queue_state)`)
          .all()
          .map((c) => c.name)
      )
      expect([...queueStateCols]).toEqual(
        expect.arrayContaining(["event_id", "status", "updated_at"])
      )
      const configCols = new Set(
        sqlite
          .query<
            {
              name: string
            },
            []
          >(`PRAGMA table_info(scheduler_config)`)
          .all()
          .map((c) => c.name)
      )
      expect(configCols.has("paused")).toBe(true)

      // 0007: challenge_remote is event-scoped — event_id column + unique
      // index (event_id, source_key, remote_id)
      const remoteCols = new Set(
        sqlite
          .query<
            {
              name: string
            },
            []
          >(`PRAGMA table_info(challenge_remote)`)
          .all()
          .map((c) => c.name)
      )
      expect(remoteCols.has("event_id")).toBe(true)
      const uniqueIdx = sqlite
        .query<{ name: string }, []>(
          `SELECT name FROM pragma_index_list('challenge_remote') WHERE "unique" = 1 AND origin = 'c'`
        )
        .all()
      expect(uniqueIdx.map((i) => i.name)).toEqual([
        "challenge_remote_source_unique",
      ])
      const idxCols = sqlite
        .query<{ name: string }, []>(
          `SELECT name FROM pragma_index_info('challenge_remote_source_unique')`
        )
        .all()
        .map((c) => c.name)
      expect(idxCols).toEqual(["event_id", "source_key", "remote_id"])

      // v18 (0012): derived-key channel shapes — channel_messages carries
      // the derived key (no channel id, no kind); channel_reads is keyed
      // (channel_key, reader_key).
      const msgCols = new Set(
        sqlite
          .query<
            {
              name: string
            },
            []
          >(`PRAGMA table_info(channel_messages)`)
          .all()
          .map((c) => c.name)
      )
      expect([...msgCols]).toEqual(
        expect.arrayContaining([
          "id",
          "channel_key",
          "author_type",
          "body",
          "meta",
          "created_at",
        ])
      )
      expect(msgCols.has("channel_id")).toBe(false)
      expect(msgCols.has("kind")).toBe(false)
      const msgIdx = sqlite
        .query<{ name: string }, []>(
          `SELECT name FROM pragma_index_list('channel_messages') WHERE origin = 'c'`
        )
        .all()
        .map((i) => i.name)
      expect(msgIdx).toContain("channel_messages_channel_key_idx")
      const readCols = sqlite
        .query<
          {
            name: string
          },
          []
        >(`PRAGMA table_info(channel_reads)`)
        .all()
        .map((c) => c.name)
      expect(readCols).toEqual([
        "channel_key",
        "reader_key",
        "last_read_msg_id",
        "updated_at",
      ])

      // v19 (0013): spawn_queue — agent back-fill + append semantics (no
      // challenge unique constraint).
      const queueCols = new Set(
        sqlite
          .query<
            {
              name: string
            },
            []
          >(`PRAGMA table_info(spawn_queue)`)
          .all()
          .map((c) => c.name)
      )
      expect([...queueCols]).toEqual(
        expect.arrayContaining([
          "event_id",
          "challenge_id",
          "params",
          "timeout_ms",
          "prompt",
          "source",
          "status",
          "agent_id",
        ])
      )
      const queueUnique = sqlite
        .query<{ name: string }, []>(
          `SELECT name FROM pragma_index_list('spawn_queue') WHERE "unique" = 1 AND origin = 'c'`
        )
        .all()
      expect(queueUnique).toEqual([])

      // v19: challenge_flags anchors agent_id (text, no FK).
      const flagCols = new Set(
        sqlite
          .query<
            {
              name: string
            },
            []
          >(`PRAGMA table_info(challenge_flags)`)
          .all()
          .map((c) => c.name)
      )
      expect(flagCols.has("agent_id")).toBe(true)
      expect(flagCols.has("run_id")).toBe(false)
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
        .query<{ n: number }, []>(
          `SELECT count(*) AS n FROM events WHERE id = 'sentinel'`
        )
        .get()!
      check.close()
      expect(rows.n).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
