import type { Api, Model } from "@earendil-works/pi-ai"
import {
  createBashToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent"
import type { PromptTemplateContext } from "../../../shared"
import type { ThinkingLevel } from "../../../shared/thinking"
import {
  type AgentLoopSettings,
  createHostAgentSession,
  type HostAgentSession,
} from "../agents/host-session"
import type { LiveBus } from "../agents/live"
import type { createDatabase } from "../db"
import type { ContainerManager } from "./container/container-manager"
import { createContainerBashOperations } from "./container/container-tools"
import type { RunModelRuntime } from "./model-runtime"
import {
  createMainTools,
  type RunToolContext,
  type ToolCapabilities,
} from "./tools"
import { createDockerExecBackend } from "./workspace/backend"
import { createWorkspaceTools } from "./workspace/tools"

type Database = ReturnType<typeof createDatabase>["db"]

/** Build the main agent's tool set: container bash + file tools + CTF tools. */
export function buildMainAgentTools(
  containerWorkspace: string,
  containerName: string,
  ctx: RunToolContext,
  caps: ToolCapabilities,
  containerManager: ContainerManager
) {
  const bashDef = createBashToolDefinition(containerWorkspace, {
    operations: createContainerBashOperations(containerName, containerManager),
    exposeSessionEnvironment: false,
  })
  const workspaceTools = createWorkspaceTools(
    createDockerExecBackend(containerName, containerManager, containerWorkspace)
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
  containerWorkspace: string
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
): Promise<HostAgentSession> {
  const toolCtx = deps.buildMainToolContext(
    args.runId,
    args.challengeId,
    args.agentId
  )
  const { customTools, toolNames } = buildMainAgentTools(
    args.containerWorkspace,
    args.containerName,
    toolCtx,
    args.caps,
    deps.containerManager
  )
  return createHostAgentSession({
    owner: {
      type: "run",
      id: args.runId,
      runId: args.runId,
      agentId: args.agentId,
    },
    channel: args.runId,
    agentId: args.agentId,
    cwd: args.containerWorkspace,
    ...(args.sessionFile !== undefined
      ? {
          resumeFrom: {
            sessionId: args.sessionFile,
            isJsonl: args.sessionFile.endsWith(".jsonl"),
            sessionsDir: args.sessionsDir,
          },
        }
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
