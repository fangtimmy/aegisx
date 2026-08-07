# Database migrations

AegisX uses drizzle-kit migrations as the real schema-evolution path — existing
data is migrated forward, not wiped. This document is the dev/operator workflow.

Related: [architecture.md](./architecture.md).

## How versioning works

- **Source of truth**: the drizzle migration journal
  (`apps/server/drizzle/meta/_journal.json`) + the `__drizzle_migrations` table
  recorded inside each database.
- **`SCHEMA_VERSION`** (`apps/server/src/db/schema.ts`): a hand-maintained
  display constant. It sets `PRAGMA user_version` (a quick inspection handle),
  feeds the "newer than binary" guard, and the version shown in error text /
  health / docs. It is **not** a correctness gate: forgetting to bump it only
  leaves the displayed number stale — drizzle still migrates correctly. Bump it
  alongside generating a migration so display stays current.

## Open-time classification (`createDatabase`)

| State | Marker | Action |
|---|---|---|
| fresh | no tables | bootstrap: `migrate` applies every migration from scratch |
| recognized | `__drizzle_migrations` present | **back up → migrate forward** (data-preserving) |
| pre-baseline | tables, but no `__drizzle_migrations` | refuse (schema v1–v5; back up + start fresh) |
| newer than binary | `user_version > SCHEMA_VERSION` | refuse (downgrade not supported) |

A recognized database with no pending migrations (journal entry count ≤ applied
count) opens straight through — nothing is copied.

## Backups

A snapshot is taken **only when pending migrations are detected**. Day-to-day
restarts copy nothing. The procedure:

1. `PRAGMA wal_checkpoint(TRUNCATE)` — flush the WAL into the main file so the
   snapshot is self-consistent.
2. Copy `aegisx.sqlite` → `aegisx.sqlite.bak-<timestamp>`.
3. `migrate()`. If it throws, the snapshot is restored, the `-wal`/`-shm` files
   are dropped, and the error names the restored file. Fix the migration and
   restart; the DB is exactly as it was before the attempt.

## Workflow: changing the schema

1. Edit `apps/server/src/db/schema.ts`.
2. Generate the migration:
   ```sh
   cd apps/server && bun run db:generate
   ```
   This adds `drizzle/000N_<name>.sql` and updates the journal.
3. **Review the generated SQL** — drizzle describes structure, not your data:
   - **Safe** (commit as-is): `CREATE TABLE`, `ADD COLUMN` (nullable or with a
     default), `CREATE INDEX`.
   - **Needs hand-editing** (data-losing as generated): `DROP COLUMN`/`TABLE`,
     `RENAME`, type changes, `NOT NULL` without a default. Rewrite as an
     additive backfill — add the new column, `UPDATE` to copy data, only then
     drop the old one. Statements run in order up to the
     `--> statement-breakpoint` markers.
4. Bump `SCHEMA_VERSION` in `schema.ts` (one line; drives all version display).
5. Commit migration + journal + schema + `SCHEMA_VERSION` together.
6. Restart. The recognized DB is snapshotted and migrated forward.

## When a wipe is still required

Only for a **pre-baseline** database (schema v1–v5, no `__drizzle_migrations`).
Those predate the migration system and have no forward path. Back the file up,
remove it, and restart to bootstrap fresh. This does not recur for any database
created on the current track.
