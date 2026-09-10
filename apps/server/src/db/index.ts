import { Database as SqliteDatabase } from "bun:sqlite"
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { drizzle } from "drizzle-orm/bun-sqlite"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"

import * as schema from "./schema"
import { SCHEMA_VERSION } from "./schema"

const migrationsFolder = resolve(import.meta.dir, "../../drizzle")

function acquireDataDirLock(dataDir: string) {
  const path = join(dataDir, "aegisx.lock")
  const owner = String(process.pid)
  try {
    writeFileSync(path, owner, { encoding: "utf8", flag: "wx" })
  } catch (error) {
    if (!(error instanceof Error) || !String(error).includes("EEXIST")) {
      throw error
    }
    let existing = ""
    try {
      existing = readFileSync(path, "utf8").trim()
    } catch {
      throw new Error("AegisX data directory is already in use")
    }
    const pid = Number(existing)
    if (!Number.isInteger(pid) || pid <= 0) {
      throw new Error("AegisX data directory is already in use", {
        cause: error,
      })
    }
    try {
      process.kill(pid, 0)
      throw new Error("AegisX data directory is already in use", {
        cause: error,
      })
    } catch (probeError) {
      if (
        probeError instanceof Error &&
        probeError.message.includes("already in use")
      ) {
        throw probeError
      }
      if (
        probeError instanceof Error &&
        "code" in probeError &&
        probeError.code === "EPERM"
      ) {
        // The pid exists but signals are denied — a live owner.
        throw new Error("AegisX data directory is already in use", {
          cause: probeError,
        })
      }
      unlinkSync(path)
      writeFileSync(path, owner, { encoding: "utf8", flag: "wx" })
    }
  }
  return () => {
    try {
      if (readFileSync(path, "utf8").trim() === owner) unlinkSync(path)
    } catch {
      // The data directory may have been removed during test cleanup.
    }
  }
}

function tableNames(sqlite: SqliteDatabase): Set<string> {
  const rows = sqlite
    .query<{ name: string }, []>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`
    )
    .all()
  return new Set(rows.map((row) => row.name))
}

/**
 * Open-time negotiation between a data directory and this binary. There is no
 * upgrade path: the migration folder holds a single baseline (the full DDL of
 * the current schema), applied only to an empty database.
 *
 *  - fresh: no tables → apply the baseline, stamp user_version, open.
 *  - current: user_version == SCHEMA_VERSION → open as-is (no migrations run).
 *  - stale: user_version < SCHEMA_VERSION (any pre-baseline database) → hard
 *    fail. Old databases are never upgraded or silently rewritten; the user
 *    backs up and starts a fresh data directory.
 *  - newer: user_version > SCHEMA_VERSION → hard fail (downgrade unsupported).
 *
 * user_version is the single gate: it is stamped right after the baseline
 * lands, so it exactly distinguishes "created by this schema" from everything
 * else.
 */
export function createDatabase(dataDir: string) {
  mkdirSync(dataDir, { recursive: true })
  const releaseLock = acquireDataDirLock(dataDir)
  try {
    const dbPath = join(dataDir, "aegisx.sqlite")
    const sqlite = new SqliteDatabase(dbPath, { create: true })
    sqlite.run("PRAGMA busy_timeout = 5000")
    sqlite.run("PRAGMA foreign_keys = ON")
    sqlite.run("PRAGMA journal_mode = WAL")

    const userVersion = sqlite
      .query<{ user_version: number }, []>("PRAGMA user_version")
      .get()!.user_version
    if (tableNames(sqlite).size === 0) {
      // Fresh: the baseline builds the whole schema; stamp the version so the
      // next boot classifies the database as current.
      const db = drizzle({ client: sqlite, schema })
      try {
        migrate(db, { migrationsFolder })
      } catch (error) {
        throw new Error(
          `Database baseline migration failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error }
        )
      }
      sqlite.run(`PRAGMA user_version = ${SCHEMA_VERSION}`)
      return { db, sqlite, releaseLock }
    }
    if (userVersion > SCHEMA_VERSION) {
      throw new Error(
        `Database schema version ${userVersion} is newer than this binary (${SCHEMA_VERSION}). Downgrade is not supported; run a newer AegisX.`
      )
    }
    if (userVersion < SCHEMA_VERSION) {
      throw new Error(
        [
          `Database schema version ${userVersion} is older than this binary (v${SCHEMA_VERSION}); old databases have no upgrade path.`,
          `Back up anything you need, then point AEGISX_DATA_DIR at a new directory or delete aegisx.sqlite to start fresh.`,
          `Example: mv data data.old-${userVersion}`,
        ].join(" ")
      )
    }
    const db = drizzle({ client: sqlite, schema })
    return { db, sqlite, releaseLock }
  } catch (error) {
    releaseLock()
    throw error
  }
}

/** The drizzle db handle type, exported once so services/tests stop repeating
 * `ReturnType<typeof createDatabase>["db"]` (8+ local aliases drifted). */
export type Database = ReturnType<typeof createDatabase>["db"]
