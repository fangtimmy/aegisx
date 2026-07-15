import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"
import * as schema from "./schema"

const migrationsFolder = resolve(import.meta.dir, "../../drizzle")

export function createDatabase(dataDir: string) {
  mkdirSync(dataDir, { recursive: true })
  const sqlite = new Database(join(dataDir, "aegisx.sqlite"), { create: true })
  sqlite.run("PRAGMA busy_timeout = 5000")
  sqlite.run("PRAGMA foreign_keys = ON")
  sqlite.run("PRAGMA journal_mode = WAL")
  const db = drizzle({ client: sqlite, schema })
  migrate(db, { migrationsFolder })
  return { db, sqlite }
}
