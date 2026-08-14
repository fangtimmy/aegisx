import type { ContextSnapshot } from "@aegisx/shared/live-event"
import type { ThinkingLevel } from "@aegisx/shared/thinking"
import type { Api, Model } from "@earendil-works/pi-ai"
import {
  type AgentSession,
  createAgentSession,
  createExtensionRuntime,
  type ModelRuntime,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent"

import type { createDatabase } from "../db"
import { DbSessionManager } from "./db-session-manager"
import {
  type AgentEventPipeline,
  computeContextSample,
  createAgentEventPipeline,
} from "./event-pipeline"
import type { LiveBus } from "./live"

type Database = ReturnType<typeof createDatabase>["db"]

/**
 * Who a host-side session belongs to: exactly one agent (and, redundantly
 * for run-level queries, its run). Every session is agent-scoped in v8.
 */
export type SessionOwner = {
  agentId: string
  runId: string
}

/**
 * Resume strategy for an existing session (cold-restore / reopen). Omit for a
 * brand-new session.
 *
 *  - DB sessions resume via `DbSessionManager.open(sessionId, ...)`.
 *  - Legacy pre-migration `.jsonl` sessions resume via pi's file
 *    `SessionManager.open` (not migrated to the DB by design).
 */
export type SessionResume = {
  sessionId: string
  /** When true, `sessionId` is a jsonl path resumed via pi's file manager. */
  isJsonl: boolean
  /** Sessions dir for the jsonl resume path (ignored for DB resumes). */
  sessionsDir?: string
}

/** SDK agent-loop settings resolved from AegisX settings (compaction/retry). */
export type AgentLoopSettings = {
  compaction: { enabled: boolean }
  retry: { enabled: boolean; maxRetries: number }
}

/** A live host-side pi `AgentSession` + its event pipeline + disposal handle.
 * The single shape produced for solver main agents, solver child agents, and
 * the orchestrator — they differ only in owner / tools / system prompt. */
export type HostAgentSession = {
  session: AgentSession
  /** DB session id (or legacy jsonl path) — persists as `agents.sessionFile`. */
  sessionId: string | undefined
  pipeline: AgentEventPipeline
  dispose(): Promise<void>
}

export type CreateHostAgentSessionInput = {
  owner: SessionOwner
  /** LiveBus channel: the run id (solver) or event id (orchestrator). */
  channel: string
  /** Agent id for entry keys + SSE routing (main/child ids, or ORCHESTRATOR_AGENT_ID). */
  agentId: string
  /** Container-internal workspace path surfaced to the model as its cwd (pi
   * appends `Current working directory: <cwd>` to the system prompt). The host
   * bind path must NOT be used here — file tools and bash both operate at this
   * path inside the container. */
  cwd: string
  modelRuntime: ModelRuntime
  model: Model<Api>
  thinkingLevel: ThinkingLevel
  agentSettings: AgentLoopSettings
  /** Fully rendered system prompt (replaces pi defaults; no AGENTS.md loaded). */
  systemPrompt: string
  /** Tool allowlist (builtin names + any custom tool names to enable). */
  toolNames: string[]
  /** Custom tools (container bash override, native CTF/orchestrator tools, ...). */
  customTools: ToolDefinition[]
  /** Resume an existing session; omit for a new session. */
  resumeFrom?: SessionResume
  /** Fired after a commit that may change usage (compaction / branch_summary),
   * so the service can recompute + re-emit its snapshot. */
  onUsageMaybeChanged?: () => void
  db: Database
  bus: LiveBus
}

/** Map a {@link SessionOwner} onto `DbSessionManager` create/open params. */
function ownerManagerOpts(owner: SessionOwner) {
  return { agentId: owner.agentId, runId: owner.runId }
}

/**
 * pi's SessionManager carries private state that defeats a TypeScript
 * `implements`/structural check, so DbSessionManager (validated against pi's
 * SessionManager in db-session-manager.test) is bridged here. This is the
 * single point that crosses the type boundary.
 */
function asSdkSessionManager(sm: DbSessionManager): SessionManager {
  return sm as unknown as SessionManager
}

function minimalResourceLoader(systemPrompt: string): ResourceLoader {
  return {
    getExtensions: () => ({
      extensions: [],
      errors: [],
      runtime: createExtensionRuntime(),
    }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  }
}

/**
 * Create a host-side pi SDK `AgentSession` for any owner kind, wire its event
 * pipeline (committed entries → session_entries, progress → SSE bus), and
 * return handles for the caller to drive prompt/steer/abort lifecycle.
 *
 * Resource loading is a zero-discovery minimal loader: only the rendered system
 * prompt is exposed, so workspace files and global pi resources never leak into
 * the agent context.
 *
 * Persistence: the DB is the single source of truth. DbSessionManager writes
 * `session_entries` as pi appends; its `onAppend(entry, seq)` is the
 * authoritative "entry just persisted" signal (pi emits no equivalent for
 * regular messages — it `_emit`s `message_end` *before* `appendMessage`), so
 * the pipeline's `commitEntry` is driven from there, not from SDK events.
 */
export async function createHostAgentSession(
  input: CreateHostAgentSessionInput
): Promise<HostAgentSession> {
  const {
    owner,
    channel,
    agentId,
    cwd,
    model,
    thinkingLevel,
    modelRuntime,
    agentSettings,
    systemPrompt,
    toolNames,
    customTools,
    db,
    bus,
  } = input

  // --- Session backend selection -------------------------------------------
  //  - new session                              -> DbSessionManager.create
  //  - resume, isJsonl                          -> pi file SessionManager.open
  //    (pre-migration runs keep their jsonl; not migrated per design)
  //  - resume, DB                               -> DbSessionManager.open
  const resume = input.resumeFrom
  let dbSession: DbSessionManager | undefined
  let sessionManager: SessionManager
  if (resume?.isJsonl) {
    sessionManager = SessionManager.open(
      resume.sessionId,
      resume.sessionsDir ?? "",
      cwd
    )
  } else if (resume) {
    dbSession = DbSessionManager.open(resume.sessionId, {
      ...ownerManagerOpts(owner),
      db,
    })
    sessionManager = asSdkSessionManager(dbSession)
  } else {
    dbSession = DbSessionManager.create({ ...ownerManagerOpts(owner), cwd, db })
    sessionManager = asSdkSessionManager(dbSession)
  }

  const settingsManager = SettingsManager.inMemory({
    // Long CTF runs / orchestrator strategy loops need compaction to survive
    // context overflow; retry absorbs transient provider errors. Both
    // configurable via the settings UI.
    compaction: { enabled: agentSettings.compaction.enabled },
    retry: {
      enabled: agentSettings.retry.enabled,
      maxRetries: agentSettings.retry.maxRetries,
    },
  })
  const resourceLoader = minimalResourceLoader(systemPrompt)

  // The session is created below; sampleContext reads it via this ref so the
  // pipeline (built first) can emit context snapshots once it exists.
  let sessionRef: AgentSession | null = null
  const sampleContext = (): ContextSnapshot | null =>
    sessionRef ? computeContextSample(sessionRef) : null

  const pipeline = createAgentEventPipeline({
    channel,
    agentId,
    bus,
    sampleContext,
    onUsageMaybeChanged: input.onUsageMaybeChanged,
  })

  // Legacy jsonl backends have no onAppend/metaProvider; their runs have no
  // session_entries rows either (the pipeline only carries ephemeral SSE).
  // metaProvider is pre-commit (writes the meta column); onAppend stays
  // post-insert (SSE notification only).
  if (dbSession) {
    dbSession.metaProvider = (entry) => pipeline.metaFor(entry)
    dbSession.onAppend = (entry, seq) => pipeline.commitEntry(entry, seq)
  }

  const { session } = await createAgentSession({
    cwd,
    model,
    thinkingLevel,
    modelRuntime,
    sessionManager,
    settingsManager,
    resourceLoader,
    tools: toolNames,
    customTools,
  })
  sessionRef = session
  const unsubscribe = session.subscribe((event) => pipeline.handle(event))

  return {
    session,
    sessionId: session.sessionFile,
    pipeline,
    async dispose() {
      unsubscribe()
      session.dispose()
    },
  }
}
