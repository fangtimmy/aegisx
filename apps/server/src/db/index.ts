import { Database } from "bun:sqlite"
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"
import * as schema from "./schema"

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

export function createDatabase(dataDir: string) {
  mkdirSync(dataDir, { recursive: true })
  const releaseLock = acquireDataDirLock(dataDir)
  try {
    const sqlite = new Database(join(dataDir, "aegisx.sqlite"), {
      create: true,
    })
    sqlite.run("PRAGMA busy_timeout = 5000")
    sqlite.run("PRAGMA foreign_keys = ON")
    sqlite.run("PRAGMA journal_mode = WAL")
    const db = drizzle({ client: sqlite, schema })
    migrate(db, { migrationsFolder })
    return { db, sqlite, releaseLock }
  } catch (error) {
    releaseLock()
    throw error
  }
}
