import type { Api, Model } from "@earendil-works/pi-ai"
import {
  createBashToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent"
import type { PromptTemplateContext } from "../../../shared"
import type { ThinkingLevel } from "../../../shared/thinking"
import type { createDatabase } from "../db"
import type { ContainerManager } from "./container/container-manager"
import { createContainerBashOperations } from "./container/container-tools"
import type { RunModelRuntime } from "./model-runtime"
import {
  createRunAgentSession,
  type RunAgentSession,
} from "./session/agent-session"
import type { LiveBus } from "./session/live"
import {
  createMainTools,
  type RunToolContext,
  type ToolCapabilities,
} from "./tools"
import { createDockerExecBackend } from "./workspace/backend"
import { createWorkspaceTools } from "./workspace/tools"

type Database = ReturnType<typeof createDatabase>["db"]

/** SDK agent-loop settings resolved from AegisX settings (compaction/retry). */
export type AgentLoopSettings = {
  compaction: { enabled: boolean }
  retry: { enabled: boolean; maxRetries: number }
}

/** Build the main agent's tool set: container bash + file tools + CTF tools. */
export function buildMainAgentTools(
  workspaceHostPath: string,
  containerName: string,
  ctx: RunToolContext,
  caps: ToolCapabilities,
  containerManager: ContainerManager
) {
  const bashDef = createBashToolDefinition(workspaceHostPath, {
    operations: createContainerBashOperations(containerName, containerManager),
  })
  const workspaceTools = createWorkspaceTools(
    createDockerExecBackend(containerName, containerManager)
  )
  const nativeTools = createMainTools(ctx, caps)
  return {
    customTools: [
      bashDef,
      ...workspaceTools,
      ...nativeTools,
    ] as ToolDefinition[],
    toolNames: [
      "read",
      "bash",
      "edit",
      "write",
      "grep",
      "find",
      "ls",
      ...nativeTools.map((tool) => tool.name),
    ],
  }
}

export type ProvisionArgs = {
  runId: string
  agentId: string
  workspaceHostPath: string
  sessionsDir: string
  /** Omit for a new session; pass the existing session id/file to resume. */
  sessionFile?: string
  modelRuntime: RunModelRuntime
  sdkModel: Model<Api>
  thinkingLevel: ThinkingLevel
  systemPrompt: string
  containerName: string
  challengeId: string
  promptContext: PromptTemplateContext
  caps: ToolCapabilities
}

export type ProvisionDeps = {
  db: Database
  bus: LiveBus
  containerManager: ContainerManager
  agentSettings: () => AgentLoopSettings
  buildMainToolContext: (
    runId: string,
    challengeId: string,
    agentId: string
  ) => RunToolContext
  onUsageMaybeChanged: (runId: string) => void
}

/**
 * Assemble the main agent's session: native tool context + tool set, then the
 * pi `AgentSession`. This is the shared body of `create` (new run) and
 * `ensureWarm` (cold-restore) — the two differ only in how they source the
 * model/container/prompt and how they clean up on failure, so the caller owns
 * both. Registration (contexts/sessions maps) also stays with the caller.
 *
 * Throws if session creation fails; the caller wraps that in its own cleanup.
 */
export async function provisionRunSession(
  args: ProvisionArgs,
  deps: ProvisionDeps
): Promise<RunAgentSession> {
  const toolCtx = deps.buildMainToolContext(
    args.runId,
    args.challengeId,
    args.agentId
  )
  const { customTools, toolNames } = buildMainAgentTools(
    args.workspaceHostPath,
    args.containerName,
    toolCtx,
    args.caps,
    deps.containerManager
  )
  return createRunAgentSession({
    runId: args.runId,
    agentId: args.agentId,
    workspaceHostPath: args.workspaceHostPath,
    sessionsDir: args.sessionsDir,
    ...(args.sessionFile !== undefined
      ? { sessionFile: args.sessionFile }
      : {}),
    modelRuntime: args.modelRuntime,
    model: args.sdkModel,
    thinkingLevel: args.thinkingLevel,
    agentSettings: deps.agentSettings(),
    systemPrompt: args.systemPrompt,
    toolNames,
    customTools,
    onUsageMaybeChanged: () => deps.onUsageMaybeChanged(args.runId),
    db: deps.db,
    bus: deps.bus,
  })
}
