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

/** The real migrations folder (12 entries incl. 0011). */
const realFolder = resolve(import.meta.dir, "../../drizzle")

/** Build a v16 database in `dir`: apply migrations 0000–0010 from a
 * truncated journal copy (the exact runtime migrator path, minus 0011). */
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

describe("migration 0011 — v17 challenge-scope channels (docs/im-channels.md §11.6)", () => {
  test("v16 run-scope team/announce merge into per-challenge canonical channels with history, cursors, attribution and files intact", () => {
    const dir = mkdtempSync(join(tmpdir(), "aegisx-mig0011-"))
    try {
      const sqlite = buildV16Database(dir)
      const ts = "2025-01-01T00:00:00.000Z"

      // --- v16 seed: two runs on ch-1, one on ch-2 (isolation check) ------
      // Parents via raw SQL (the v16 channels tables predate challenge_id —
      // the current drizzle schema cannot touch them).
      sqlite.run(`PRAGMA foreign_keys = ON`)
      sqlite.run(
        `INSERT INTO events (id, name, created_at, updated_at) VALUES ('evt-1', 'e', '${ts}', '${ts}')`
      )
      sqlite.run(
        `INSERT INTO challenges (id, event_id, name, description, created_at, updated_at) VALUES ('ch-1', 'evt-1', 'c1', 'd', '${ts}', '${ts}')`
      )
      sqlite.run(
        `INSERT INTO challenges (id, event_id, name, description, created_at, updated_at) VALUES ('ch-2', 'evt-1', 'c2', 'd', '${ts}', '${ts}')`
      )
      const insertRun = (id: string, challengeId: string) =>
        sqlite.run(
          `INSERT INTO runs (id, scope_type, event_id, challenge_id, params, status, model, image, cpus, memory_mb, pids_limit, container_name, workspace_path, session_dir, source, created_at, started_at, updated_at)
           VALUES ('${id}', 'challenge', 'evt-1', '${challengeId}', '{}', 'closed', 'm:off', 'img', 1, 512, 64, 'c-${id}', 'w', 's', 'manual', '${ts}', '${ts}', '${ts}')`
        )
      insertRun("runA", "ch-1")
      insertRun("runB", "ch-1")
      insertRun("runC", "ch-2")
      const insertAgent = (id: string, runId: string) =>
        sqlite.run(
          `INSERT INTO agents (id, run_id, slot, role, is_entry, model, system_prompt, tools, status, created_at, updated_at, name)
           VALUES ('${id}', '${runId}', 'solver', 'solver', 1, 'm:off', 'sp', '[]', 'idle', '${ts}', '${ts}', '${id}')`
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
           VALUES ('${id}', '${scope}', ${runId ? `'${runId}'` : "NULL"}, 'evt-1', '${kind}', ${target ? `'${target}'` : "NULL"}, '${ts}')`
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
           VALUES (${id}, '${channelId}', 'text', '${authorType}', ${authorAgentId ? `'${authorAgentId}'` : "NULL"}, '${authorName}', '${body}', '{}', '${ts}')`
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
        `INSERT INTO channel_reads (channel_id, agent_id, last_read_msg_id, updated_at) VALUES ('tA1', 'a1', 3, '${ts}')`
      )
      sqlite.run(
        `INSERT INTO channel_reads (channel_id, agent_id, last_read_msg_id, updated_at) VALUES ('tA1', 'a2', 1, '${ts}')`
      )
      sqlite.run(
        `INSERT INTO channel_reads (channel_id, agent_id, last_read_msg_id, updated_at) VALUES ('tB1', 'a2', 4, '${ts}')`
      )
      sqlite.run(
        `INSERT INTO channel_reads (channel_id, agent_id, last_read_msg_id, updated_at) VALUES ('dm1', 'a1', 7, '${ts}')`
      )

      // Attachments: one in a to-be-merged channel (tB1), one in the DM
      // (must stay put) — with their on-disk v16 directories.
      sqlite.run(
        `INSERT INTO channel_files (id, message_id, channel_id, filename, size, created_at) VALUES ('f1', 4, 'tB1', 'dump.bin', 10, '${ts}')`
      )
      sqlite.run(
        `INSERT INTO channel_files (id, message_id, channel_id, filename, size, created_at) VALUES ('f2', 8, 'dm1', 'note.txt', 5, '${ts}')`
      )
      const fileRoot = join(dir, "channel-files")
      mkdirSync(join(fileRoot, "tB1", "4"), { recursive: true })
      writeFileSync(join(fileRoot, "tB1", "4", "dump.bin"), "0123456789")
      mkdirSync(join(fileRoot, "dm1", "8"), { recursive: true })
      writeFileSync(join(fileRoot, "dm1", "8", "note.txt"), "hello")
      sqlite.close()

      // --- run the real boot path: pending 0011 + file reconciliation -----
      const boot = createDatabase(dir)
      try {
        expect(
          (
            boot.sqlite.query("PRAGMA user_version").get() as {
              user_version: number
            }
          ).user_version
        ).toBe(SCHEMA_VERSION)

        const channelsRows = boot.sqlite
          .query(`SELECT * FROM channels ORDER BY id`)
          .all() as Array<Record<string, unknown>>
        const byId = new Map(channelsRows.map((c) => [String(c.id), c]))
        // Canonical per (challenge, kind); the losing rows are GONE.
        expect([...byId.keys()].sort()).toEqual([
          "aA1",
          "dm1",
          "sdm",
          "tA1",
          "tC1",
        ])
        expect(byId.has("tB1")).toBe(false)
        expect(byId.has("aB1")).toBe(false)
        expect(byId.get("tA1")).toMatchObject({
          scope_type: "challenge",
          run_id: null,
          challenge_id: "ch-1",
          kind: "team",
        })
        expect(byId.get("aA1")).toMatchObject({
          scope_type: "challenge",
          challenge_id: "ch-1",
          kind: "announce",
        })
        // DMs + the scheduler DM are untouched.
        expect(byId.get("dm1")).toMatchObject({
          scope_type: "run",
          run_id: "runA",
        })
        expect(byId.get("sdm")).toMatchObject({
          scope_type: "event",
          run_id: null,
        })
        expect(byId.get("tC1")).toMatchObject({
          scope_type: "challenge",
          challenge_id: "ch-2",
        })

        // Messages: re-pointed at the canonical channel, GLOBAL id order
        // preserved (tA1/tB1 interleave → [1,2,3,4,10] on tA1 in id order).
        const msgs = boot.sqlite
          .query(`SELECT * FROM channel_messages ORDER BY id`)
          .all() as Array<Record<string, unknown>>
        expect(msgs.map((m) => [m.channel_id, m.id])).toEqual([
          ["tA1", 1],
          ["tA1", 2],
          ["tA1", 3],
          ["tA1", 4],
          ["aA1", 5],
          ["aA1", 6],
          ["dm1", 7],
          ["dm1", 8],
          ["sdm", 9],
          ["tA1", 10],
          ["tC1", 11],
        ])
        // Author snapshots: agent posts in merged group channels get the run
        // suffix (from the OLD channel's run); user/system and DM/scheduler
        // rows are untouched.
        const nameOf = (id: number) =>
          msgs.find((m) => m.id === id)!.author_name
        expect(nameOf(1)).toBe("Solver a1 · run-runA")
        expect(nameOf(2)).toBe("Solver a2 · run-runB")
        expect(nameOf(10)).toBe("Solver a1 · run-runA")
        expect(nameOf(3)).toBe("用户")
        expect(nameOf(4)).toBe("system")
        expect(nameOf(8)).toBe("Solver a1") // DM: no suffix
        expect(nameOf(9)).toBe("Scheduler") // scheduler DM (run NULL): no suffix

        // Read cursors: re-pointed + MAX-merged per (canonical, agent).
        const reads = boot.sqlite
          .query(`SELECT * FROM channel_reads ORDER BY agent_id, channel_id`)
          .all() as Array<Record<string, unknown>>
        expect(reads).toEqual([
          {
            channel_id: "dm1",
            agent_id: "a1",
            last_read_msg_id: 7,
            updated_at: ts,
          },
          {
            channel_id: "tA1",
            agent_id: "a1",
            last_read_msg_id: 3,
            updated_at: ts,
          },
          {
            channel_id: "tA1",
            agent_id: "a2",
            last_read_msg_id: 4,
            updated_at: ts,
          },
        ])

        // Files: the DB row re-points at the canonical channel AND the disk
        // directory followed (boot-time reconciliation); the DM file stays.
        const files = boot.sqlite
          .query(`SELECT * FROM channel_files ORDER BY id`)
          .all() as Array<Record<string, unknown>>
        expect(files.map((f) => [f.id, f.channel_id, f.message_id])).toEqual([
          ["f1", "tA1", 4],
          ["f2", "dm1", 8],
        ])
        expect(existsSync(join(fileRoot, "tA1", "4", "dump.bin"))).toBe(true)
        expect(existsSync(join(fileRoot, "tB1", "4", "dump.bin"))).toBe(false)
        expect(existsSync(join(fileRoot, "dm1", "8", "note.txt"))).toBe(true)

        // Integrity: FK graph clean, and the AUTOINCREMENT sequence survived
        // the table recreation (the next message id stays monotonic).
        expect(
          (boot.sqlite.query(`PRAGMA foreign_key_check`).all() as unknown[])
            .length
        ).toBe(0)
        boot.sqlite.run(
          `INSERT INTO channel_messages (channel_id, kind, author_type, author_agent_id, author_name, body, meta, created_at)
           VALUES ('tA1', 'text', 'system', NULL, 'system', 'post-migration', '{}', '${ts}')`
        )
        expect(
          (
            boot.sqlite
              .query(`SELECT max(id) AS n FROM channel_messages`)
              .get() as { n: number }
          ).n
        ).toBe(12)
      } finally {
        boot.sqlite.close()
        boot.releaseLock()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
