import { sql } from "drizzle-orm"
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/sqlite-core"

/** Schema major version stored in SQLite user_version. */
export const SCHEMA_VERSION = 14

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
    /** Manual solve-state override (user-assigned). Drives `solved.manual`. */
    manualSolveState: text("manual_solve_state").notNull().default("unsolved"),
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
 * v8 runs: the single deployment unit. A run = one scope (challenge or event)
 * + a shared container/workspace + N agents. The event-scoped run
 * (scopeType='event') IS the scheduler — the former standalone `orchestrators`
 * table is merged in here.
 *
 * Run status is SQL-derived from agent statuses (running↔idle) plus
 * sanctioned explicit `closed` transitions (finish / close / timeout-SIGKILL /
 * recoverOnBoot). The `finishing` column is set atomically by finish_run
 * (rows-affected decides who teardowns); once set the aggregate SQL won't flip
 * the run back to idle.
 */
export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    /** challenge-scope solver run, or event-scope scheduler run. */
    scopeType: text("scope_type").notNull(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    /** Set for challenge-scoped runs; null for event-scope (scheduler). */
    challengeId: text("challenge_id").references(() => challenges.id, {
      onDelete: "cascade",
    }),
    status: text("status").notNull(),
    /** Atomic finish_run flag: the agent whose conditional UPDATE sets this is
     * responsible for teardown; others no-op. */
    finishing: integer("finishing", { mode: "boolean" })
      .notNull()
      .default(false),
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
    /** Canonical model ref string (`<providerKey>/<modelId>:<effort>` | alias).
     * The run default model — spawn children fall back to it; per-agent models
     * on `agents` override. Resolved to a provider+model at use time. */
    model: text("model").notNull(),
    // Challenge-domain scheduling metadata
    source: text("source").notNull().default("manual"),
    timeoutMs: integer("timeout_ms"),
    deadlineAt: text("deadline_at"),
    summary: text("summary"),
    error: text("error"),
    /** Back-filled when the scheduler drainer launches this run; used with
     * `runId` to guard the run→queue done transition. The FK to run_queue
     * exists in the DB (declared in the v8 migration) but is intentionally
     * omitted from the TS schema to avoid a runs↔run_queue circular type
     * inference cycle (TS7022); the reverse direction (run_queue.run_id →
     * runs) is declared on run_queue instead. */
    queueItemId: text("queue_item_id"),
    // Structured snapshots (independent columns)
    /** Reserved; v9 always writes `{}` (solver specs live on the create input
     * / run_queue.params). */
    params: text("params").notNull().default("{}"),
    /** Timestamp of the last timeout fire (Timeline source; outcome event). */
    lastTimeoutAt: text("last_timeout_at"),
    /** Misc JSON metadata. */
    meta: text("meta").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    startedAt: text("started_at"),
    updatedAt: text("updated_at").notNull(),
    completedAt: text("completed_at"),
  },
  (table) => [
    index("runs_challenge_id_idx").on(table.challengeId),
    index("runs_scope_event_idx").on(table.scopeType, table.eventId),
    // At most one scheduler (event-scoped) run per event.
    uniqueIndex("runs_event_scheduler_unique")
      .on(table.eventId)
      .where(sql`${table.scopeType} = 'event'`),
    check(
      "runs_scope_type_check",
      sql`${table.scopeType} in ('challenge', 'event')`
    ),
    check(
      "runs_status_check",
      sql`${table.status} in ('running', 'idle', 'closed')`
    ),
    check("runs_source_check", sql`${table.source} in ('manual', 'scheduler')`),
  ]
)

/**
 * Agents within a run: generalized (v8). An agent = one pi session + a role +
 * a model + a system prompt + tools, all snapshotted on the row at createAgent
 * time. Cold-restore reuses the snapshot verbatim (per-agent model switches /
 * prompt edits survive). `entry` is the DB-enforced "default conversation
 * agent" (at most one per run via a partial unique index); v9 runs have no
 * spawn children (parentAgentId stays null).
 */
export const agents = sqliteTable(
  "agents",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    /** Run-unique agent slot: `solver-N` (solvers) / `orchestrator` (event
     * scheduler). */
    slot: text("slot").notNull(),
    /** Free-form role ('solver' / 'orchestrator'). */
    role: text("role").notNull(),
    /** Kept for schema stability; always null in v9 (spawn child removed). */
    parentAgentId: text("parent_agent_id"),
    /** Entry agent flag (run-level default conversation target). At most one
     * per run (partial unique index). */
    isEntry: integer("is_entry", { mode: "boolean" }).notNull().default(false),
    /** Canonical model ref string (`<providerKey>/<modelId>:<effort>` | alias).
     * Per-agent snapshot — createAgent writes it once; cold-restore reuses it
     * verbatim (per-agent model switches survive). */
    model: text("model").notNull(),
    // Prompt + tools snapshot (createAgent writes once; cold-restore reuses)
    systemPrompt: text("system_prompt").notNull(),
    /** JSON array of real tool names (file tools always on, not listed). */
    tools: text("tools").notNull(),
    /** JSON array of active tool-definition snapshots (name / description /
     * JSON-Schema parameters), written when the host session is created so the
     * timeline can render real tool schemas incl. the always-on file tools.
     * Null on pre-v11 rows / agents never brought online. */
    toolDefinitions: text("tool_definitions"),
    status: text("status").notNull(),
    /** DB session id (or legacy jsonl path) for this agent (resume + audit). */
    sessionFile: text("session_file"),
    name: text("name"),
    /** Delegated task text (spawn children). */
    task: text("task"),
    createdAt: text("created_at").notNull(),
    startedAt: text("started_at"),
    updatedAt: text("updated_at").notNull(),
    completedAt: text("completed_at"),
    error: text("error"),
  },
  (table) => [
    index("agents_run_id_idx").on(table.runId),
    unique("agents_run_slot_unique").on(table.runId, table.slot),
    // DB-level "at most one entry agent per run".
    uniqueIndex("agents_run_entry_unique")
      .on(table.runId)
      .where(sql`${table.isEntry} = 1`),
    check(
      "agents_status_check",
      sql`${table.status} in ('running', 'idle', 'completed', 'aborted', 'failed')`
    ),
  ]
)

/**
 * Database-backed session tree (replaces per-agent jsonl files).
 *
 * One `sessions` row = one pi session (one agent's conversation), owned by
 * exactly one agent. Each `session_entries` row is one append-only
 * SessionTreeEntry — byte-for-byte the JSON pi would have written to a jsonl
 * line. `session_entries` carries a redundant `runId` (kept in sync) so run-
 * level message queries stay single-table. Driven by `DbSessionManager`.
 */
export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    cwd: text("cwd").notNull(),
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
    /** Redundant runId (kept in sync) for run-level message queries. */
    runId: text("run_id").references(() => runs.id, { onDelete: "cascade" }),
    parentId: text("parent_id"),
    /** Monotonic append order within the session (= jsonl line number). */
    seq: integer("seq").notNull(),
    type: text("type").notNull(),
    /** Full SessionEntry JSON (byte-for-byte a pi jsonl line). */
    data: text("data").notNull(),
    /** Timing metadata JSON (nullable; v10). Assistant message rows carry
     * durationMs + per-block timing; toolResult rows carry durationMs; all
     * other rows + pre-v10 rows are null. Produced by the event pipeline and
     * injected pre-commit via DbSessionManager.metaProvider. */
    meta: text("meta"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("session_entries_session_seq_unique").on(
      table.sessionId,
      table.seq
    ),
    index("session_entries_agent_seq_idx").on(table.agentId, table.seq),
    index("session_entries_run_seq_idx").on(table.runId, table.seq),
    index("session_entries_session_type_idx").on(table.sessionId, table.type),
  ]
)

/**
 * Scheduler task queue (v8). Persistent, FIFO by `ord`. The scheduler
 * orchestrator manages it via explicit queue CRUD tools (enqueue/list/remove/
 * clear/reorder) — there is no turn-boundary prune. Status lifecycle:
 * pending → (drainer launches) → running (runId back-filled) → (run
 * closed/finished, guarded by runs.queueItemId + runId) → done; launch failure
 * → failed (error recorded + scheduler notified). DELETE allowed on
 * pending/done/cancelled/failed (running rejected).
 */
/**
 * Per-event queue state (W2). One row per event; absent row = `running`
 * (a fresh event's queue drains immediately, no explicit enable needed).
 * `paused` blocks future launches only — already-running runs are untouched
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

export const runQueue = sqliteTable(
  "run_queue",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    ord: integer("ord").notNull(),
    challengeId: text("challenge_id")
      .notNull()
      .references(() => challenges.id, { onDelete: "cascade" }),
    /** Solver creation options JSON (`strategy` / `model` / `solverCount` /
     * `solvers`); the drainer passes them through to create. */
    params: text("params").notNull(),
    timeoutMs: integer("timeout_ms"),
    /** Overrides the rendered `initial` template as the run's first prompt. */
    prompt: text("prompt").notNull(),
    source: text("source").notNull(),
    status: text("status").notNull().default("pending"),
    /** Back-filled when the drainer launches the run. */
    runId: text("run_id").references(() => runs.id, { onDelete: "cascade" }),
    error: text("error"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("run_queue_event_ord_idx").on(table.eventId, table.ord),
    index("run_queue_status_idx").on(table.status),
    index("run_queue_run_id_idx").on(table.runId),
    check(
      "run_queue_source_check",
      sql`${table.source} in ('manual', 'scheduler')`
    ),
    check(
      "run_queue_status_check",
      sql`${table.status} in ('pending', 'running', 'done', 'cancelled', 'failed')`
    ),
  ]
)

/**
 * Per-event scheduler policy (1:1 with events). Replaces the v7
 * `orchestrators` config columns. "Enabled" is no longer a stored flag (v8:
 * enabled = a non-closed scheduler run exists); reboot behavior is unchanged —
 * recoverOnBoot marks running/idle scheduler runs closed and there is no
 * auto-start, so a manual start is required after restart.
 */
export const schedulerConfig = sqliteTable("scheduler_config", {
  eventId: text("event_id")
    .primaryKey()
    .references(() => events.id, { onDelete: "cascade" }),
  /** Per-event scheduler model override (canonical model ref string
   * `<providerKey>/<modelId>:<effort>` | alias); null = fall back to the
   * global default model. */
  modelId: text("model_id"),
  /** Natural-language steering ("hit crypto first, leave pwn for last"). */
  instruction: text("instruction").notNull().default(""),
  maxConcurrentTargets: integer("max_concurrent_targets").notNull().default(1),
  /** Scheduler disabled (W3): while 1 the event's run-lifecycle events are
   * dropped before they reach the orchestrator (silent; the container is kept
   * warm). The flag is writable even with no scheduler run — presets the next
   * start. */
  paused: integer("paused", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
})

/**
 * Prompt template store (v8). Independent of FlatSettings (which is a closed
 * enum). `(plugin, key)` unique; v9 only uses `plugin='builtin'` with the four
 * built-in keys (mainSystem/initial/orchestratorSystem/schedulerInitial). Rows
 * are seeded at runtime (app boot), not by migration SQL.
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
 * (EXISTS accepted) and for flag provenance (which run / manual entry / remote
 * submission id). `runId` still references `runs`; after a v7→v8 execution-
 * state wipe, run-sourced rows keep their (now historical) runId while the
 * flag/challenge association survives.
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
    status: text("status").notNull(),
    /** run = submitted by a run via submit_flag; manual = recorded by the user. */
    source: text("source").notNull(),
    /** Plain text column (no FK): after a v7→v8 execution-state wipe the value
     * dangles historically, and solve history must survive run deletion — so the
     * runs FK (and its ON DELETE CASCADE) is intentionally dropped in v8. */
    runId: text("run_id"),
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
    index("challenge_flags_run_id_idx").on(table.runId),
    check(
      "challenge_flags_status_check",
      sql`${table.status} in ('pending', 'accepted', 'rejected', 'error')`
    ),
    check(
      "challenge_flags_source_check",
      sql`${table.source} in ('run', 'manual')`
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
