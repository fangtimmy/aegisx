import { sql } from "drizzle-orm"
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core"

export const events = sqliteTable("events", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  startsAt: text("starts_at"),
  endsAt: text("ends_at"),
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
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("attachments_challenge_id_idx").on(table.challengeId)]
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
    modelConfig: text("model_config").notNull().default("{}"),
    environmentConfig: text("environment_config")
      .notNull()
      .default('{"type":"local"}'),
    sessionPath: text("session_path"),
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
