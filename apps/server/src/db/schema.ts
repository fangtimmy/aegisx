import type { AgentStatus, PlatformType } from "@aegisx/shared"
import type { DomainEventActorKind } from "@aegisx/shared/domain-events"
import { sql } from "drizzle-orm"
import {
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/sqlite-core"

/**
 * Schema major version stamped into SQLite user_version right after the
 * baseline migration builds an empty database. Boot-time gate: a database
 * whose user_version differs from this value never opens (below → stale, no
 * upgrade path; above → downgrade refused). Bump alongside regenerating the
 * baseline whenever schema.ts changes shape.
 */
export const SCHEMA_VERSION = 29

export const events = sqliteTable("events", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** Role-scoped deployment brief (EventPromptBrief JSON: common / solver /
   * orchestrator sections + flagFormats). Seeded from the appliance manifest
   * at first boot; edited via the event settings UI. */
  promptBrief: text("prompt_brief").notNull().default(""),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
})

export const eventPlatforms = sqliteTable("event_platforms", {
  eventId: text("event_id")
    .primaryKey()
    .references(() => events.id, { onDelete: "cascade" }),
  type: text("type").$type<PlatformType>().notNull(),
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
    /** Manual solve-state override (user-assigned). Drives `solved.manual`. */
    manualSolveState: text("manual_solve_state", {
      enum: ["unsolved", "partial", "solved"],
    })
      .notNull()
      .default("unsolved"),
    /** Flags the challenge requires. One owner chain: platform sync writes it
     * when the platform reports a count, the operator may override it. Null =
     * unknown (read as 1: single-flag, or an unreported multi-flag chain).
     * The progress state machine's `required` — per-flag value
     * (points / required) is what makes a multi-flag chain comparable to an
     * independent single-flag challenge. */
    requiredFlags: integer("required_flags"),
    /** First transition into `solved`, stamped by the progress machine. The
     * solve cleanup keys on it, so a chain that is later revealed to need more
     * flags (solved → partial → solved) never runs the teardown twice. */
    solvedAt: text("solved_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("challenges_event_id_idx").on(table.eventId),
    check(
      "challenges_manual_solve_state_check",
      sql`${table.manualSolveState} in ('solved', 'partial', 'unsolved')`
    ),
  ]
)

export const challengeRemote = sqliteTable(
  "challenge_remote",
  {
    challengeId: text("challenge_id")
      .primaryKey()
      .references(() => challenges.id, { onDelete: "cascade" }),
    /** Owning event — scopes the (source_key, remote_id) mapping so the same
     * platform challenge can be imported by multiple events independently
     * (0007; the old global unique index orphaned the second import). */
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
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
      table.eventId,
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
 * v19 agents: the execution unit — one attempt on a challenge = one row
 * (challengeId null = the event's orchestrator agent). The workspace is a
 * derived path (no row); the sandbox is a per-agent one-shot container that
 * lives exactly as long as the agent (prepare → settle). Role/model/prompt/
 * tools are snapshotted at spawn time; cold-restore reuses them verbatim.
 */
export const agents = sqliteTable(
  "agents",
  {
    id: text("id").primaryKey(),
    /** Redundant event anchor (accelerates fleet/usage/flush queries). */
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    /** Null = the event's scheduler agent (at most one per event). */
    challengeId: text("challenge_id").references(() => challenges.id, {
      onDelete: "cascade",
    }),
    role: text("role").$type<"solver" | "orchestrator">().notNull(),
    name: text("name"),
    /** Canonical model ref string (`aegisx-<providerId>/<modelId>:<effort>`).
     * Per-agent snapshot — spawn writes it once; cold-restore reuses it
     * verbatim (model switches survive). */
    model: text("model").notNull(),
    // Prompt + tools snapshot (spawn writes once; cold-restore reuses)
    systemPrompt: text("system_prompt").notNull(),
    /** JSON array of real tool names (file tools always on, not listed). */
    tools: text("tools").notNull(),
    /** JSON array of active tool-definition snapshots (name / description /
     * JSON-Schema parameters), written when the host session is created so the
     * timeline can render real tool schemas incl. the always-on file tools. */
    toolDefinitions: text("tool_definitions"),
    status: text("status").$type<AgentStatus>().notNull(),
    /** The agent's active session id (`sessions` row; multi-session ops
     * switch the pointer). Null until the first session is prepared. */
    sessionFile: text("session_file"),
    /** The spawn prompt (strategy input); reused when re-running an attempt. */
    prompt: text("prompt"),
    source: text("source")
      .$type<"manual" | "scheduler">()
      .notNull()
      .default("manual"),
    timeoutMs: integer("timeout_ms"),
    deadlineAt: text("deadline_at"),
    /** Timestamp of the last timeout fire (Timeline source; outcome event). */
    lastTimeoutAt: text("last_timeout_at"),
    /** Back-filled when the scheduler drainer spawns this agent; used with
     * `agentId` to guard the agent→queue done transition. No FK on this
     * column — the DB schema (0013) and this TS schema both omit it to avoid
     * a circular type inference cycle (TS7022), so the reference is
     * maintained at the application layer. The reverse direction
     * (spawn_queue.agent_id → agents) is declared there instead. */
    queueItemId: text("queue_item_id"),
    error: text("error"),
    /** finish_run's result (written at the terminal completed settle). */
    summary: text("summary"),
    createdAt: text("created_at").notNull(),
    startedAt: text("started_at"),
    updatedAt: text("updated_at").notNull(),
    completedAt: text("completed_at"),
  },
  (table) => [
    index("agents_event_id_idx").on(table.eventId),
    index("agents_challenge_id_idx").on(table.challengeId),
    index("agents_status_idx").on(table.status),
    // At most one scheduler agent per event.
    uniqueIndex("agents_event_orchestrator_unique")
      .on(table.eventId)
      .where(sql`${table.role} = 'orchestrator'`),
    check(
      "agents_role_check",
      sql`${table.role} in ('solver', 'orchestrator')`
    ),
    check(
      "agents_status_check",
      sql`${table.status} in ('running', 'idle', 'completed', 'aborted', 'failed')`
    ),
    check(
      "agents_source_check",
      sql`${table.source} in ('manual', 'scheduler')`
    ),
  ]
)

/**
 * Owned session store (E). One `sessions` row = one pi session (one agent's
 * conversation), owned by exactly one agent. Each `session_entries` row is one
 * canonical entry written by `pi-session-adapter.ts`: queryable fields are
 * first-class columns, the pi-specific remainder rides in `body` verbatim.
 * The adapter is the only writer.
 */
export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    cwd: text("cwd").notNull(),
    /** Persisted branch position (pi's leaf pointer) — survives restart so a
     * branch taken without a following append is not lost. Maintained by the
     * adapter on every write; null = before any entry (resetLeaf state of an
     * empty session). */
    activeLeafId: text("active_leaf_id"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("sessions_agent_id_idx").on(table.agentId)]
)

export const sessionEntries = sqliteTable(
  "session_entries",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    parentId: text("parent_id"),
    /** Monotonic append order within the session (= jsonl line number). */
    seq: integer("seq").notNull(),
    /** Canonical entry kind (registry in run/host/session-entry-codec.ts). */
    type: text("type").notNull(),
    /** user | assistant | toolResult — message rows only, null otherwise. */
    role: text("role"),
    /** The toolResult row's tool name (stats per-tool breakdown). */
    toolName: text("tool_name"),
    /** The entry's own timestamp (pi entry.timestamp). */
    createdAt: text("created_at").notNull(),
    /** First-class usage columns (assistant/toolResult messages +
     * compaction/branch_summary); null when the entry carries none. */
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cacheReadTokens: integer("cache_read_tokens"),
    cacheWriteTokens: integer("cache_write_tokens"),
    reasoningTokens: integer("reasoning_tokens"),
    cost: real("cost"),
    /** Timing metadata JSON (nullable; v10). Assistant message rows carry
     * durationMs + per-block timing; toolResult rows carry durationMs; all
     * other rows are null. Produced by the event pipeline and injected
     * pre-commit via the adapter's metaProvider. */
    meta: text("meta"),
    /** Canonical JSON envelope ({kind, ...typedFields, payload}) — owned by
     * the adapter; de-canonicalizes back to the pi entry on resume. */
    body: text("body").notNull(),
  },
  (table) => [
    uniqueIndex("session_entries_session_seq_unique").on(
      table.sessionId,
      table.seq
    ),
    index("session_entries_agent_seq_idx").on(table.agentId, table.seq),
    index("session_entries_session_type_idx").on(table.sessionId, table.type),
  ]
)

/**
 * Session usage rollups (D 批): per-session materialized usage, maintained
 * incrementally by the session-entry write path inside the same transaction
 * as the entry INSERT (the adapter is the only writer; backtrack recomputes
 * the session in the same transaction as its tail delete). Everyone else
 * reads — the stats/digest/overview faces never scan session_entries.
 * `entryCount` also backs listAgentSessions' messageCount, so archived
 * sessions (rows moved to the archive file) keep reporting their full
 * history. Rows cascade away with the session.
 */
export const usageRollups = sqliteTable(
  "usage_rollups",
  {
    sessionId: text("session_id")
      .primaryKey()
      .references(() => sessions.id, { onDelete: "cascade" }),
    /** Redundant owner anchor (accelerates per-agent aggregation; the
     * session's owner is immutable). */
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    reasoningTokens: integer("reasoning_tokens").notNull().default(0),
    cost: real("cost").notNull().default(0),
    /** Assistant message rows (pi getSessionStats counts every one). */
    turns: integer("turns").notNull().default(0),
    /** toolResult rows (EventStats per-agent toolCalls). */
    toolCalls: integer("tool_calls").notNull().default(0),
    /** All rows ever appended (incl. archived ones; listSessions badge). */
    entryCount: integer("entry_count").notNull().default(0),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("usage_rollups_agent_id_idx").on(table.agentId)]
)

/**
 * Session × tool rollups (D 批): per-session toolResult counts, maintained by
 * the same write path; EventStats' toolUsage reads these joined through the
 * redundant agent anchor (no session_entries scan).
 */
export const usageToolRollups = sqliteTable(
  "usage_tool_rollups",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    toolName: text("tool_name").notNull(),
    /** Redundant owner anchor (accelerates per-event aggregation; the
     * session's owner is immutable). */
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    calls: integer("calls").notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.toolName] }),
    index("usage_tool_rollups_agent_id_idx").on(table.agentId),
  ]
)

/**
 * Per-event queue state (W2). One row per event; absent row = `running`
 * (a fresh event's queue drains immediately, no explicit enable needed).
 * `paused` blocks future launches only — already-live agents are untouched
 * (pause ≠ kill) and enqueue/edit/reorder/remove still work. Boot recovery
 * upserts `paused` for every event with visible items; the user resumes.
 */
export const queueState = sqliteTable("queue_state", {
  eventId: text("event_id")
    .primaryKey()
    .references(() => events.id, { onDelete: "cascade" }),
  /** 'running' | 'paused'. */
  status: text("status").notNull().default("running"),
  updatedAt: text("updated_at").notNull(),
})

/**
 * Scheduler task queue (v19 spawn semantics). Persistent, FIFO by `ord`.
 * A queue item = "spawn one agent on challenge X" — enqueue ALWAYS appends
 * (one challenge may hold several pending items; parallel attempts are a
 * legal plan). Status lifecycle: pending → (drainer spawns) → running
 * (agentId back-filled) → (agent terminal, guarded by agents.queueItemId +
 * agentId) → done; launch failure → failed (error recorded + scheduler
 * notified). The scheduler orchestrator manages it via explicit queue CRUD
 * over the Python SDK.
 */
export const spawnQueue = sqliteTable(
  "spawn_queue",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    ord: integer("ord").notNull(),
    challengeId: text("challenge_id")
      .notNull()
      .references(() => challenges.id, { onDelete: "cascade" }),
    /** Spawn options JSON ({ model?, promptMode? }); the drainer passes them
     * through to spawnAgent. The prompt is the `prompt` column, not this. */
    params: text("params").notNull(),
    timeoutMs: integer("timeout_ms"),
    /** The spawn prompt — single source of truth for launch. */
    prompt: text("prompt").notNull(),
    source: text("source").$type<"manual" | "scheduler">().notNull(),
    status: text("status")
      .$type<"pending" | "running" | "done" | "cancelled" | "failed">()
      .notNull()
      .default("pending"),
    /** Back-filled when the drainer spawns the agent. */
    agentId: text("agent_id").references(() => agents.id, {
      onDelete: "cascade",
    }),
    error: text("error"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("spawn_queue_event_ord_idx").on(table.eventId, table.ord),
    index("spawn_queue_status_idx").on(table.status),
    index("spawn_queue_agent_id_idx").on(table.agentId),
    check(
      "spawn_queue_source_check",
      sql`${table.source} in ('manual', 'scheduler')`
    ),
    check(
      "spawn_queue_status_check",
      sql`${table.status} in ('pending', 'running', 'done', 'cancelled', 'failed')`
    ),
  ]
)

/**
 * Channel message ledger: the single
 * write/store/render point for ALL inter-agent communication. A channel is a
 * DERIVED KEY — "team:<challengeId>" | "dm:<agentId>" | "orch:<eventId>" —
 * stored on the row; there is no channels directory table. `id` is a global
 * autoincrement, the monotonic comparison basis for read cursors.
 *
 * v19: message attachments are files copied into the challenge workspace's
 * shared/ tree at post time; their paths live inside the `meta` JSON (the
 * channel_files table is gone).
 */
export const channelMessages = sqliteTable(
  "channel_messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Derived key: "team:<cid>" | "dm:<aid>" | "orch:<eid>". */
    channelKey: text("channel_key").notNull(),
    /** "system" | "user" | "agent". */
    authorType: text("author_type")
      .$type<"system" | "user" | "agent">()
      .notNull(),
    authorAgentId: text("author_agent_id"),
    /** Display-name snapshot ("Solver · agent-a3f1" / "Scheduler" / "system" / "用户"). */
    authorName: text("author_name").notNull(),
    /** Server-side cap: 16K characters. */
    body: text("body").notNull(),
    /** JSON: { urgent?, agentId?, eventType?, noticeType?, tags?, files? }. */
    meta: text("meta").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("channel_messages_channel_key_idx").on(table.channelKey, table.id),
    check(
      "channel_messages_author_type_check",
      sql`${table.authorType} in ('system', 'user', 'agent')`
    ),
  ]
)

/**
 * Read cursors: (channelKey, readerKey) → lastReadMsgId. The dedup anchor
 * for delivery — a message is delivered at most once. `readerKey` = the
 * agent id for agent readers, or the stable literal "scheduler" for orch
 * channels (the scheduler agent id churns across restarts; the cursor must
 * not).
 */
export const channelReads = sqliteTable(
  "channel_reads",
  {
    channelKey: text("channel_key").notNull(),
    readerKey: text("reader_key").notNull(),
    lastReadMsgId: integer("last_read_msg_id").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.channelKey, table.readerKey] })]
)

/**
 * Per-event scheduler policy (1:1 with events). Replaces the v7
 * `orchestrators` config columns. "Enabled" is no longer a stored flag (v19:
 * enabled = a non-terminal scheduler agent exists); reboot behavior is
 * unchanged — recoverOnBoot marks running scheduler agents idle and there is
 * no auto-start, so a manual start is required after restart.
 */
export const schedulerConfig = sqliteTable("scheduler_config", {
  eventId: text("event_id")
    .primaryKey()
    .references(() => events.id, { onDelete: "cascade" }),
  /** Per-event scheduler model override (canonical model ref string
   * `aegisx-<providerId>/<modelId>:<effort>`); null = fall back to the
   * global default model. */
  modelId: text("model_id"),
  /** Natural-language steering ("hit crypto first, leave pwn for last"). */
  instruction: text("instruction").notNull().default(""),
  maxConcurrentTargets: integer("max_concurrent_targets").notNull().default(1),
  /** Scheduler disabled (W3): while 1 the event's agent-lifecycle events are
   * dropped before they reach the scheduler (silent; the container is kept
   * warm). The flag is writable even with no scheduler agent — presets the
   * next start. */
  paused: integer("paused", { mode: "boolean" }).notNull().default(false),
  /** Flag-acceptance orchestration policy (read side coalesces in
   * run/scheduler-policy.ts; the scheduler-admin upsert mirrors these
   * defaults as insert fallbacks). */
  notifyTeamOnFlag: integer("notify_team_on_flag", { mode: "boolean" })
    .notNull()
    .default(true),
  stopSiblingsOnSolve: integer("stop_siblings_on_solve", { mode: "boolean" })
    .notNull()
    .default(true),
  stopTargetOnSolve: integer("stop_target_on_solve", { mode: "boolean" })
    .notNull()
    .default(true),
  /** Evaluation mode: on a FULL solve the submitting agent is terminated
   * immediately (no write-up wrap-up — the platform only scores flags).
   * Default false: the submitter keeps its session to write up, bounded by
   * the solved wrap-up deadline. */
  stopSubmitterOnSolve: integer("stop_submitter_on_solve", {
    mode: "boolean",
  })
    .notNull()
    .default(false),
  /** 'eager' = a solved challenge frees its target slot at flag acceptance;
   * 'drained' = it holds the slot until its last agent goes terminal. */
  nextTaskPolicy: text("next_task_policy").notNull().default("eager"),
  urgentTeamMessages: integer("urgent_team_messages", { mode: "boolean" })
    .notNull()
    .default(true),
  /** A fully-solved challenge rejects new spawns while true. */
  blockSpawnOnSolved: integer("block_spawn_on_solved", { mode: "boolean" })
    .notNull()
    .default(true),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
})

/**
 * Prompt template store (v8). Independent of FlatSettings (which is a closed
 * enum). `(plugin, key)` unique; rows are the 16 builtin keys declared in
 * orchestration/prompt-templates.ts (PROMPT_TEMPLATES registry), seeded at
 * runtime (app boot), not by migration SQL.
 */
export const promptTemplates = sqliteTable(
  "prompt_templates",
  {
    plugin: text("plugin").notNull(),
    key: text("key").notNull(),
    body: text("body").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    unique("prompt_templates_plugin_key_unique").on(table.plugin, table.key),
  ]
)

/**
 * Per-challenge flag records (one-to-many: a challenge may have many flags —
 * "一题多解"). The unified source of truth for the `solved.local` dimension
 * (EXISTS accepted) and for flag provenance (which agent / manual entry /
 * remote submission id). `agentId` is a plain text column (no FK): solve
 * history must survive agent deletion.
 */
export const challengeFlags = sqliteTable(
  "challenge_flags",
  {
    id: text("id").primaryKey(),
    challengeId: text("challenge_id")
      .notNull()
      .references(() => challenges.id, { onDelete: "cascade" }),
    flag: text("flag").notNull(),
    /** pending | accepted | rejected | error (adapter partial/already_solved
     * collapse to accepted — the flag itself was verified). */
    status: text("status")
      .$type<"pending" | "accepted" | "rejected" | "error">()
      .notNull(),
    /** agent = submitted by an agent via submit_flag; manual = recorded by
     * the user. */
    source: text("source").$type<"agent" | "manual">().notNull(),
    /** Submitting agent id (text, no FK — history outlives agent rows). */
    agentId: text("agent_id"),
    remoteId: text("remote_id"),
    message: text("message"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("challenge_flags_challenge_flag_unique").on(
      table.challengeId,
      table.flag
    ),
    index("challenge_flags_challenge_id_idx").on(table.challengeId),
    index("challenge_flags_agent_id_idx").on(table.agentId),
    check(
      "challenge_flags_status_check",
      sql`${table.status} in ('pending', 'accepted', 'rejected', 'error')`
    ),
    check(
      "challenge_flags_source_check",
      sql`${table.source} in ('agent', 'manual')`
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

/**
 * Domain event stream (control-plane §A): the control plane's append-only
 * fact log — who was dispatched, why, what the fence rejected, what a flag
 * verdict was. Projection tables (spawn_queue / queue_state / challenge_flags
 * / challenge_remote / the challenges control fields) are maintained
 * exclusively by the projector (run/domain-events/projector.ts) inside the
 * same transaction as the append. No FKs on the hot dimensions: the stream
 * outlives the entities it references (solve history survives agent
 * deletion, same rule as challenge_flags.agent_id). `events` is already the
 * CTF-competition entity table, hence the table name.
 */
export const domainEvents = sqliteTable(
  "domain_events",
  {
    /** Global monotonic id (also the decision log's paging cursor). */
    id: integer("id").primaryKey({ autoIncrement: true }),
    type: text("type").notNull(),
    /** Hot dimensions — nullable, not every fact carries every dimension. */
    eventId: text("event_id"),
    challengeId: text("challenge_id"),
    agentId: text("agent_id"),
    /** user | agent | system. */
    actorKind: text("actor_kind").$type<DomainEventActorKind>().notNull(),
    /** agentId / 'drainer' / 'progress-machine' / 'platform-sync' / ... */
    actorId: text("actor_id"),
    /** The triggering event's id, when one is naturally at hand. */
    causationId: integer("causation_id"),
    /** Type-registered JSON payload (run/domain-events/registry.ts). */
    payload: text("payload").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("domain_events_type_id_idx").on(table.type, table.id),
    index("domain_events_event_id_id_idx").on(table.eventId, table.id),
    index("domain_events_challenge_id_id_idx").on(table.challengeId, table.id),
    index("domain_events_agent_id_id_idx").on(table.agentId, table.id),
    index("domain_events_causation_id_idx").on(table.causationId),
  ]
)

/**
 * Decision-point state projection (C 批): the decision engine's durable half —
 * one row per event, maintained by the projector from the decision_point fact
 * family inside the append transaction. The engine hydrates these rows at boot
 * (memory stays the working representation; this table is what survives a
 * restart): `pending` is the JSON array of coalescing DecisionTriggers,
 * `open_point_id` the decision point currently driving (an orphan at boot is
 * closed error/reason=boot), `violations` the consecutive no-plan closes,
 * `stall` the armed quiet-stall episode JSON, `quiet_fingerprint` the last
 * explicit no-decision's fleet fingerprint (the periodic skip). errorRetries
 * is deliberately absent — retry bookkeeping is lossy by design. No FK, same
 * rule as plan_refs / domain_events: rows live for the event's lifetime and
 * are torn down by the event-deletion path (decision engine's forget).
 */
export const decisionState = sqliteTable("decision_state", {
  eventId: text("event_id").primaryKey(),
  /** JSON array of DecisionTrigger objects awaiting the next point. */
  pending: text("pending").notNull().default("[]"),
  /** The open decision point's id, null when idle. */
  openPointId: text("open_point_id"),
  /** Consecutive no-plan closes since the last plan (or escalation). */
  violations: integer("violations").notNull().default(0),
  /** JSON stall episode { pointId, sinceMs, fingerprint, escalated } or null. */
  stall: text("stall"),
  /** Fleet fingerprint at the last explicit no-decision close, or null. */
  quietFingerprint: text("quiet_fingerprint"),
})

/**
 * Plan-ref idempotency projection (B 批)：the applier's (scheduler, ref) dedup
 * key materialized. The projector maintains it from `plan.proposed` (one row
 * per action ref — first proposal owns the row) and `plan.result` (fills
 * `outcome`) inside the append transaction. `canonical` is the sorted-key
 * JSON of the action, so identical-content resubmissions replay idempotently
 * while a ref reuse with different content reads as duplicate_ref. No FKs —
 * plan history outlives agent rows (domain_events convention); rows live for
 * the event's lifetime like the fact stream they project.
 */
export const planRefs = sqliteTable(
  "plan_refs",
  {
    eventId: text("event_id").notNull(),
    /** The submitter key the dedup resolves against (agent id / 'user' /
     * 'system') — mirrors plan.proposed's schedulerAgentId. */
    schedulerAgentId: text("scheduler_agent_id").notNull(),
    ref: text("ref").notNull(),
    canonical: text("canonical").notNull(),
    planId: text("plan_id").notNull(),
    /** The per-ref result as JSON once plan.result landed; null while the
     * plan's deferred application chain is still running. */
    outcome: text("outcome"),
  },
  (table) => [
    primaryKey({
      columns: [table.eventId, table.schedulerAgentId, table.ref],
    }),
    index("plan_refs_plan_id_idx").on(table.planId),
  ]
)
