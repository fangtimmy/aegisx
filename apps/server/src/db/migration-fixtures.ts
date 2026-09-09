import { Database } from "bun:sqlite"
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { drizzle } from "drizzle-orm/bun-sqlite"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"

import { parseJson } from "../lib/guards"

/** Scaffolding for historical-migration tests: replay the real migrator
 * against a truncated copy of the production journal, then grow the copy in
 * place for upgrade steps. Not a test file — imported by migration-*.test.ts
 * siblings. */

const realFolder = resolve(import.meta.dir, "../../drizzle")

type Step = {
  /** Journal entries to keep (0000..entries-1). */
  entries: number
  /** `PRAGMA user_version` to stamp after migrating. */
  version: number
}

function prepareFolder(dir: string, entries: number): string[] {
  const folder = join(dir, "mig")
  mkdirSync(join(folder, "meta"), { recursive: true })
  const journal = parseJson<{ entries: Array<{ tag: string }> }>(
    readFileSync(join(realFolder, "meta", "_journal.json"), "utf8")
  )
  const kept = journal.entries.slice(0, entries)
  journal.entries = kept
  writeFileSync(join(folder, "meta", "_journal.json"), JSON.stringify(journal))
  return kept.map((entry) => entry.tag)
}

/** Build a legacy database in `dir` by applying migrations 0000..entries-1
 * through the real migrator (the exact runtime path) and stamping
 * `PRAGMA user_version = version`. */
export function buildLegacyDatabase(
  dir: string,
  step: Step & { foreignKeys?: boolean }
): Database {
  const sqlite = new Database(join(dir, "aegisx.sqlite"), { create: true })
  sqlite.run("PRAGMA journal_mode = WAL")
  // FK ON matches the production boot (createDatabase enables it before
  // migrating): RENAME TABLE rewrites FK references only with FK ON.
  if (step.foreignKeys !== false) sqlite.run("PRAGMA foreign_keys = ON")
  const tags = prepareFolder(dir, step.entries)
  for (const tag of tags) {
    cpSync(join(realFolder, `${tag}.sql`), join(dir, "mig", `${tag}.sql`))
  }
  migrate(drizzle(sqlite), { migrationsFolder: join(dir, "mig") })
  sqlite.run(`PRAGMA user_version = ${step.version}`)
  return sqlite
}

/** Upgrade a database built by {@link buildLegacyDatabase} in place: grow the
 * journal copy to `entries` entries (copying SQL for entries from `copyFrom`
 * onward) and re-run the migrator; stamps `PRAGMA user_version = version`. */
export function upgradeLegacyDatabase(
  dir: string,
  sqlite: Database,
  step: Step & { copyFrom: number }
): void {
  const tags = prepareFolder(dir, step.entries)
  for (const tag of tags.slice(step.copyFrom)) {
    cpSync(join(realFolder, `${tag}.sql`), join(dir, "mig", `${tag}.sql`))
  }
  migrate(drizzle(sqlite), { migrationsFolder: join(dir, "mig") })
  sqlite.run(`PRAGMA user_version = ${step.version}`)
}
