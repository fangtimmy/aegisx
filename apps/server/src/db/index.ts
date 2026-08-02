import { Database } from "bun:sqlite"
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

function tableNames(sqlite: Database): Set<string> {
  const rows = sqlite
    .query(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`
    )
    .all() as Array<{ name: string }>
  return new Set(rows.map((row) => row.name))
}

/**
 * v5 is a full data wipe (run lifecycle redesign: a run is a long-lived pi
 * session + container; statuses collapsed to running/idle/closed).
 * Refuse to open any older schema so operators wipe data/ instead of silent
 * corruption. Note: v4/v5 keep `agents` and `run_events` tables (they existed
 * in v1/v2 with incompatible shapes), so they are NOT used as markers; v1/v2
 * are detected by their other unique tables, v3/v4 by user_version.
 */
function assertCompatibleSchema(sqlite: Database) {
  const tables = tableNames(sqlite)
  if (tables.size === 0) return

  const v1Markers = ["agent_inbox", "run_agents", "agent_messages"]
  const v2Markers = ["messages", "agent_usage"]

  if (v1Markers.some((name) => tables.has(name))) {
    throw new Error(
      [
        "AegisX v5 cannot open a v1 database.",
        "Delete the data directory (or only aegisx.sqlite) and restart.",
        `Example: rm -rf ${"data/"}  # or remove AEGISX_DATA_DIR contents`,
      ].join(" ")
    )
  }

  if (v2Markers.some((name) => tables.has(name))) {
    throw new Error(
      [
        "AegisX v5 cannot open a v2 database (incompatible run/agent schema).",
        "v5 is a full data wipe. Delete the data directory and restart.",
        `Example: rm -rf ${"data/"}  # or remove AEGISX_DATA_DIR contents`,
      ].join(" ")
    )
  }

  const userVersion = (
    sqlite.query("PRAGMA user_version").get() as { user_version: number }
  ).user_version
  if (userVersion > SCHEMA_VERSION) {
    throw new Error(
      `Database schema version ${userVersion} is newer than this binary (${SCHEMA_VERSION}). Upgrade AegisX.`
    )
  }
  if (userVersion !== 0 && userVersion < SCHEMA_VERSION) {
    throw new Error(
      [
        `AegisX database schema version ${userVersion} is older than v${SCHEMA_VERSION}.`,
        "v5 is a full data wipe. Delete the data directory and restart.",
        `Example: rm -rf ${"data/"}  # or remove AEGISX_DATA_DIR contents`,
      ].join(" ")
    )
  }
}

export function createDatabase(dataDir: string) {
  mkdirSync(dataDir, { recursive: true })
  const releaseLock = acquireDataDirLock(dataDir)
  try {
    const dbPath = join(dataDir, "aegisx.sqlite")
    const sqlite = new Database(dbPath, { create: true })
    sqlite.run("PRAGMA busy_timeout = 5000")
    sqlite.run("PRAGMA foreign_keys = ON")
    sqlite.run("PRAGMA journal_mode = WAL")
    assertCompatibleSchema(sqlite)
    const db = drizzle({ client: sqlite, schema })
    migrate(db, { migrationsFolder })
    sqlite.run(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    return { db, sqlite, releaseLock }
  } catch (error) {
    releaseLock()
    throw error
  }
}
