import { sql } from "drizzle-orm"
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core"

/** Schema major version stored in SQLite user_version. */
export const SCHEMA_VERSION = 5

export const events = sqliteTable("events", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  promptHint: text("prompt_hint").notNull().default(""),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
})

export const eventPlatforms = sqliteTable("event_platforms", {
  eventId: text("event_id")
    .primaryKey()
    .references(() => events.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  baseUrl: text("base_url").notNull(),
  credential: text("credential").notNull(),
  remoteEventId: text("remote_event_id").notNull(),
  sourceKey: text("source_key").notNull(),
  lastSyncedAt: text("last_synced_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
})

export const challenges = sqliteTable(
  "challenges",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull(),
    category: text("category"),
    points: integer("points"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("challenges_event_id_idx").on(table.eventId)]
)

export const challengeRemote = sqliteTable(
  "challenge_remote",
  {
    challengeId: text("challenge_id")
      .primaryKey()
      .references(() => challenges.id, { onDelete: "cascade" }),
    sourceKey: text("source_key").notNull(),
    remoteId: text("remote_id").notNull(),
    available: integer("available", { mode: "boolean" })
      .notNull()
      .default(true),
    solved: integer("solved", { mode: "boolean" }).notNull().default(false),
    targetSupported: integer("target_supported", { mode: "boolean" })
      .notNull()
      .default(false),
    targetIgnored: integer("target_ignored", { mode: "boolean" })
      .notNull()
      .default(false),
    targetCount: integer("target_count").notNull().default(0),
    targetInfo: text("target_info").notNull().default("[]"),
    syncedAt: text("synced_at").notNull(),
  },
  (table) => [
    uniqueIndex("challenge_remote_source_unique").on(
      table.sourceKey,
      table.remoteId
    ),
  ]
)

export const attachments = sqliteTable(
  "attachments",
  {
    id: text("id").primaryKey(),
    challengeId: text("challenge_id")
      .notNull()
      .references(() => challenges.id, { onDelete: "cascade" }),
    originalName: text("original_name").notNull(),
    storageKey: text("storage_key").notNull().unique(),
    size: integer("size").notNull(),
    sha256: text("sha256").notNull(),
    remoteId: text("remote_id"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("attachments_challenge_id_idx").on(table.challengeId),
    uniqueIndex("attachments_challenge_remote_unique")
      .on(table.challengeId, table.remoteId)
      .where(sql`${table.remoteId} is not null`),
  ]
)

/**
 * v4 runs: the agent loop runs host-side in-process via the pi SDK. The
 * container is a long-lived tool box (sleep infinity); bash is forwarded into
 * it over `docker exec`. File tools operate on the host workspace, which is
 * bind-mounted into the container so both sides share one tree.
 */
export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    challengeId: text("challenge_id")
      .notNull()
      .references(() => challenges.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    // Model snapshot (resolved at run creation from a ProviderConnection)
    provider: text("provider").notNull(),
    providerLabel: text("provider_label"),
    modelId: text("model_id").notNull(),
    modelLabel: text("model_label"),
    thinkingLevel: text("thinking_level").notNull().default("off"),
    // Container resource snapshot
    image: text("image").notNull(),
    cpus: integer("cpus").notNull(),
    memoryMb: integer("memory_mb").notNull(),
    pidsLimit: integer("pids_limit").notNull(),
    containerName: text("container_name").notNull(),
    /** workspace dir relative to dataDir (data/runs/<id>/workspace). */
    workspacePath: text("workspace_path").notNull(),
    /** SessionManager root dir relative to dataDir (data/runs/<id>/sessions). */
    sessionDir: text("session_dir").notNull(),
    createdAt: text("created_at").notNull(),
    startedAt: text("started_at"),
    updatedAt: text("updated_at").notNull(),
    completedAt: text("completed_at"),
    error: text("error"),
    summary: text("summary"),
    flag: text("flag"),
  },
  (table) => [
    index("runs_challenge_id_idx").on(table.challengeId),
    check(
      "runs_status_check",
      sql`${table.status} in ('running', 'idle', 'closed')`
    ),
  ]
)

/**
 * Agents within a run: exactly one main AgentSession (created at run start) and
 * zero or more child agents spawned via the spawn_agent tool.
 */
export const agents = sqliteTable(
  "agents",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    /** null for the main agent; the main agent id for children. */
    parentAgentId: text("parent_agent_id"),
    status: text("status").notNull(),
    /** SessionManager jsonl file for this agent (resume + audit). */
    sessionFile: text("session_file"),
    name: text("name"),
    /** Delegated task text for child agents. */
    task: text("task"),
    createdAt: text("created_at").notNull(),
    startedAt: text("started_at"),
    updatedAt: text("updated_at").notNull(),
    completedAt: text("completed_at"),
    error: text("error"),
  },
  (table) => [
    index("agents_run_id_idx").on(table.runId),
    check("agents_role_check", sql`${table.role} in ('main', 'child')`),
    check(
      "agents_status_check",
      sql`${table.status} in ('running', 'idle', 'completed', 'failed')`
    ),
  ]
)

/**
 * Database-backed session tree (replaces per-agent jsonl files for new runs).
 *
 * One `sessions` row = one pi session (one agent's conversation). Each
 * `session_entries` row is one append-only SessionTreeEntry — byte-for-byte
 * the JSON pi would have written to a jsonl line. Driven by `DbSessionManager`,
 * which pi writes through transparently via the injected `sessionManager`, so
 * the database is the single source of truth and no jsonl file is created.
 */
export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    cwd: text("cwd").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("sessions_run_id_idx").on(table.runId)]
)

export const sessionEntries = sqliteTable(
  "session_entries",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    parentId: text("parent_id"),
    /** Monotonic append order within the session (= jsonl line number). */
    seq: integer("seq").notNull(),
    type: text("type").notNull(),
    /** Full SessionEntry JSON (byte-for-byte a pi jsonl line). */
    data: text("data").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("session_entries_session_seq_unique").on(
      table.sessionId,
      table.seq
    ),
    index("session_entries_run_seq_idx").on(table.runId, table.seq),
    index("session_entries_run_agent_seq_idx").on(
      table.runId,
      table.agentId,
      table.seq
    ),
    index("session_entries_session_type_idx").on(table.sessionId, table.type),
  ]
)

export const submissions = sqliteTable(
  "submissions",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    flag: text("flag").notNull(),
    status: text("status").notNull(),
    remoteId: text("remote_id"),
    message: text("message"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("submissions_run_id_idx").on(table.runId),
    uniqueIndex("submissions_run_flag_unique").on(table.runId, table.flag),
    check(
      "submissions_status_check",
      sql`${table.status} in ('pending', 'accepted', 'rejected', 'partial', 'already_solved', 'rate_limited', 'error')`
    ),
  ]
)

export const platformRequestLog = sqliteTable(
  "platform_request_log",
  {
    id: text("id").primaryKey().notNull(),
    createdAt: text("created_at").notNull(),
    method: text("method").notNull(),
    url: text("url").notNull(),
    requestHeaders: text("request_headers").notNull(),
    requestBody: text("request_body"),
    status: integer("status"),
    responseHeaders: text("response_headers"),
    responseBody: text("response_body"),
    error: text("error"),
  },
  (table) => [index("platform_request_log_created_at_idx").on(table.createdAt)]
)
