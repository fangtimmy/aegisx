/**
 * One-shot: copy data from a pre-challenge_remote SQLite dump into the current schema.
 *
 * Usage:
 *   bun run scripts/migrate-legacy-data.ts \
 *     --from /path/to/old/aegisx.sqlite \
 *     --data-dir /path/to/data
 *
 * Defaults:
 *   --from  $JOB_TMP/migrate/aegisx.sqlite or ../../legacy/aegisx.sqlite
 *   --data-dir  repo root data/
 */
import { Database } from "bun:sqlite"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
} from "node:fs"
import { dirname, join, resolve } from "node:path"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"

function arg(name: string, fallback?: string) {
  const index = process.argv.indexOf(name)
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]
  return fallback
}

const repoRoot = resolve(import.meta.dir, "../../..")
const defaultFrom = [
  resolve("/Users/timmy/.claude/jobs/905f719e/tmp/migrate/aegisx.sqlite"),
  join(repoRoot, "legacy", "aegisx.sqlite"),
].find((path) => existsSync(path))

const fromPath = resolve(
  arg("--from", defaultFrom) ??
    (() => {
      throw new Error("Pass --from /path/to/old/aegisx.sqlite")
    })()
)
const dataDir = resolve(arg("--data-dir", join(repoRoot, "data"))!)
const targetDb = join(dataDir, "aegisx.sqlite")
const migrationsFolder = resolve(import.meta.dir, "../drizzle")
const stamp = new Date().toISOString().replace(/[:.]/g, "-")
const backupDir = join(dataDir, `.migrate-backup-${stamp}`)
const stagingDb = join(dataDir, `.migrate-staging-${stamp}.sqlite`)

if (!existsSync(fromPath)) {
  throw new Error(`Source database not found: ${fromPath}`)
}

mkdirSync(dataDir, { recursive: true })
mkdirSync(backupDir, { recursive: true })

function backupIfExists(name: string) {
  const path = join(dataDir, name)
  if (!existsSync(path)) return
  copyFileSync(path, join(backupDir, name))
}

console.log("Source:", fromPath)
console.log("Data dir:", dataDir)
console.log("Backup:", backupDir)

// Checkpoint any live WAL so the on-disk main file is complete before backup.
if (existsSync(targetDb)) {
  try {
    const live = new Database(targetDb)
    live.run("PRAGMA wal_checkpoint(TRUNCATE)")
    live.close()
  } catch (error) {
    console.warn("Could not checkpoint live DB (continuing):", error)
  }
}

for (const name of [
  "aegisx.sqlite",
  "aegisx.sqlite-wal",
  "aegisx.sqlite-shm",
  "aegisx.lock",
]) {
  backupIfExists(name)
}

if (existsSync(stagingDb)) unlinkSync(stagingDb)
for (const suffix of ["-wal", "-shm"]) {
  const path = `${stagingDb}${suffix}`
  if (existsSync(path)) unlinkSync(path)
}

// Build empty new-schema DB via drizzle migrator.
{
  const sqlite = new Database(stagingDb, { create: true })
  sqlite.run("PRAGMA foreign_keys = ON")
  sqlite.run("PRAGMA journal_mode = WAL")
  const db = drizzle({ client: sqlite })
  migrate(db, { migrationsFolder })
  sqlite.close()
}

const db = new Database(stagingDb)
db.run("PRAGMA foreign_keys = ON")
db.run("PRAGMA busy_timeout = 5000")

// Attach legacy DB read-only-ish (SQLite attach is read-write; we only SELECT).
db.run(`ATTACH DATABASE ${sqlString(fromPath)} AS legacy`)

function sqlString(value: string) {
  return `'${value.replaceAll("'", "''")}'`
}

function count(sql: string) {
  return Number((db.query(sql).get() as { c: number } | undefined)?.c ?? 0)
}

function copy(label: string, sql: string) {
  db.run(sql)
  const inserted = db.query("SELECT changes() AS c").get() as { c: number }
  console.log(`  ${label}: ${inserted.c}`)
}

db.run("BEGIN IMMEDIATE")
try {
  console.log("Copying tables...")

  copy(
    "events",
    `INSERT INTO events (id, name, prompt_hint, created_at, updated_at)
     SELECT id, name, COALESCE(prompt_hint, ''), created_at, updated_at
     FROM legacy.events`
  )

  copy(
    "event_platforms",
    `INSERT INTO event_platforms (
       event_id, type, base_url, credential, remote_event_id, source_key,
       last_synced_at, created_at, updated_at
     )
     SELECT event_id, type, base_url, credential, remote_event_id, source_key,
            last_synced_at, created_at, updated_at
     FROM legacy.event_platforms`
  )

  copy(
    "challenges",
    `INSERT INTO challenges (
       id, event_id, name, description, category, points, created_at, updated_at
     )
     SELECT id, event_id, name, description, category, points, created_at, updated_at
     FROM legacy.challenges`
  )

  // All legacy challenges in this dump have remote binding; still guard nulls.
  copy(
    "challenge_remote",
    `INSERT INTO challenge_remote (
       challenge_id, source_key, remote_id, available, solved,
       target_supported, target_ignored, target_count, target_info, synced_at
     )
     SELECT
       id,
       remote_source_key,
       remote_id,
       COALESCE(remote_available, 1),
       COALESCE(remote_solved, 0),
       COALESCE(remote_target, 0),
       COALESCE(remote_target_ignored, 0),
       COALESCE(remote_target_count, 0),
       COALESCE(remote_target_info, '[]'),
       COALESCE(remote_updated_at, updated_at, created_at)
     FROM legacy.challenges
     WHERE remote_id IS NOT NULL AND remote_source_key IS NOT NULL`
  )

  copy(
    "attachments",
    `INSERT INTO attachments (
       id, challenge_id, original_name, storage_key, size, sha256, remote_id, created_at
     )
     SELECT id, challenge_id, original_name, storage_key, size, sha256, remote_id, created_at
     FROM legacy.attachments`
  )

  // Interrupted "running" rows become paused so recovery does not fight us.
  copy(
    "runs",
    `INSERT INTO runs (
       id, challenge_id, status, prompt, prompt_config, model_config,
       environment_config, workspace_path, created_at, started_at, updated_at,
       completed_at, error, summary, pending_completion_summary, flag
     )
     SELECT
       id, challenge_id,
       CASE WHEN status = 'running' THEN 'paused' ELSE status END,
       COALESCE(prompt, ''),
       COALESCE(prompt_config, '{}'),
       COALESCE(model_config, '{}'),
       COALESCE(environment_config, '{"type":"local"}'),
       workspace_path, created_at, started_at, updated_at,
       completed_at, error, summary, pending_completion_summary, flag
     FROM legacy.runs`
  )

  // Parents first, then children (self-FK).
  copy(
    "run_agents (main)",
    `INSERT INTO run_agents (
       id, run_id, parent_agent_id, name, task, status, runtime_snapshot,
       context_summary, context_through_sequence, summary, error,
       created_at, started_at, updated_at, completed_at
     )
     SELECT
       id, run_id, parent_agent_id, name, task,
       CASE WHEN status IN ('running', 'idle') THEN 'paused' ELSE status END,
       runtime_snapshot, context_summary, context_through_sequence, summary, error,
       created_at, started_at, updated_at, completed_at
     FROM legacy.run_agents
     WHERE parent_agent_id IS NULL`
  )

  copy(
    "run_agents (children)",
    `INSERT INTO run_agents (
       id, run_id, parent_agent_id, name, task, status, runtime_snapshot,
       context_summary, context_through_sequence, summary, error,
       created_at, started_at, updated_at, completed_at
     )
     SELECT
       id, run_id, parent_agent_id, name, task,
       CASE WHEN status IN ('running', 'idle') THEN 'paused' ELSE status END,
       runtime_snapshot, context_summary, context_through_sequence, summary, error,
       created_at, started_at, updated_at, completed_at
     FROM legacy.run_agents
     WHERE parent_agent_id IS NOT NULL`
  )

  copy(
    "agent_messages",
    `INSERT INTO agent_messages (
       id, agent_id, sequence, runtime_id, message, created_at
     )
     SELECT id, agent_id, sequence, runtime_id, message, created_at
     FROM legacy.agent_messages`
  )

  copy(
    "agent_inbox",
    `INSERT INTO agent_inbox (
       id, agent_id, kind, content, metadata, created_at, delivered_at
     )
     SELECT id, agent_id, kind, content, metadata, created_at, delivered_at
     FROM legacy.agent_inbox`
  )

  copy(
    "agent_tool_calls",
    `INSERT INTO agent_tool_calls (
       id, agent_id, tool_call_id, tool_name, status, timeout_ms, duration_ms,
       output_bytes, truncated, succeeded, exit_code, error, created_at, completed_at
     )
     SELECT
       id, agent_id, tool_call_id, tool_name,
       CASE WHEN status = 'running' THEN 'failed' ELSE status END,
       timeout_ms, duration_ms, output_bytes, truncated, succeeded, exit_code,
       CASE
         WHEN status = 'running' THEN COALESCE(error, 'Interrupted by schema migration')
         ELSE error
       END,
       created_at,
       CASE WHEN status = 'running' THEN COALESCE(completed_at, created_at) ELSE completed_at END
     FROM legacy.agent_tool_calls`
  )

  copy(
    "agent_usage",
    `INSERT INTO agent_usage (id, agent_id, kind, usage, created_at)
     SELECT id, agent_id, kind, usage, created_at
     FROM legacy.agent_usage`
  )

  copy(
    "run_events",
    `INSERT INTO run_events (id, run_id, type, agent_id, entity_id, created_at)
     SELECT id, run_id, type, agent_id, entity_id, created_at
     FROM legacy.run_events`
  )

  // Keep AUTOINCREMENT cursor aligned.
  const maxRunEventId = Number(
    (
      db
        .query("SELECT COALESCE(MAX(id), 0) AS c FROM run_events")
        .get() as { c: number }
    ).c
  )
  // sqlite_sequence has no UNIQUE/PK on name; DELETE + INSERT is required.
  db.run(`DELETE FROM sqlite_sequence WHERE name = 'run_events'`)
  db.run(
    `INSERT INTO sqlite_sequence (name, seq) VALUES ('run_events', ${maxRunEventId})`
  )

  copy(
    "submissions",
    `INSERT INTO submissions (
       id, run_id, flag, status, remote_id, message, created_at, updated_at
     )
     SELECT id, run_id, flag, status, remote_id, message, created_at, updated_at
     FROM legacy.submissions`
  )

  copy(
    "platform_request_log",
    `INSERT INTO platform_request_log (
       id, created_at, method, url, request_headers, request_body,
       status, response_headers, response_body, error
     )
     SELECT id, created_at, method, url, request_headers, request_body,
            status, response_headers, response_body, error
     FROM legacy.platform_request_log`
  )

  db.run("COMMIT")
} catch (error) {
  db.run("ROLLBACK")
  db.close()
  throw error
}

db.run("DETACH DATABASE legacy")

// Verify counts
const report = {
  events: count("SELECT count(*) AS c FROM events"),
  event_platforms: count("SELECT count(*) AS c FROM event_platforms"),
  challenges: count("SELECT count(*) AS c FROM challenges"),
  challenge_remote: count("SELECT count(*) AS c FROM challenge_remote"),
  attachments: count("SELECT count(*) AS c FROM attachments"),
  runs: count("SELECT count(*) AS c FROM runs"),
  run_agents: count("SELECT count(*) AS c FROM run_agents"),
  agent_messages: count("SELECT count(*) AS c FROM agent_messages"),
  agent_inbox: count("SELECT count(*) AS c FROM agent_inbox"),
  agent_tool_calls: count("SELECT count(*) AS c FROM agent_tool_calls"),
  run_events: count("SELECT count(*) AS c FROM run_events"),
  submissions: count("SELECT count(*) AS c FROM submissions"),
  platform_request_log: count("SELECT count(*) AS c FROM platform_request_log"),
  running_runs: count(
    "SELECT count(*) AS c FROM runs WHERE status = 'running'"
  ),
  paused_runs: count("SELECT count(*) AS c FROM runs WHERE status = 'paused'"),
}

console.log("Verification:", report)

if (report.challenges !== report.challenge_remote) {
  console.warn(
    `warning: challenges (${report.challenges}) != challenge_remote (${report.challenge_remote})`
  )
}
if (report.running_runs !== 0) {
  throw new Error("Migration left running runs; aborting swap")
}

// Integrity
const integrity = db.query("PRAGMA foreign_key_check").all()
if (integrity.length > 0) {
  console.error(integrity.slice(0, 20))
  throw new Error(`foreign_key_check failed: ${integrity.length} violations`)
}
db.run("PRAGMA wal_checkpoint(TRUNCATE)")
db.close()

// Swap into place
for (const name of ["aegisx.sqlite", "aegisx.sqlite-wal", "aegisx.sqlite-shm"]) {
  const path = join(dataDir, name)
  if (existsSync(path)) unlinkSync(path)
}
renameSync(stagingDb, targetDb)
for (const suffix of ["-wal", "-shm"]) {
  const path = `${stagingDb}${suffix}`
  if (existsSync(path)) renameSync(path, `${targetDb}${suffix}`)
}

console.log("Migrated database installed at", targetDb)
console.log("Previous files backed up under", backupDir)
console.log(
  "Note: legacy settings/providers tables were not copied (config.json is the source of truth)."
)
