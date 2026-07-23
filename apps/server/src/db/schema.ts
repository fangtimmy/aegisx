import { sql } from "drizzle-orm"
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core"

/** Schema major version stored in SQLite user_version. */
export const SCHEMA_VERSION = 2

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

export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    challengeId: text("challenge_id")
      .notNull()
      .references(() => challenges.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    modelJson: text("model_json").notNull(),
    envJson: text("env_json").notNull(),
    promptJson: text("prompt_json").notNull(),
    workspacePath: text("workspace_path"),
    createdAt: text("created_at").notNull(),
    startedAt: text("started_at"),
    updatedAt: text("updated_at").notNull(),
    completedAt: text("completed_at"),
    error: text("error"),
    summary: text("summary"),
    pendingFinishSummary: text("pending_finish_summary"),
    flag: text("flag"),
  },
  (table) => [
    index("runs_challenge_id_idx").on(table.challengeId),
    check(
      "runs_status_check",
      sql`${table.status} in ('running', 'paused', 'completed', 'failed', 'stopped')`
    ),
  ]
)

export const agents = sqliteTable(
  "agents",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    parentAgentId: text("parent_agent_id").references(
      (): AnySQLiteColumn => agents.id,
      { onDelete: "cascade" }
    ),
    name: text("name").notNull(),
    task: text("task"),
    status: text("status").notNull(),
    runtimeSnapshot: text("runtime_snapshot"),
    contextSummary: text("context_summary"),
    contextThroughSeq: integer("context_through_seq"),
    summary: text("summary"),
    error: text("error"),
    createdAt: text("created_at").notNull(),
    startedAt: text("started_at"),
    updatedAt: text("updated_at").notNull(),
    completedAt: text("completed_at"),
  },
  (table) => [
    index("agents_run_id_idx").on(table.runId),
    index("agents_parent_agent_id_idx").on(table.parentAgentId),
    uniqueIndex("agents_main_unique")
      .on(table.runId)
      .where(sql`${table.parentAgentId} is null`),
    check(
      "agents_status_check",
      sql`${table.status} in ('running', 'idle', 'paused', 'completed', 'failed', 'stopped')`
    ),
  ]
)

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    role: text("role").notNull(),
    body: text("body").notNull(),
    clientMessageId: text("client_message_id"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("messages_agent_seq_unique").on(table.agentId, table.seq),
    uniqueIndex("messages_agent_client_unique")
      .on(table.agentId, table.clientMessageId)
      .where(sql`${table.clientMessageId} is not null`),
    index("messages_agent_id_idx").on(table.agentId),
    check(
      "messages_role_check",
      sql`${table.role} in ('user', 'assistant', 'toolResult', 'notice')`
    ),
  ]
)

export const agentUsage = sqliteTable(
  "agent_usage",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    usage: text("usage").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("agent_usage_agent_id_idx").on(table.agentId)]
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
