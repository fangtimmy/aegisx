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

export const events = sqliteTable("events", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
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
    remoteSourceKey: text("remote_source_key"),
    remoteId: text("remote_id"),
    remoteAvailable: integer("remote_available", { mode: "boolean" })
      .notNull()
      .default(true),
    remoteSolved: integer("remote_solved", { mode: "boolean" })
      .notNull()
      .default(false),
    remoteTarget: integer("remote_target", { mode: "boolean" })
      .notNull()
      .default(false),
    remoteTargetIgnored: integer("remote_target_ignored", { mode: "boolean" })
      .notNull()
      .default(false),
    remoteTargetCount: integer("remote_target_count").notNull().default(0),
    remoteTargetInfo: text("remote_target_info").notNull().default("[]"),
    remoteUpdatedAt: text("remote_updated_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("challenges_event_id_idx").on(table.eventId),
    uniqueIndex("challenges_event_remote_source_unique")
      .on(table.eventId, table.remoteSourceKey, table.remoteId)
      .where(sql`${table.remoteId} is not null`),
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
    prompt: text("prompt").notNull().default(""),
    promptConfig: text("prompt_config").notNull().default("{}"),
    modelConfig: text("model_config").notNull().default("{}"),
    environmentConfig: text("environment_config")
      .notNull()
      .default('{"type":"local"}'),
    workspacePath: text("workspace_path"),
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
      sql`${table.status} in ('running', 'paused', 'completed', 'failed', 'stopped')`
    ),
  ]
)

export const submissions = sqliteTable(
  "submissions",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    challengeId: text("challenge_id")
      .notNull()
      .references(() => challenges.id, { onDelete: "cascade" }),
    flag: text("flag").notNull(),
    status: text("status").notNull(),
    remoteId: text("remote_id"),
    message: text("message"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("submissions_run_id_idx").on(table.runId),
    index("submissions_challenge_id_idx").on(table.challengeId),
    check(
      "submissions_status_check",
      sql`${table.status} in ('pending', 'accepted', 'rejected', 'partial', 'already_solved', 'rate_limited', 'error')`
    ),
  ]
)

export const runAgents = sqliteTable(
  "run_agents",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    parentAgentId: text("parent_agent_id").references(
      (): AnySQLiteColumn => runAgents.id,
      { onDelete: "cascade" }
    ),
    name: text("name").notNull(),
    task: text("task"),
    status: text("status").notNull(),
    runtimeSnapshot: text("runtime_snapshot"),
    contextSummary: text("context_summary"),
    contextThroughSequence: integer("context_through_sequence"),
    summary: text("summary"),
    error: text("error"),
    createdAt: text("created_at").notNull(),
    startedAt: text("started_at"),
    updatedAt: text("updated_at").notNull(),
    completedAt: text("completed_at"),
  },
  (table) => [
    index("run_agents_run_id_idx").on(table.runId),
    index("run_agents_parent_agent_id_idx").on(table.parentAgentId),
    uniqueIndex("run_agents_main_unique")
      .on(table.runId)
      .where(sql`${table.parentAgentId} is null`),
    check(
      "run_agents_status_check",
      sql`${table.status} in ('running', 'idle', 'paused', 'completed', 'failed', 'stopped')`
    ),
  ]
)

export const agentMessages = sqliteTable(
  "agent_messages",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => runAgents.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    message: text("message").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("agent_messages_agent_sequence_unique").on(
      table.agentId,
      table.sequence
    ),
    index("agent_messages_agent_id_idx").on(table.agentId),
  ]
)

export const agentInbox = sqliteTable(
  "agent_inbox",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => runAgents.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    content: text("content").notNull(),
    createdAt: text("created_at").notNull(),
    deliveredAt: text("delivered_at"),
  },
  (table) => [
    index("agent_inbox_pending_idx").on(table.agentId, table.deliveredAt),
    check(
      "agent_inbox_kind_check",
      sql`${table.kind} in ('user', 'child_result', 'resume')`
    ),
  ]
)

export const agentUsage = sqliteTable(
  "agent_usage",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => runAgents.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    usage: text("usage").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("agent_usage_agent_id_idx").on(table.agentId)]
)

export const agentToolCalls = sqliteTable(
  "agent_tool_calls",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => runAgents.id, { onDelete: "cascade" }),
    toolCallId: text("tool_call_id").notNull(),
    toolName: text("tool_name").notNull(),
    durationMs: integer("duration_ms").notNull(),
    outputBytes: integer("output_bytes").notNull(),
    truncated: integer("truncated", { mode: "boolean" })
      .notNull()
      .default(false),
    succeeded: integer("succeeded", { mode: "boolean" }).notNull(),
    exitCode: integer("exit_code"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("agent_tool_calls_agent_id_idx").on(table.agentId),
    index("agent_tool_calls_agent_created_at_idx").on(
      table.agentId,
      table.createdAt
    ),
  ]
)

export const settings = sqliteTable(
  "settings",
  {
    id: integer("id").primaryKey(),
    defaultModelId: text("default_model_id").references(
      () => providerModels.id
    ),
    environment: text("environment").notNull().default("local"),
    containerImage: text("container_image").notNull().default("alpine:3.22"),
    cpuLimit: integer("cpu_limit").notNull().default(1000),
    memoryMb: integer("memory_mb").notNull().default(512),
    pidsLimit: integer("pids_limit").notNull().default(128),
    maxConcurrency: integer("max_concurrency").notNull().default(2),
    mainSystemPromptTemplate: text("system_prompt_template")
      .notNull()
      .default(""),
    childSystemPromptTemplate: text("child_system_prompt_template")
      .notNull()
      .default(""),
    initialPromptTemplate: text("initial_prompt_template")
      .notNull()
      .default(""),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check("settings_singleton_check", sql`${table.id} = 1`),
    check(
      "settings_environment_check",
      sql`${table.environment} in ('local', 'container')`
    ),
  ]
)

export const providerConnections = sqliteTable(
  "provider_connections",
  {
    id: text("id").primaryKey(),
    label: text("label").notNull(),
    type: text("type").notNull(),
    baseUrl: text("base_url").notNull(),
    apiKey: text("api_key").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check(
      "provider_connections_type_check",
      sql`${table.type} in ('openai-compatible', 'openai-responses', 'anthropic-messages')`
    ),
  ]
)

export const providerModels = sqliteTable(
  "provider_models",
  {
    id: text("id").primaryKey(),
    providerId: text("provider_id")
      .notNull()
      .references(() => providerConnections.id, { onDelete: "cascade" }),
    modelId: text("model_id").notNull(),
    label: text("label").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    metadata: text("metadata").notNull().default("{}"),
    piProviderId: text("pi_provider_id"),
    piModelId: text("pi_model_id"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("provider_models_provider_id_idx").on(table.providerId),
    index("provider_models_provider_model_idx").on(
      table.providerId,
      table.modelId
    ),
  ]
)
