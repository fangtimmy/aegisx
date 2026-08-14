import type { ThinkingLevel } from "@aegisx/shared/live-event"
import type { Api, Model } from "@earendil-works/pi-ai"
import type {
  ModelRuntime,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent"

import type { Database } from "../db"
import { createBashTool } from "../run/bash-tool"
import type { ContainerManager } from "../run/container/container-manager"
import { createDockerExecBackend } from "../run/workspace/backend"
import { createWorkspaceTools } from "../run/workspace/tools"
import {
  type AgentLoopSettings,
  createHostAgentSession,
  type HostAgentSession,
  type SessionOwner,
  type SessionResume,
} from "./host-session"
import type { LiveBus } from "./live"

/**
 * Builtin file/coding tools every host agent gets. They operate on the shared
 * container workspace (the agent's cwd). Profile-specific tools (CTF / run
 * management) are layered on top via {@link createAgentHost}'s `extraTools`.
 */
const HOST_FILE_TOOLS = ["read", "bash", "edit", "write"] as const

/**
 * Build the container-backed bash + file-workspace tool pair shared by every
 * host agent — solver main, solver child (worker), and the orchestrator. The
 * one place that knows how file tools reach a container.
 *
 * `multimodal` (derived from the model's `input` modalities) gates whether
 * `read` attaches image bytes for image files; pass false for text-only models.
 */
function buildHostFileTools(
  cwd: string,
  containerName: string,
  containerManager: ContainerManager,
  multimodal = false
): ToolDefinition[] {
  return [
    createBashTool(cwd, containerName, containerManager),
    ...createWorkspaceTools(
      createDockerExecBackend(containerName, containerManager, cwd),
      { multimodal }
    ),
  ]
}

export type AgentHostInput = {
  /** Who the session belongs to (run agent vs. orchestrator). */
  owner: SessionOwner
  /** LiveBus channel: the run id (solver) or event id (orchestrator). */
  channel: string
  /** Agent id for entry keys + SSE routing (main/child ids, ORCHESTRATOR_AGENT_ID). */
  agentId: string
  /** Container-internal workspace path surfaced to the model as its cwd. */
  cwd: string
  /** Live container the bash/file tools target. The host does NOT create it —
   * the owning service manages container lifecycle (incl. cleanup-on-failure),
   * then hands the container name here. Solver children reuse their run's
   * container; the orchestrator and solver main each own one. */
  containerName: string
  containerManager: ContainerManager
  modelRuntime: ModelRuntime
  model: Model<Api>
  thinkingLevel: ThinkingLevel
  agentSettings: AgentLoopSettings
  /** Fully rendered system prompt. */
  systemPrompt: string
  /** Profile-specific tools (CTF / management), merged after the file tools.
   * Omit for agents that get file tools only (solver children). */
  extraTools?: ToolDefinition[]
  /** Profile-specific tool names to enable. HOST_FILE_TOOLS are always added. */
  extraToolNames?: string[]
  /** Resume an existing session; omit for a new session. */
  resumeFrom?: SessionResume
  /** Fired after a commit that may change usage (compaction / branch_summary). */
  onUsageMaybeChanged?: () => void
  db: Database
  bus: LiveBus
}

/**
 * Create a host-side pi `AgentSession` for ANY agent kind — solver main, solver
 * child (worker), or orchestrator. This is the single, homogeneous creation
 * path: it wires the shared container file tools, merges the profile's extra
 * tools, and builds the host session (event pipeline + DbSessionManager +
 * zero-discovery resource loader).
 *
 * The three agent kinds are the same agent with a different profile — they
 * differ only in `owner`, `systemPrompt`, and `extraTools`. Routing all three
 * through here is what makes them isomorphic, and it is the seam future dynamic
 * agent templates will build on (a template supplies a system prompt + a tool
 * set; the host turns it into a live session).
 *
 * It is also the test seam: services accept a `createHost` override (default =
 * this) so tests inject a stub {@link HostAgentSession} and skip the real pi
 * session + model.
 */
export async function createAgentHost(
  input: AgentHostInput
): Promise<HostAgentSession> {
  const fileTools = buildHostFileTools(
    input.cwd,
    input.containerName,
    input.containerManager,
    input.model.input.includes("image")
  )
  const customTools: ToolDefinition[] = [
    ...fileTools,
    ...(input.extraTools ?? []),
  ]
  const toolNames: string[] = [
    ...HOST_FILE_TOOLS,
    ...(input.extraToolNames ?? []),
  ]
  return createHostAgentSession({
    owner: input.owner,
    channel: input.channel,
    agentId: input.agentId,
    cwd: input.cwd,
    modelRuntime: input.modelRuntime,
    model: input.model,
    thinkingLevel: input.thinkingLevel,
    agentSettings: input.agentSettings,
    systemPrompt: input.systemPrompt,
    toolNames,
    customTools,
    ...(input.resumeFrom ? { resumeFrom: input.resumeFrom } : {}),
    ...(input.onUsageMaybeChanged
      ? { onUsageMaybeChanged: input.onUsageMaybeChanged }
      : {}),
    db: input.db,
    bus: input.bus,
  })
}
