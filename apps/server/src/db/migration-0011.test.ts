import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import {
  cpSync,
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

/**
 * The historical chain (v16 → v17 → v18) through the real migrator.
 * Migration 0011 merges v16's per-run team/announce channels into
 * per-challenge canonicals (min channel id, run-suffix author snapshots,
 * cursor max-merge); migration 0012 then maps those onto derived keys.
 * The chain stops at v18 (a truncated journal — the production boot now
 * continues into 0013's destructive rebuild, covered separately).
 */
const realFolder = resolve(import.meta.dir, "../../drizzle")

/** Build a v16 database in `dir`: apply migrations 0000–0010 from a
 * truncated journal copy (the exact runtime migrator path). The caller
 * seeds v16 state, then `upgradeToV18` applies 0011+0012. */
function buildV16Database(dir: string) {
  const sqlite = new Database(join(dir, "aegisx.sqlite"), { create: true })
  sqlite.run("PRAGMA journal_mode = WAL")
  const folder = join(dir, "mig-v16")
  mkdirSync(join(folder, "meta"), { recursive: true })
  const journal = JSON.parse(
    readFileSync(join(realFolder, "meta", "_journal.json"), "utf8")
  ) as { entries: Array<{ tag: string }> }
  journal.entries = journal.entries.slice(0, 11) // 0000–0010 = v16
  writeFileSync(join(folder, "meta", "_journal.json"), JSON.stringify(journal))
  for (const entry of journal.entries) {
    cpSync(
      join(realFolder, `${entry.tag}.sql`),
      join(folder, `${entry.tag}.sql`)
    )
  }
  migrate(drizzle(sqlite), { migrationsFolder: folder })
  sqlite.run("PRAGMA user_version = 16")
  return sqlite
}

/** Upgrade a seeded v16 database to v18 in place: extend the journal copy
 * with 0011+0012 and re-run the migrator (same path the runtime takes). */
function upgradeToV18(dir: string, sqlite: Database) {
  const folder = join(dir, "mig-v16")
  const journal = JSON.parse(
    readFileSync(join(realFolder, "meta", "_journal.json"), "utf8")
  ) as { entries: Array<{ tag: string }> }
  journal.entries = journal.entries.slice(0, 13) // 0000–0012 = v18
  writeFileSync(join(folder, "meta", "_journal.json"), JSON.stringify(journal))
  for (const entry of journal.entries.slice(11)) {
    cpSync(
      join(realFolder, `${entry.tag}.sql`),
      join(folder, `${entry.tag}.sql`)
    )
  }
  migrate(drizzle(sqlite), { migrationsFolder: folder })
  sqlite.run("PRAGMA user_version = 18")
}

describe("migration 0011+0012 — v16 run-scope channels map onto v18 derived keys", () => {
  test("per-run team/announce merge (order, suffixes, cursors) then re-key onto derived keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "aegisx-mig0011-"))
    try {
      const sqlite = buildV16Database(dir)
      const ts = "2025-01-01T00:00:00.000Z"

      // --- v16 seed: two runs on ch-1, one on ch-2 (isolation check) ------
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
      const insertRun = (id: string, challengeId: string) =>
        sqlite.run(
          `INSERT INTO runs (id, scope_type, event_id, challenge_id, params, status, model, image, cpus, memory_mb, pids_limit, container_name, workspace_path, session_dir, source, created_at, started_at, updated_at)
           VALUES (?, 'challenge', 'evt-1', ?, '{}', 'closed', 'm:off', 'img', 1, 512, 64, ?, 'w', 's', 'manual', ?, ?, ?)`,
          [id, challengeId, `c-${id}`, ts, ts, ts]
        )
      insertRun("runA", "ch-1")
      insertRun("runB", "ch-1")
      insertRun("runC", "ch-2")
      const insertAgent = (id: string, runId: string) =>
        sqlite.run(
          `INSERT INTO agents (id, run_id, slot, role, is_entry, model, system_prompt, tools, status, created_at, updated_at, name)
           VALUES (?, ?, 'solver', 'solver', 1, 'm:off', 'sp', '[]', 'idle', ?, ?, ?)`,
          [id, runId, ts, ts, id]
        )
      insertAgent("a1", "runA")
      insertAgent("a2", "runB")

      // v16 channels: run-scope team/announce per run + a solver DM + the
      // event scheduler DM (run_id NULL).
      const insertChannel = (
        id: string,
        scope: string,
        runId: string | null,
        kind: string,
        target: string | null
      ) =>
        sqlite.run(
          `INSERT INTO channels (id, scope_type, run_id, event_id, kind, target_agent_id, created_at)
           VALUES (?, ?, ?, 'evt-1', ?, ?, ?)`,
          [id, scope, runId, kind, target, ts]
        )
      insertChannel("tA1", "run", "runA", "team", null) // canonical (min id)
      insertChannel("aA1", "run", "runA", "announce", null) // canonical
      insertChannel("tB1", "run", "runB", "team", null) // merged into tA1
      insertChannel("aB1", "run", "runB", "announce", null) // merged into aA1
      insertChannel("tC1", "run", "runC", "team", null) // other challenge
      insertChannel("dm1", "run", "runA", "dm", "a1")
      insertChannel("sdm", "event", null, "dm", "sched")

      // Interleaved message history across both runs' team channels — ids
      // are globally monotonic; the merge must preserve that order.
      const insertMessage = (
        id: number,
        channelId: string,
        authorType: string,
        authorAgentId: string | null,
        authorName: string,
        body: string
      ) =>
        sqlite.run(
          `INSERT INTO channel_messages (id, channel_id, kind, author_type, author_agent_id, author_name, body, meta, created_at)
           VALUES (?, ?, 'text', ?, ?, ?, ?, '{}', ?)`,
          [id, channelId, authorType, authorAgentId, authorName, body, ts]
        )
      insertMessage(1, "tA1", "agent", "a1", "Solver a1", "finding A1")
      insertMessage(2, "tB1", "agent", "a2", "Solver a2", "finding B1")
      insertMessage(3, "tA1", "user", null, "用户", "note A")
      insertMessage(4, "tB1", "system", null, "system", "sys B")
      insertMessage(5, "aA1", "system", null, "system", "announce A")
      insertMessage(6, "aB1", "system", null, "system", "announce B")
      insertMessage(7, "dm1", "user", null, "用户", "dm msg")
      insertMessage(8, "dm1", "agent", "a1", "Solver a1", "dm agent reply")
      insertMessage(9, "sdm", "agent", "sched", "Scheduler", "scheduler dm")
      insertMessage(10, "tA1", "agent", "a1", "Solver a1", "finding A2")
      insertMessage(11, "tC1", "system", null, "system", "other challenge")

      // Read cursors: a1 on tA1; a2 on BOTH merged channels (max wins).
      sqlite.run(
        `INSERT INTO channel_reads (channel_id, agent_id, last_read_msg_id, updated_at) VALUES ('tA1', 'a1', 3, ?)`,
        [ts]
      )
      sqlite.run(
        `INSERT INTO channel_reads (channel_id, agent_id, last_read_msg_id, updated_at) VALUES ('tA1', 'a2', 1, ?)`,
        [ts]
      )
      sqlite.run(
        `INSERT INTO channel_reads (channel_id, agent_id, last_read_msg_id, updated_at) VALUES ('tB1', 'a2', 4, ?)`,
        [ts]
      )
      sqlite.run(
        `INSERT INTO channel_reads (channel_id, agent_id, last_read_msg_id, updated_at) VALUES ('dm1', 'a1', 7, ?)`,
        [ts]
      )

      // Attachments: one in a to-be-merged channel (tB1), one in the DM
      // (must stay put).
      sqlite.run(
        `INSERT INTO channel_files (id, message_id, channel_id, filename, size, created_at) VALUES ('f1', 4, 'tB1', 'dump.bin', 10, ?)`,
        [ts]
      )
      sqlite.run(
        `INSERT INTO channel_files (id, message_id, channel_id, filename, size, created_at) VALUES ('f2', 8, 'dm1', 'note.txt', 5, ?)`,
        [ts]
      )
      upgradeToV18(dir, sqlite)

      // --- the upgraded v18 database ------------------------------------
      {
        // The channels directory table is gone (v18 end state).
        const tables = new Set(
          (
            sqlite
              .query(`SELECT name FROM sqlite_master WHERE type = 'table'`)
              .all() as Array<{ name: string }>
          ).map((row) => row.name)
        )
        expect(tables.has("channels")).toBe(false)

        // Messages: BOTH merges compose — run-scope tA1/tB1 interleave AND
        // the announce rows fold into the same team:ch-1, all in global id
        // order. The scheduler DM became orch:<eventId>.
        const msgs = sqlite
          .query(`SELECT * FROM channel_messages ORDER BY id`)
          .all() as Array<Record<string, unknown>>
        expect(msgs.map((m) => [m.id, m.channel_key])).toEqual([
          [1, "team:ch-1"],
          [2, "team:ch-1"],
          [3, "team:ch-1"],
          [4, "team:ch-1"],
          [5, "team:ch-1"],
          [6, "team:ch-1"],
          [7, "dm:a1"],
          [8, "dm:a1"],
          [9, "orch:evt-1"],
          [10, "team:ch-1"],
          [11, "team:ch-2"],
        ])

        // Author snapshots: 0011 stamped the run suffix on agent posts in
        // the merged group channels (from the OLD channel's run); user and
        // system rows and DM rows are untouched.
        const nameOf = (id: number) =>
          msgs.find((m) => m.id === id)!.author_name
        expect(nameOf(1)).toBe("Solver a1 · run-runA")
        expect(nameOf(2)).toBe("Solver a2 · run-runB")
        expect(nameOf(10)).toBe("Solver a1 · run-runA")
        expect(nameOf(3)).toBe("用户")
        expect(nameOf(4)).toBe("system")
        expect(nameOf(8)).toBe("Solver a1") // DM: no suffix
        expect(nameOf(9)).toBe("Scheduler") // scheduler DM (run NULL): no suffix

        // Read cursors: re-keyed onto derived keys; a2's two merged cursors
        // collapsed to MAX across the whole composed chain.
        const reads = sqlite
          .query(`SELECT * FROM channel_reads ORDER BY reader_key, channel_key`)
          .all() as Array<Record<string, unknown>>
        expect(reads).toEqual([
          {
            channel_key: "dm:a1",
            reader_key: "a1",
            last_read_msg_id: 7,
            updated_at: ts,
          },
          {
            channel_key: "team:ch-1",
            reader_key: "a1",
            last_read_msg_id: 3,
            updated_at: ts,
          },
          {
            channel_key: "team:ch-1",
            reader_key: "a2",
            last_read_msg_id: 4,
            updated_at: ts,
          },
        ])

        // Files: rows survive with the channel_id column gone.
        const files = sqlite
          .query(`SELECT * FROM channel_files ORDER BY id`)
          .all() as Array<Record<string, unknown>>
        expect(files.map((f) => [f.id, f.message_id])).toEqual([
          ["f1", 4],
          ["f2", 8],
        ])
        expect("channel_id" in files[0]!).toBe(false)

        // Integrity: FK graph clean, and the AUTOINCREMENT sequence survived
        // both table recreations (the next message id stays monotonic).
        expect(
          (sqlite.query(`PRAGMA foreign_key_check`).all() as unknown[]).length
        ).toBe(0)
        sqlite.run(
          `INSERT INTO channel_messages (channel_key, author_type, author_agent_id, author_name, body, meta, created_at)
           VALUES ('team:ch-1', 'system', NULL, 'system', 'post-migration', '{}', ?)`,
          [ts]
        )
        expect(
          (
            sqlite.query(`SELECT max(id) AS n FROM channel_messages`).get() as {
              n: number
            }
          ).n
        ).toBe(12)
      }
      sqlite.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
