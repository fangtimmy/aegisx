import type { Api, Model } from "@earendil-works/pi-ai"
import {
  type AgentSession,
  createAgentSession,
  createExtensionRuntime,
  type ResourceLoader,
  type SessionEntry,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent"
import type { ContextSnapshot } from "../../../shared/live-event"
import type { ThinkingLevel } from "../../../shared/thinking"
import type { createDatabase } from "../db"
import { DbSessionManager } from "./db-session-manager"
import { computeContextSample, createRunEventPipeline } from "./events"
import type { LiveBus } from "./live"

type Database = ReturnType<typeof createDatabase>["db"]

export type CreateAgentSessionInput = {
  runId: string
  agentId: string
  /** Host workspace path (file tools operate here; bind target is /workspace). */
  workspaceHostPath: string
  /** SessionManager root dir for this run (data/runs/<id>/sessions). */
  sessionsDir: string
  /** Existing session file to resume; omit for a new session. */
  sessionFile?: string
  modelRuntime: import("@earendil-works/pi-coding-agent").ModelRuntime
  model: Model<Api>
  thinkingLevel: ThinkingLevel
  /** SDK agent-loop settings (compaction/retry) resolved from AegisX settings. */
  agentSettings: {
    compaction: { enabled: boolean }
    retry: { enabled: boolean; maxRetries: number }
  }
  /** Fully rendered system prompt (replaces pi defaults; no AGENTS.md loaded). */
  systemPrompt: string
  /** Tool allowlist (builtin names + any custom tool names to enable). */
  toolNames: string[]
  /** Custom tools (container bash override, native CTF tools, ...). */
  customTools: ToolDefinition[]
  /** Fired after a commit that may change run-wide usage (compaction), so the
   * service can recompute + re-emit the run snapshot. */
  onUsageMaybeChanged?: () => void
  db: Database
  bus: LiveBus
}

export type RunAgentSession = {
  session: AgentSession
  sessionFile: string | undefined
  pipeline: ReturnType<typeof createRunEventPipeline>
  dispose(): Promise<void>
}

/**
 * Create a pi SDK AgentSession for a run agent (main or child), wire its event
 * pipeline (committed messages → run_events, progress → SSE bus), and return
 * handles for the service to drive prompt/steer/abort lifecycle.
 *
 * Resource loading is a zero-discovery minimal loader: only the rendered system
 * prompt is exposed, so challenge workspace files and global pi resources never
 * leak into the agent context.
 */
export async function createRunAgentSession(
  input: CreateAgentSessionInput
): Promise<RunAgentSession> {
  // Session backend selection:
  //  - new run (no sessionFile)              -> DbSessionManager.create (database)
  //  - resume, sessionFile ends in `.jsonl`  -> legacy file SessionManager.open
  //    (pre-migration runs keep their jsonl; not migrated per design)
  //  - resume, sessionFile is a db session id -> DbSessionManager.open (database)
  const sessionManager = input.sessionFile?.endsWith(".jsonl")
    ? SessionManager.open(
        input.sessionFile,
        input.sessionsDir,
        input.workspaceHostPath
      )
    : input.sessionFile
      ? (DbSessionManager.open(input.sessionFile, {
          runId: input.runId,
          agentId: input.agentId,
          db: input.db,
        }) as unknown as SessionManager)
      : (DbSessionManager.create({
          cwd: input.workspaceHostPath,
          runId: input.runId,
          agentId: input.agentId,
          db: input.db,
        }) as unknown as SessionManager)

  const settingsManager = SettingsManager.inMemory({
    // Long CTF runs need compaction to survive context overflow; retry absorbs
    // transient provider errors. Configurable via the settings UI.
    compaction: { enabled: input.agentSettings.compaction.enabled },
    retry: {
      enabled: input.agentSettings.retry.enabled,
      maxRetries: input.agentSettings.retry.maxRetries,
    },
  })

  const resourceLoader = minimalResourceLoader(input.systemPrompt)

  // The session is created below; sampleContext + getSessionEntries read it
  // via this ref so the pipeline (built first) can emit context snapshots and
  // committed messages once it exists.
  let sessionRef: AgentSession | null = null
  const sampleContext = (): ContextSnapshot | null =>
    sessionRef ? computeContextSample(sessionRef) : null
  const getSessionEntries = (): SessionEntry[] | null =>
    sessionRef ? sessionRef.sessionManager.getEntries() : null

  const pipeline = createRunEventPipeline({
    runId: input.runId,
    agentId: input.agentId,
    bus: input.bus,
    getSessionEntries,
    sampleContext,
    onUsageMaybeChanged: input.onUsageMaybeChanged,
  })

  const { session } = await createAgentSession({
    cwd: input.workspaceHostPath,
    model: input.model,
    thinkingLevel: input.thinkingLevel,
    modelRuntime: input.modelRuntime,
    sessionManager,
    settingsManager,
    resourceLoader,
    tools: input.toolNames,
    customTools: input.customTools,
  })
  sessionRef = session

  const unsubscribe = session.subscribe((event) => pipeline.handle(event))

  return {
    session,
    sessionFile: session.sessionFile,
    pipeline,
    async dispose() {
      unsubscribe()
      session.dispose()
    },
  }
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
