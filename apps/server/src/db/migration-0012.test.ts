import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { drizzle } from "drizzle-orm/bun-sqlite"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"

import { createDatabase } from "./index"
import { SCHEMA_VERSION } from "./schema"

/** The real migrations folder (13 entries incl. 0012). */
const realFolder = resolve(import.meta.dir, "../../drizzle")

/** Build a v17 database in `dir`: apply migrations 0000–0011 from a
 * truncated journal copy (the exact runtime migrator path, minus 0012). */
function buildV17Database(dir: string) {
  const sqlite = new Database(join(dir, "aegisx.sqlite"), { create: true })
  sqlite.run("PRAGMA journal_mode = WAL")
  // FK ON matches the production boot (createDatabase enables it before
  // migrating): RENAME TABLE rewrites FK references only with FK ON —
  // otherwise 0011's table recreation leaves dangling `channels_new`
  // references and every later child insert fails.
  sqlite.run("PRAGMA foreign_keys = ON")
  const folder = join(dir, "mig-v17")
  mkdirSync(join(folder, "meta"), { recursive: true })
  const journal = JSON.parse(
    readFileSync(join(realFolder, "meta", "_journal.json"), "utf8")
  ) as { entries: Array<{ tag: string }> }
  journal.entries = journal.entries.slice(0, 12) // 0000–0011 = v17
  writeFileSync(join(folder, "meta", "_journal.json"), JSON.stringify(journal))
  for (const entry of journal.entries) {
    cpSync(
      join(realFolder, `${entry.tag}.sql`),
      join(folder, `${entry.tag}.sql`)
    )
  }
  migrate(drizzle(sqlite), { migrationsFolder: folder })
  sqlite.run("PRAGMA user_version = 17")
  return sqlite
}

describe("migration 0012 — v18 derived channel keys (docs/im-simplify-v18.md §7.1)", () => {
  test("v17 channels map onto derived keys with merge order, cursors and files intact; recap dropped; channels table gone", () => {
    const dir = mkdtempSync(join(tmpdir(), "aegisx-mig0012-"))
    try {
      const sqlite = buildV17Database(dir)
      const ts = "2025-01-01T00:00:00.000Z"

      // --- v17 seed ------------------------------------------------------
      sqlite.run(`PRAGMA foreign_keys = ON`)
      sqlite.run(
        `INSERT INTO events (id, name, created_at, updated_at) VALUES ('evt-1', 'e', ?, ?)`,
        [ts, ts]
      )
      sqlite.run(
        `INSERT INTO challenges (id, event_id, name, description, created_at, updated_at) VALUES ('ch-1', 'evt-1', 'c1', 'd', ?, ?)`,
        [ts, ts]
      )
      sqlite.run(
        `INSERT INTO challenges (id, event_id, name, description, created_at, updated_at) VALUES ('ch-2', 'evt-1', 'c2', 'd', ?, ?)`,
        [ts, ts]
      )
      const insertRun = (
        id: string,
        challengeId: string | null,
        scope: string
      ) =>
        sqlite.run(
          `INSERT INTO runs (id, scope_type, event_id, challenge_id, params, status, model, image, cpus, memory_mb, pids_limit, container_name, workspace_path, session_dir, source, created_at, started_at, updated_at)
           VALUES (?, ?, 'evt-1', ?, '{}', 'closed', 'm:off', 'img', 1, 512, 64, ?, 'w', 's', 'manual', ?, ?, ?)`,
          [id, scope, challengeId, `c-${id}`, ts, ts, ts]
        )
      insertRun("runA", "ch-1", "challenge")
      insertRun("runS", null, "event")
      const insertAgent = (id: string, runId: string) =>
        sqlite.run(
          `INSERT INTO agents (id, run_id, slot, role, is_entry, model, system_prompt, tools, status, created_at, updated_at, name)
           VALUES (?, ?, 'solver', 'solver', 1, 'm:off', 'sp', '[]', 'idle', ?, ?, ?)`,
          [id, runId, ts, ts, id]
        )
      insertAgent("a1", "runA")
      insertAgent("sched", "runS")

      // v17 channels: challenge-scope team + announce on ch-1, team on ch-2,
      // a run DM and the event-scope scheduler DM.
      const insertChannel = (
        id: string,
        scope: string,
        runId: string | null,
        kind: string,
        target: string | null,
        challengeId: string | null
      ) =>
        sqlite.run(
          `INSERT INTO channels (id, scope_type, run_id, event_id, challenge_id, kind, target_agent_id, created_at)
           VALUES (?, ?, ?, 'evt-1', ?, ?, ?, ?)`,
          [id, scope, runId, challengeId, kind, target, ts]
        )
      insertChannel("tA1", "challenge", null, "team", null, "ch-1")
      insertChannel("aA1", "challenge", null, "announce", null, "ch-1")
      insertChannel("tC1", "challenge", null, "team", null, "ch-2")
      insertChannel("dm1", "run", "runA", "dm", "a1", null)
      insertChannel("sdm", "event", null, "dm", "sched", null)

      // Interleaved #team / #announce history — ids globally monotonic; the
      // announce→team merge must preserve that order (0011's technique).
      const insertMessage = (
        id: number,
        channelId: string,
        kind: string,
        authorType: string,
        authorAgentId: string | null,
        authorName: string,
        body: string
      ) =>
        sqlite.run(
          `INSERT INTO channel_messages (id, channel_id, kind, author_type, author_agent_id, author_name, body, meta, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?)`,
          [id, channelId, kind, authorType, authorAgentId, authorName, body, ts]
        )
      insertMessage(1, "tA1", "text", "agent", "a1", "Solver a1 · run-runA", "finding A1")
      insertMessage(2, "aA1", "text", "system", null, "system", "announce A")
      insertMessage(3, "tA1", "text", "user", null, "用户", "note")
      insertMessage(4, "aA1", "text", "agent", "a1", "Solver a1 · run-runA", "announce B")
      insertMessage(5, "dm1", "text", "user", null, "用户", "dm msg")
      insertMessage(6, "sdm", "text", "agent", "a1", "Solver a1 · run-runA", "solver ask")
      insertMessage(7, "tA1", "recap", "system", null, "system", "recap snapshot")
      insertMessage(8, "tC1", "text", "system", null, "system", "other challenge")

      // Read cursors: a1 holds cursors on BOTH ch-1 group channels (max
      // wins) + the dm; the scheduler's orch cursor sits under agent_id
      // 'scheduler' (the v17 SCHEDULER_READ_KEY convention).
      sqlite.run(
        `INSERT INTO channel_reads (channel_id, agent_id, last_read_msg_id, updated_at) VALUES ('tA1', 'a1', 3, '${ts}')`
      )
      sqlite.run(
        `INSERT INTO channel_reads (channel_id, agent_id, last_read_msg_id, updated_at) VALUES ('aA1', 'a1', 4, '${ts}')`
      )
      sqlite.run(
        `INSERT INTO channel_reads (channel_id, agent_id, last_read_msg_id, updated_at) VALUES ('dm1', 'a1', 5, '${ts}')`
      )
      sqlite.run(
        `INSERT INTO channel_reads (channel_id, agent_id, last_read_msg_id, updated_at) VALUES ('sdm', 'scheduler', 6, '${ts}')`
      )

      // Attachments: one in announce (merges into team:ch-1), one in the DM,
      // one on the recap row (deleted with the digest mechanism) — with
      // their on-disk v17 directories.
      sqlite.run(
        `INSERT INTO channel_files (id, message_id, channel_id, filename, size, created_at) VALUES ('f1', 2, 'aA1', 'remote.md', 8, '${ts}')`
      )
      sqlite.run(
        `INSERT INTO channel_files (id, message_id, channel_id, filename, size, created_at) VALUES ('f2', 5, 'dm1', 'dump.bin', 10, '${ts}')`
      )
      sqlite.run(
        `INSERT INTO channel_files (id, message_id, channel_id, filename, size, created_at) VALUES ('f3', 7, 'tA1', 'gone.txt', 3, '${ts}')`
      )
      const fileRoot = join(dir, "channel-files")
      mkdirSync(join(fileRoot, "aA1", "2"), { recursive: true })
      writeFileSync(join(fileRoot, "aA1", "2", "remote.md"), "libc2.35")
      mkdirSync(join(fileRoot, "dm1", "5"), { recursive: true })
      writeFileSync(join(fileRoot, "dm1", "5", "dump.bin"), "0123456789")
      mkdirSync(join(fileRoot, "tA1", "7"), { recursive: true })
      writeFileSync(join(fileRoot, "tA1", "7", "gone.txt"), "x")
      sqlite.close()

      // --- run the real boot path: pending 0012 + file reconciliation ----
      const boot = createDatabase(dir)
      try {
        expect(
          (
            boot.sqlite.query("PRAGMA user_version").get() as {
              user_version: number
            }
          ).user_version
        ).toBe(SCHEMA_VERSION)

        // The channels directory table is GONE.
        const tables = new Set(
          (
            boot.sqlite
              .query(`SELECT name FROM sqlite_master WHERE type = 'table'`)
              .all() as Array<{ name: string }>
          ).map((row) => row.name)
        )
        expect(tables.has("channels")).toBe(false)

        // Messages: derived keys; #announce folded into #team with the
        // global id order intact; recap rows deleted; the event-scope
        // scheduler DM became orch:<eventId>.
        const msgs = boot.sqlite
          .query(`SELECT * FROM channel_messages ORDER BY id`)
          .all() as Array<Record<string, unknown>>
        expect(msgs.map((m) => [m.id, m.channel_key])).toEqual([
          [1, "team:ch-1"],
          [2, "team:ch-1"],
          [3, "team:ch-1"],
          [4, "team:ch-1"],
          [5, "dm:a1"],
          [6, "orch:evt-1"],
          [8, "team:ch-2"],
        ])
        expect(
          msgs.filter((m) => m.body === "recap snapshot")
        ).toHaveLength(0)
        // Author snapshots + meta carried verbatim (no kind column left).
        expect("kind" in msgs[0]!).toBe(false)
        expect(msgs[0]!.author_name).toBe("Solver a1 · run-runA")

        // Read cursors: re-keyed onto derived keys, team/announce merged
        // to MAX; the scheduler reader row keeps 'scheduler'.
        const reads = boot.sqlite
          .query(`SELECT * FROM channel_reads ORDER BY channel_key`)
          .all() as Array<Record<string, unknown>>
        expect(reads).toEqual([
          {
            channel_key: "dm:a1",
            reader_key: "a1",
            last_read_msg_id: 5,
            updated_at: ts,
          },
          {
            channel_key: "orch:evt-1",
            reader_key: "scheduler",
            last_read_msg_id: 6,
            updated_at: ts,
          },
          {
            channel_key: "team:ch-1",
            reader_key: "a1",
            last_read_msg_id: 4,
            updated_at: ts,
          },
        ])

        // Files: channel_id column gone; the recap attachment dropped; the
        // on-disk dirs flattened to <messageId>/ by the boot reconcile and
        // the empty legacy channel dirs swept.
        const files = boot.sqlite
          .query(`SELECT * FROM channel_files ORDER BY id`)
          .all() as Array<Record<string, unknown>>
        expect(files.map((f) => [f.id, f.message_id, f.filename])).toEqual([
          ["f1", 2, "remote.md"],
          ["f2", 5, "dump.bin"],
        ])
        expect("channel_id" in files[0]!).toBe(false)
        expect(existsSync(join(fileRoot, "2", "remote.md"))).toBe(true)
        expect(existsSync(join(fileRoot, "5", "dump.bin"))).toBe(true)
        expect(existsSync(join(fileRoot, "aA1", "2", "remote.md"))).toBe(false)
        expect(existsSync(join(fileRoot, "dm1"))).toBe(false)
        // The recap attachment's ROW is gone (deleted with the digest
        // mechanism) — its on-disk file becomes unreferenced residue and the
        // conservative sweep keeps non-empty legacy dirs (no data loss risk;
        // nothing in the DB can reach it anymore).
        expect(existsSync(join(fileRoot, "tA1", "7", "gone.txt"))).toBe(true)

        // Integrity + the AUTOINCREMENT sequence survived the table
        // recreation (the next message id stays monotonic past the recap).
        expect(
          (boot.sqlite.query(`PRAGMA foreign_key_check`).all() as unknown[])
            .length
        ).toBe(0)
        boot.sqlite.run(
          `INSERT INTO channel_messages (channel_key, author_type, author_agent_id, author_name, body, meta, created_at)
           VALUES ('team:ch-1', 'system', NULL, 'system', 'post-migration', '{}', '${ts}')`
        )
        expect(
          (
            boot.sqlite
              .query(`SELECT max(id) AS n FROM channel_messages`)
              .get() as { n: number }
          ).n
        ).toBe(9)
      } finally {
        boot.sqlite.close()
        boot.releaseLock()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
