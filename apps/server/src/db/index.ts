import { Database } from "bun:sqlite"
import {
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
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
 * v1 used agent_inbox / run_agents / run_events.
 * Refuse to open so operators wipe data/ instead of silent corruption.
 */
function assertCompatibleSchema(sqlite: Database) {
  const tables = tableNames(sqlite)
  if (tables.size === 0) return

  const v1Markers = ["agent_inbox", "run_agents", "run_events", "agent_messages"]
  const hasV1 = v1Markers.some((name) => tables.has(name))
  const hasV2 = tables.has("messages") && tables.has("agents")

  if (hasV1 && !hasV2) {
    throw new Error(
      [
        "AegisX v2 cannot open a v1 database.",
        "Delete the data directory (or only aegisx.sqlite) and restart.",
        `Example: rm -rf ${"data/"}  # or remove AEGISX_DATA_DIR contents`,
        "See docs/architecture-v2.md.",
      ].join(" ")
    )
  }

  if (tables.has("agents") && !tables.has("messages")) {
    throw new Error(
      "AegisX database is incomplete or corrupted (agents without messages). Wipe data/ and restart."
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
