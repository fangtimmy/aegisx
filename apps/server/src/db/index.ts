import { Database as SqliteDatabase } from "bun:sqlite"
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { basename, join, resolve } from "node:path"

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
      throw new Error("AegisX data directory is already in use")
    }
    try {
      process.kill(pid, 0)
      throw new Error("AegisX data directory is already in use")
    } catch (probeError) {
      if (
        probeError instanceof Error &&
        probeError.message.includes("already in use")
      ) {
        throw probeError
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
    .query(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`
    )
    .all() as Array<{ name: string }>
  return new Set(rows.map((row) => row.name))
}

export type DbClassification =
  | { kind: "fresh" }
  | { kind: "recognized" }
  | { kind: "preBaseline" }
  | { kind: "newerThanBinary"; userVersion: number }

/**
 * Classify an existing database by its structural markers. Drives the
 * open/migrate decision in createDatabase:
 *
 *  - fresh: no tables → bootstrap via migrate (every migration from scratch).
 *  - recognized: has the drizzle migration-tracking table → on the migration
 *    track; migrate applies pending migrations forward (data-preserving).
 *  - preBaseline: has tables but no drizzle tracking → predates the migration
 *    system (schema v1–v5); cannot be migrated in place, refuse.
 *  - newerThanBinary: user_version ahead of this binary → downgrade, refuse.
 *
 * user_version is NOT a correctness gate for recognized databases — drizzle's
 * migration journal is the source of truth. user_version only feeds the
 * newer-than-binary guard (set after every migrate) and a quick
 * `PRAGMA user_version` inspection handle.
 */
export function classifyDatabaseState(
  tables: Set<string>,
  userVersion: number,
  schemaVersion: number
): DbClassification {
  if (tables.size === 0) return { kind: "fresh" }
  if (userVersion > schemaVersion)
    return { kind: "newerThanBinary", userVersion }
  if (!tables.has("__drizzle_migrations")) return { kind: "preBaseline" }
  return { kind: "recognized" }
}

/** Number of migrations the binary knows about, from the drizzle journal. */
function readJournalMigrationCount(migrationsFolder: string): number {
  try {
    const journal = JSON.parse(
      readFileSync(join(migrationsFolder, "meta", "_journal.json"), "utf8")
    ) as { entries?: unknown[] }
    return Array.isArray(journal.entries) ? journal.entries.length : 0
  } catch {
    return 0
  }
}

/** Pure pending-count: journal migrations not yet recorded as applied. */
export function pendingMigrationCount(
  knownMigrations: number,
  appliedMigrations: number
): number {
  return Math.max(0, knownMigrations - appliedMigrations)
}

/**
 * Snapshot aegisx.sqlite to a timestamped sibling after flushing the WAL, so a
 * failed migration can be rolled back. Returns the backup path, or null when
 * nothing is pending to guard (no copy is made).
 */
function backupDatabase(
  sqlite: SqliteDatabase,
  dataDir: string,
  pending: number
): string | null {
  if (pending <= 0) return null
  sqlite.run("PRAGMA wal_checkpoint(TRUNCATE)")
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const dst = join(dataDir, `aegisx.sqlite.bak-${stamp}`)
  copyFileSync(join(dataDir, "aegisx.sqlite"), dst)
  console.warn(
    `Migrating database (${pending} pending); backup → ${basename(dst)}`
  )
  return dst
}

export function createDatabase(dataDir: string) {
  mkdirSync(dataDir, { recursive: true })
  const releaseLock = acquireDataDirLock(dataDir)
  try {
    const dbPath = join(dataDir, "aegisx.sqlite")
    const sqlite = new SqliteDatabase(dbPath, { create: true })
    sqlite.run("PRAGMA busy_timeout = 5000")
    sqlite.run("PRAGMA foreign_keys = ON")
    sqlite.run("PRAGMA journal_mode = WAL")

    const tables = tableNames(sqlite)
    const userVersion = (
      sqlite.query("PRAGMA user_version").get() as { user_version: number }
    ).user_version
    const classification = classifyDatabaseState(
      tables,
      userVersion,
      SCHEMA_VERSION
    )
    if (classification.kind === "newerThanBinary") {
      throw new Error(
        `Database schema version ${userVersion} is newer than this binary (${SCHEMA_VERSION}). Downgrade is not supported; run a newer AegisX.`
      )
    }
    if (classification.kind === "preBaseline") {
      throw new Error(
        [
          "This database predates the migration system (schema v1–v5) and cannot be migrated in place.",
          `Back it up, then remove it and restart to bootstrap fresh at v${SCHEMA_VERSION}.`,
          "Example: mv data/aegisx.sqlite data/aegisx.sqlite.old",
        ].join(" ")
      )
    }

    // Back up only when migrations are actually pending — a fresh DB or an
    // already-current DB copies nothing.
    let backupPath: string | null = null
    if (classification.kind === "recognized") {
      const known = readJournalMigrationCount(migrationsFolder)
      const applied = (
        sqlite
          .query("SELECT count(*) AS n FROM __drizzle_migrations")
          .get() as { n: number }
      ).n
      backupPath = backupDatabase(
        sqlite,
        dataDir,
        pendingMigrationCount(known, applied)
      )
    }

    const db = drizzle({ client: sqlite, schema })
    try {
      migrate(db, { migrationsFolder })
    } catch (error) {
      // A failed migration can leave the DB half-applied. Restore the
      // pre-migration snapshot so the next startup retries cleanly.
      if (backupPath) {
        sqlite.close()
        copyFileSync(backupPath, dbPath)
        for (const ext of ["-wal", "-shm"]) {
          try {
            unlinkSync(join(dataDir, `aegisx.sqlite${ext}`))
          } catch {
            // best-effort; the files may not exist
          }
        }
      }
      throw new Error(
        `Database migration failed${
          backupPath ? `; restored from ${basename(backupPath)}` : ""
        }: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    sqlite.run(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    return { db, sqlite, releaseLock }
  } catch (error) {
    releaseLock()
    throw error
  }
}

/** The drizzle db handle type, exported once so services/tests stop repeating
 * `ReturnType<typeof createDatabase>["db"]` (8+ local aliases drifted). */
export type Database = ReturnType<typeof createDatabase>["db"]
