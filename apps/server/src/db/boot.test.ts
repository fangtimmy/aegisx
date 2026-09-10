import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createDatabase } from "./index"
import { SCHEMA_VERSION } from "./schema"

/** Boot-time negotiation: fresh builds the schema, current opens untouched,
 * stale (any older database) and newer refuse. There is no upgrade path. */

function userVersionOf(dir: string): number {
  const sqlite = new Database(join(dir, "aegisx.sqlite"), { readonly: true })
  const version = sqlite
    .query<{ user_version: number }, []>("PRAGMA user_version")
    .get()!.user_version
  sqlite.close()
  return version
}

/** Count applied migrations — a reopened (current) database must not grow it. */
function appliedMigrationsOf(dir: string): number {
  const sqlite = new Database(join(dir, "aegisx.sqlite"), { readonly: true })
  const n = sqlite
    .query<{ n: number }, []>("SELECT count(*) AS n FROM __drizzle_migrations")
    .get()!.n
  sqlite.close()
  return n
}

function withDir(name: string, run: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), `aegisx-${name}-`))
  try {
    run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("createDatabase three-state negotiation", () => {
  test("fresh: the baseline builds the full schema and stamps SCHEMA_VERSION", () => {
    withDir("boot-fresh", (dir) => {
      const { db, sqlite, releaseLock } = createDatabase(dir)
      expect(userVersionOf(dir)).toBe(SCHEMA_VERSION)
      const names = new Set(
        sqlite
          .query<{ name: string }, []>(
            `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`
          )
          .all()
          .map((row) => row.name)
      )
      for (const t of [
        "events",
        "event_platforms",
        "challenges",
        "challenge_remote",
        "attachments",
        "agents",
        "sessions",
        "session_entries",
        "spawn_queue",
        "queue_state",
        "channel_messages",
        "channel_reads",
        "scheduler_config",
        "prompt_templates",
        "challenge_flags",
        "platform_request_log",
      ]) {
        expect(names.has(t)).toBe(true)
      }
      // The v19 run layer and the channels directory table stay gone.
      for (const gone of ["runs", "run_queue", "channels", "channel_files"]) {
        expect(names.has(gone)).toBe(false)
      }
      expect(appliedMigrationsOf(dir)).toBe(1)
      expect(db).toBeDefined()
      sqlite.close()
      releaseLock()
    })
  })

  test("current: a database at SCHEMA_VERSION reopens without applying migrations", () => {
    withDir("boot-current", (dir) => {
      const first = createDatabase(dir)
      first.sqlite.close()
      first.releaseLock()

      const applied = appliedMigrationsOf(dir)
      const before = userVersionOf(dir)
      const second = createDatabase(dir)
      // Nothing ran: same version, same applied count.
      expect(userVersionOf(dir)).toBe(before)
      expect(appliedMigrationsOf(dir)).toBe(applied)
      second.sqlite.close()
      second.releaseLock()
    })
  })

  test("stale: an older database is refused with recovery guidance", () => {
    withDir("boot-stale", (dir) => {
      const path = join(dir, "aegisx.sqlite")
      const sqlite = new Database(path, { create: true })
      // Any old database: our tables, a user_version below SCHEMA_VERSION.
      sqlite.run(`CREATE TABLE agents (id text PRIMARY KEY NOT NULL)`)
      sqlite.run(`PRAGMA user_version = ${SCHEMA_VERSION - 1}`)
      sqlite.close()

      expect(() => createDatabase(dir)).toThrow(/no upgrade path/)
      expect(() => createDatabase(dir)).toThrow(/aegisx\.sqlite/)
      // The refused database is left untouched (no in-place rewrite).
      expect(userVersionOf(dir)).toBe(SCHEMA_VERSION - 1)
    })
  })

  test("newer: a database ahead of the binary is refused (no downgrade)", () => {
    withDir("boot-newer", (dir) => {
      const first = createDatabase(dir)
      first.sqlite.close()
      first.releaseLock()
      const raw = new Database(join(dir, "aegisx.sqlite"))
      raw.run(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`)
      raw.close()

      expect(() => createDatabase(dir)).toThrow(/newer than this binary/)
    })
  })
})
