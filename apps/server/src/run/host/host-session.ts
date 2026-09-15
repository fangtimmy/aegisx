import type { ContextSnapshot } from "@aegisx/shared/live-event"
import type { ThinkingLevel } from "@aegisx/shared/live-event"
import type { Api, Model } from "@earendil-works/pi-ai"
import {
  type AgentSession,
  createAgentSession,
  createExtensionRuntime,
  type ModelRuntime,
  type ResourceLoader,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent"

import type { Database } from "../../db"
import {
  type AgentEventPipeline,
  computeContextSample,
  createAgentEventPipeline,
} from "./event-pipeline"
import type { LiveBus } from "./live"
import { PiSessionAdapter } from "./pi-session-adapter"

/**
 * Who a host-side session belongs to: exactly one agent (v19 — sessions
 * are agent-scoped; the workspace/context layering lives above this).
 */
export type SessionOwner = {
  agentId: string
}

/**
 * Resume an existing DB session (cold-restore / reopen). Omit for a
 * brand-new session.
 */
export type SessionResume = {
  sessionId: string
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
  /** DB session id — persists as `agents.sessionFile`. */
  sessionId: string | undefined
  pipeline: AgentEventPipeline
  dispose(): Promise<void>
}

export type CreateHostAgentSessionInput = {
  owner: SessionOwner
  /** LiveBus channel: the agent id. */
  channel: string
  /** Agent id for entry keys + SSE routing. */
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
  /** Data dir root — the session archive's home (transparent merged reads
   * on resume). */
  dataDir: string
  db: Database
  bus: LiveBus
}

/** Map a {@link SessionOwner} onto the session adapter create/open params. */
function ownerManagerOpts(owner: SessionOwner) {
  return { agentId: owner.agentId }
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
 * Persistence: the DB is the single source of truth. PiSessionAdapter writes
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

  // --- Session backend: the DB is the single backend ------------------------
  //  - new session  -> PiSessionAdapter.create
  //  - resume       -> PiSessionAdapter.open
  const resume = input.resumeFrom
  const sessionManager = resume
    ? PiSessionAdapter.open(resume.sessionId, {
        ...ownerManagerOpts(owner),
        db,
        dataDir: input.dataDir,
      })
    : PiSessionAdapter.create({ ...ownerManagerOpts(owner), cwd, db })
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
    sessionId: sessionManager.getSessionId(),
    bus,
    sampleContext,
    onUsageMaybeChanged: input.onUsageMaybeChanged,
  })

  // metaProvider is pre-commit (writes the meta column); onAppend stays
  // post-insert (SSE notification only).
  sessionManager.metaProvider = (entry) => pipeline.metaFor(entry)
  sessionManager.onAppend = (entry, seq) => pipeline.commitEntry(entry, seq)

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
      // pi's abort does not interrupt an in-flight tool call; a late
      // message_end must not append through the retired manager and fork the
      // session tree against the reopened one.
      sessionManager.close()
    },
  }
}
