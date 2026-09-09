import { describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createDatabase } from "./index"
import { buildLegacyDatabase } from "./migration-fixtures"
import { SCHEMA_VERSION } from "./schema"

/** The v18 state that 0013's destructive rebuild starts from. */
const buildV18Database = (dir: string) =>
  buildLegacyDatabase(dir, { entries: 13, version: 18 })

describe("migration 0013 — v19 challenge-centric (destructive; old execution data dropped)", () => {
  test("runs/agents/queue/channel tables rebuilt empty; spawn_queue append shape; preserved tables untouched; legacy dirs swept", () => {
    const dir = mkdtempSync(join(tmpdir(), "aegisx-mig0013-"))
    try {
      const sqlite = buildV18Database(dir)
      const ts = "2025-01-01T00:00:00.000Z"

      // --- v18 seed ------------------------------------------------------
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
        `INSERT INTO scheduler_config (event_id, instruction, max_concurrent_targets, paused, created_at, updated_at) VALUES ('evt-1', 'hint', 2, 0, ?, ?)`,
        [ts, ts]
      )
      sqlite.run(
        `INSERT INTO queue_state (event_id, status, updated_at) VALUES ('evt-1', 'paused', ?)`,
        [ts]
      )
      sqlite.run(
        `INSERT INTO prompt_templates (plugin, key, body, updated_at) VALUES ('builtin', 'mainSystem', 'custom-body', ?)`,
        [ts]
      )
      sqlite.run(
        `INSERT INTO runs (id, scope_type, event_id, challenge_id, params, status, model, image, cpus, memory_mb, pids_limit, container_name, workspace_path, session_dir, source, created_at, started_at, updated_at)
         VALUES ('runA', 'challenge', 'evt-1', 'ch-1', '{}', 'running', 'm:off', 'img', 1, 512, 64, 'c', 'w', 's', 'manual', ?, ?, ?)`,
        [ts, ts, ts]
      )
      sqlite.run(
        `INSERT INTO agents (id, run_id, slot, role, is_entry, model, system_prompt, tools, status, created_at, updated_at, name)
         VALUES ('a1', 'runA', 'solver-1', 'solver', 1, 'm:off', 'sp', '[]', 'running', ?, ?, 'Solver 1')`,
        [ts, ts]
      )
      sqlite.run(
        `INSERT INTO run_queue (id, event_id, ord, challenge_id, params, prompt, source, status, created_at, updated_at)
         VALUES ('q1', 'evt-1', 1, 'ch-1', '{}', 'p', 'scheduler', 'pending', ?, ?)`,
        [ts, ts]
      )
      sqlite.run(
        `INSERT INTO channel_messages (id, channel_key, author_type, author_agent_id, author_name, body, meta, created_at)
         VALUES (1, 'team:ch-1', 'agent', 'a1', 'Solver 1 · run-runA', 'finding', '{}', ?)`,
        [ts]
      )
      sqlite.run(
        `INSERT INTO channel_reads (channel_key, reader_key, last_read_msg_id, updated_at) VALUES ('team:ch-1', 'a1', 1, ?)`,
        [ts]
      )
      sqlite.run(
        `INSERT INTO channel_files (id, message_id, filename, size, created_at) VALUES ('f1', 1, 'x.txt', 3, ?)`,
        [ts]
      )
      // A manually-recorded flag (accepted) — dropped with the table.
      sqlite.run(
        `INSERT INTO challenge_flags (id, challenge_id, flag, status, source, created_at, updated_at) VALUES ('fl1', 'ch-1', 'flag{a}', 'accepted', 'manual', ?, ?)`,
        [ts, ts]
      )
      // Legacy on-disk dirs the boot sweep must remove.
      mkdirSync(join(dir, "runs", "runA"), { recursive: true })
      writeFileSync(join(dir, "runs", "runA", "solve.sh"), "echo")
      mkdirSync(join(dir, "channel-files", "1"), { recursive: true })
      writeFileSync(join(dir, "channel-files", "1", "x.txt"), "abc")
      sqlite.close()

      // --- run the real boot path: pending 0013 + legacy dir sweep -------
      const boot = createDatabase(dir)
      try {
        expect(
          boot.sqlite
            .query<
              {
                user_version: number
              },
              []
            >("PRAGMA user_version")
            .get()!.user_version
        ).toBe(SCHEMA_VERSION)

        const tables = new Set(
          boot.sqlite
            .query<{ name: string }, []>(
              `SELECT name FROM sqlite_master WHERE type = 'table'`
            )
            .all()
            .map((row) => row.name)
        )
        // The run layer is gone.
        expect(tables.has("runs")).toBe(false)
        expect(tables.has("run_queue")).toBe(false)
        expect(tables.has("channel_files")).toBe(false)
        // Rebuilt v19 tables present.
        for (const t of [
          "agents",
          "sessions",
          "session_entries",
          "spawn_queue",
          "channel_messages",
          "channel_reads",
          "challenge_flags",
        ]) {
          expect(tables.has(t)).toBe(true)
        }
        // Preserved tables present.
        for (const t of [
          "events",
          "challenges",
          "challenge_remote",
          "attachments",
          "event_platforms",
          "scheduler_config",
          "queue_state",
          "prompt_templates",
          "platform_request_log",
        ]) {
          expect(tables.has(t)).toBe(true)
        }

        // Execution + channel data dropped by design.
        for (const table of [
          "agents",
          "sessions",
          "session_entries",
          "spawn_queue",
          "channel_messages",
          "channel_reads",
          "challenge_flags",
        ]) {
          const n = boot.sqlite
            .query<
              {
                n: number
              },
              []
            >(`SELECT count(*) AS n FROM ${table}`)
            .get()!.n
          expect(n).toBe(0)
        }

        // Preserved data untouched.
        expect(
          boot.sqlite
            .query<{ instruction: string; max_concurrent_targets: number }, []>(
              `SELECT instruction, max_concurrent_targets FROM scheduler_config WHERE event_id = 'evt-1'`
            )
            .get()!
        ).toEqual({ instruction: "hint", max_concurrent_targets: 2 })
        expect(
          boot.sqlite
            .query<{ status: string }, []>(
              `SELECT status FROM queue_state WHERE event_id = 'evt-1'`
            )
            .get()!.status
        ).toBe("paused")
        expect(
          boot.sqlite
            .query<{ body: string }, []>(
              `SELECT body FROM prompt_templates WHERE key = 'mainSystem'`
            )
            .get()!.body
        ).toBe("custom-body")

        // agents v19 shape: runId/slot/is_entry/parent_agent_id/task gone;
        // event_id/challenge_id/prompt/source/deadline columns present.
        const agentCols = boot.sqlite
          .query<
            {
              name: string
            },
            []
          >(`PRAGMA table_info(agents)`)
          .all()
          .map((c) => c.name)
        for (const col of [
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
          "error",
          "summary",
        ]) {
          expect(agentCols).toContain(col)
        }
        for (const gone of [
          "run_id",
          "slot",
          "is_entry",
          "parent_agent_id",
          "task",
        ]) {
          expect(agentCols).not.toContain(gone)
        }
        // One orchestrator per event (partial unique index).
        const agentIdx = boot.sqlite
          .query<{ name: string }, []>(
            `SELECT name FROM pragma_index_list('agents') WHERE "unique" = 1`
          )
          .all()
          .map((i) => i.name)
        expect(agentIdx).toContain("agents_event_orchestrator_unique")

        // session_entries lost its run_id column.
        const entryCols = boot.sqlite
          .query<
            {
              name: string
            },
            []
          >(`PRAGMA table_info(session_entries)`)
          .all()
          .map((c) => c.name)
        expect(entryCols).not.toContain("run_id")

        // spawn_queue: append semantics (no challenge unique constraint),
        // agent_id back-fill column.
        const queueIdx = boot.sqlite
          .query<{ name: string }, []>(
            `SELECT name FROM pragma_index_list('spawn_queue')`
          )
          .all()
          .map((i) => i.name)
        expect(queueIdx.filter((name) => name.includes("challenge"))).toEqual(
          []
        )
        const queueCols = boot.sqlite
          .query<
            {
              name: string
            },
            []
          >(`PRAGMA table_info(spawn_queue)`)
          .all()
          .map((c) => c.name)
        expect(queueCols).toContain("agent_id")
        // Two pending items on the same challenge are legal (append).
        boot.sqlite.run(
          `INSERT INTO spawn_queue (id, event_id, ord, challenge_id, params, prompt, source, status, created_at, updated_at)
           VALUES ('n1', 'evt-1', 1, 'ch-1', '{}', 'a', 'scheduler', 'pending', ?, ?)`,
          [ts, ts]
        )
        boot.sqlite.run(
          `INSERT INTO spawn_queue (id, event_id, ord, challenge_id, params, prompt, source, status, created_at, updated_at)
           VALUES ('n2', 'evt-1', 2, 'ch-1', '{}', 'b', 'scheduler', 'pending', ?, ?)`,
          [ts, ts]
        )

        // challenge_flags: source check is agent|manual; agent_id plain text.
        const flagCols = boot.sqlite
          .query<
            {
              name: string
            },
            []
          >(`PRAGMA table_info(challenge_flags)`)
          .all()
          .map((c) => c.name)
        expect(flagCols).toContain("agent_id")
        expect(flagCols).not.toContain("run_id")
        expect(() =>
          boot.sqlite.run(
            `INSERT INTO challenge_flags (id, challenge_id, flag, status, source, created_at, updated_at) VALUES ('x', 'ch-1', 'f', 'accepted', 'run', ?, ?)`,
            [ts, ts]
          )
        ).toThrow()

        // v19 agents insert works end-to-end.
        boot.sqlite.run(
          `INSERT INTO agents (id, event_id, challenge_id, role, model, system_prompt, tools, status, source, prompt, created_at, updated_at)
           VALUES ('ag1', 'evt-1', 'ch-1', 'solver', 'm:off', 'sp', '[]', 'idle', 'manual', 'go', ?, ?)`,
          [ts, ts]
        )

        // The channel AUTOINCREMENT sequence restarted fresh.
        boot.sqlite.run(
          `INSERT INTO channel_messages (channel_key, author_type, author_agent_id, author_name, body, meta, created_at)
           VALUES ('team:ch-1', 'system', NULL, 'system', 'post-migration', '{}', ?)`,
          [ts]
        )
        expect(
          boot.sqlite
            .query<{ n: number }, []>(
              `SELECT max(id) AS n FROM channel_messages`
            )
            .get()!.n
        ).toBe(1)

        expect(boot.sqlite.query(`PRAGMA foreign_key_check`).all().length).toBe(
          0
        )

        // Legacy on-disk directories swept.
        expect(existsSync(join(dir, "runs"))).toBe(false)
        expect(existsSync(join(dir, "channel-files"))).toBe(false)
      } finally {
        boot.sqlite.close()
        boot.releaseLock()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
