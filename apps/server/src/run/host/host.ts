import type { ThinkingLevel } from "@aegisx/shared/live-event"
import type { Api, Model } from "@earendil-works/pi-ai"
import type {
  ModelRuntime,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent"

import type { Database } from "../../db"
import { createBashTool } from "../bash-tool"
import type { ContainerManager } from "../container/container-manager"
import { createDockerExecBackend } from "../workspace/backend"
import { createWorkspaceTools } from "../workspace/tools"
import {
  type AgentLoopSettings,
  createHostAgentSession,
  type HostAgentSession,
  type SessionOwner,
  type SessionResume,
} from "./host-session"
import type { LiveBus } from "./live"

/**
 * Builtin file/coding tools every host agent gets. They operate on the
 * agent's own workspace directory (the bash cwd + host file-tool root);
 * other workspace areas (shared/, attachments/, sibling agents) are
 * reachable read-only via absolute container paths.
 */
const HOST_FILE_TOOLS = ["read", "bash", "edit", "write"] as const

/**
 * Build the container-backed bash + file-workspace tool pair shared by every
 * host agent — solver and orchestrator alike. The one place that knows how
 * file tools reach a container.
 *
 * `multimodal` (derived from the model's `input` modalities) gates whether
 * `read` attaches image bytes for image files; pass false for text-only models.
 */
function buildHostFileTools(
  cwd: string,
  containerName: string,
  containerManager: ContainerManager,
  multimodal = false,
  execEnv?: () => string[]
): ToolDefinition[] {
  return [
    createBashTool(cwd, containerName, containerManager, execEnv),
    ...createWorkspaceTools(
      createDockerExecBackend(containerName, containerManager, cwd),
      { multimodal }
    ),
  ]
}

export type AgentHostInput = {
  /** Who the session belongs to (exactly one agent). */
  owner: SessionOwner
  /** LiveBus channel: the agent id — every event for this agent (progress,
   * commits, context, channel pushes) publishes on its own channel. */
  channel: string
  /** Agent id for entry keys + SSE routing. */
  agentId: string
  /** Container-internal directory surfaced to the model as its cwd (the
   * agent's own directory for solvers, the workspace root for the
   * orchestrator). */
  cwd: string
  /** Live container the bash/file tools target. The host does NOT create it —
   * the factory manages container lifecycle (incl. cleanup-on-failure),
   * then hands the container name here. */
  containerName: string
  containerManager: ContainerManager
  modelRuntime: ModelRuntime
  model: Model<Api>
  thinkingLevel: ThinkingLevel
  agentSettings: AgentLoopSettings
  /** Fully rendered system prompt. */
  systemPrompt: string
  /** Profile-specific tools (CTF / management), merged after the file tools. */
  extraTools?: ToolDefinition[]
  /** Profile-specific tool names to enable. HOST_FILE_TOOLS are always added. */
  extraToolNames?: string[]
  /** Resume an existing session; omit for a new session. */
  resumeFrom?: SessionResume
  /** Per-exec env provider for the bash tool — identity (AEGISX_AGENT_ID +
   * a freshly minted AEGISX_TOKEN) is evaluated at each bash execute so an
   * agent idling past one token TTL still gets valid credentials. */
  execEnv?: () => string[]
  /** Fired after a commit that may change usage (compaction / branch_summary). */
  onUsageMaybeChanged?: () => void
  db: Database
  bus: LiveBus
}

/**
 * Create a host-side pi `AgentSession` for ANY agent kind — solver or the
 * event scheduler. This is the single, homogeneous creation path: it wires
 * the shared container file tools, merges the profile's extra tools, and
 * builds the host session (event pipeline + PiSessionAdapter +
 * zero-discovery resource loader).
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
    input.model.input.includes("image"),
    input.execEnv
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
