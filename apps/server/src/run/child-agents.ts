import {
  createBashToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent"
import type { AgentSummary } from "../../../shared/agent"
import {
  type AgentLoopSettings,
  createHostAgentSession,
  type HostAgentSession,
} from "../agents/host-session"
import type { LiveBus } from "../agents/live"
import type { createDatabase } from "../db"
import { agents } from "../db/schema"
import { renderSystemPrompt } from "../settings/prompt-templates"
import type { ContainerManager } from "./container/container-manager"
import { createContainerBashOperations } from "./container/container-tools"
import { RunActionError } from "./errors"
import type { RunContext } from "./service"
import { createDockerExecBackend } from "./workspace/backend"
import { createWorkspaceTools } from "./workspace/tools"

type Database = ReturnType<typeof createDatabase>["db"]
type AgentPatch = Partial<typeof agents.$inferInsert>

export type ChildAgentDeps = {
  db: Database
  bus: LiveBus
  containerManager: ContainerManager
  /** Per-run reusable handles (model, workspace, prompt context, ...). */
  contexts: Map<string, RunContext>
  /** Live child sessions, keyed by child agent id. */
  childSessions: Map<string, HostAgentSession>
  /** Cap on concurrent child agents per run. */
  maxChildrenPerRun: number
  agentSettings: () => AgentLoopSettings
  listAgents(runId: string): AgentSummary[]
  updateAgent(agentId: string, patch: AgentPatch): void
  emitRun(runId: string): void
  emitAgents(runId: string): void
  /** Hand a finished child's result text to its parent (steer or new turn). */
  deliverToParent(runId: string, text: string): void
}

export type ChildAgentRuntime = ReturnType<typeof createChildAgentRuntime>

const now = () => new Date().toISOString()

/** Background child-agent orchestration for `spawn_agent`. Each run may have
 * background children (capped); each runs to completion, then its result is
 * delivered to the parent. The parent-delivery routing (steer vs. new turn) is
 * the caller's — this module only builds the result text and hands it over. */
export function createChildAgentRuntime(deps: ChildAgentDeps) {
  const { db, bus, containerManager } = deps

  /** Drive a child to completion, then settle + deliver its result. */
  async function runInBackground(
    runId: string,
    childAgentId: string,
    childName: string,
    task: string,
    childSession: HostAgentSession
  ): Promise<void> {
    let runError: string | null = null
    try {
      await childSession.session.prompt(task)
    } catch (error) {
      runError = error instanceof Error ? error.message : String(error)
    }
    const settled = now()
    const summary =
      childSession.session.getLastAssistantText() ??
      (runError ? `Child failed: ${runError}` : "Child completed.")
    const status = runError ? "failed" : "completed"
    deps.updateAgent(childAgentId, {
      status,
      completedAt: settled,
      updatedAt: settled,
      ...(runError ? { error: runError } : {}),
    })
    void childSession.dispose()
    deps.childSessions.delete(childAgentId)
    deps.emitAgents(runId)
    deliverResult(runId, childAgentId, childName, status, summary, runError)
  }

  /** Build the child-result message and route it to the parent. */
  function deliverResult(
    runId: string,
    childAgentId: string,
    childName: string,
    status: string,
    summary: string,
    error: string | null
  ): void {
    const text = [
      `Background agent ${childName} (${childAgentId}) ${status}.`,
      "",
      "Final output:",
      summary,
      ...(error ? ["", `Error: ${error}`] : []),
    ].join("\n")
    deps.deliverToParent(runId, text)
  }

  /**
   * Start a background child agent for spawn_agent. Resolves immediately with
   * the new agent; the child runs to completion in the background and its
   * result is delivered to the parent.
   */
  async function spawn(
    runId: string,
    parentAgentId: string,
    input: { name: string; task: string }
  ): Promise<{ agentId: string; name: string; status: string }> {
    const ctx = deps.contexts.get(runId)
    if (!ctx) throw new RunActionError("invalid_state", "Run context missing")
    const activeChildren = deps
      .listAgents(runId)
      .filter((a) => a.role === "child" && a.status === "running").length
    if (activeChildren >= deps.maxChildrenPerRun) {
      throw new RunActionError(
        "invalid_state",
        `A child agent is already running for this run (limit ${deps.maxChildrenPerRun}). Wait for it to finish before spawning another.`
      )
    }

    const childAgentId = crypto.randomUUID()
    const childName = input.name.trim() || "Child agent"
    const ts = now()
    db.insert(agents)
      .values({
        id: childAgentId,
        runId,
        role: "child",
        parentAgentId,
        status: "running",
        sessionFile: null,
        name: childName,
        task: input.task,
        createdAt: ts,
        startedAt: ts,
        updatedAt: ts,
      })
      .run()
    deps.emitAgents(runId)

    const childSystemPrompt = renderSystemPrompt(ctx.childTemplate, {
      ...ctx.promptContext,
      agent: {
        role: "child",
        isMain: false,
        name: childName,
        task: input.task,
      },
    })
    const bashDef = createBashToolDefinition(ctx.workspaceHostPath, {
      operations: createContainerBashOperations(
        ctx.containerName,
        containerManager
      ),
    })
    const workspaceTools = createWorkspaceTools(
      createDockerExecBackend(ctx.containerName, containerManager)
    )
    // Children: coding tools only (no finish/flag/target/spawn).
    const toolNames = ["read", "bash", "edit", "write", "grep", "find", "ls"]

    let childSession: HostAgentSession
    try {
      childSession = await createHostAgentSession({
        owner: { type: "run", id: runId, runId, agentId: childAgentId },
        channel: runId,
        agentId: childAgentId,
        cwd: ctx.workspaceHostPath,
        modelRuntime: ctx.modelRuntime,
        model: ctx.sdkModel,
        thinkingLevel: ctx.thinkingLevel,
        agentSettings: deps.agentSettings(),
        systemPrompt: childSystemPrompt,
        toolNames,
        customTools: [bashDef, ...workspaceTools] as ToolDefinition[],
        onUsageMaybeChanged: () => deps.emitRun(runId),
        db,
        bus,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      deps.updateAgent(childAgentId, {
        status: "failed",
        error: message,
        completedAt: now(),
        updatedAt: now(),
      })
      deps.emitAgents(runId)
      throw new RunActionError("launch_failed", message)
    }
    deps.childSessions.set(childAgentId, childSession)
    deps.updateAgent(childAgentId, {
      sessionFile: childSession.sessionId ?? null,
    })
    deps.emitAgents(runId)

    void runInBackground(
      runId,
      childAgentId,
      childName,
      input.task,
      childSession
    )
    return { agentId: childAgentId, name: childName, status: "running" }
  }

  /** Abort + dispose any in-flight child sessions belonging to a run. */
  function abortAll(runId: string): void {
    for (const child of deps.listAgents(runId)) {
      if (child.role !== "child") continue
      const session = deps.childSessions.get(child.id)
      if (!session) continue
      void session.session.abort().catch(() => undefined)
      void session.dispose()
      deps.childSessions.delete(child.id)
    }
  }

  return { spawn, abortAll }
}
