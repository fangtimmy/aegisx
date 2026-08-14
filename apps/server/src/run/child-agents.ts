import type { AgentSummary } from "@aegisx/shared/agent"

import { createAgentHost } from "../agents/host"
import type {
  AgentLoopSettings,
  HostAgentSession,
} from "../agents/host-session"
import type { LiveBus } from "../agents/live"
import type { Database } from "../db"
import { agents } from "../db/schema"
import type { PromptContext } from "../orchestration/types"
import { renderTemplateBody } from "../settings/prompt-templates"
import type { ContainerManager } from "./container/container-manager"
import { RunActionError } from "./errors"
import type { RunContext } from "./service"

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
  /** Test seam: child host-session factory (default = createAgentHost). The
   * run service threads its own createHost through so tests stub children the
   * same way they stub main agents. */
  createHost?: typeof createAgentHost
  listAgents(runId: string): AgentSummary[]
  updateAgent(agentId: string, patch: AgentPatch): void
  emitRun(runId: string): void
  emitAgents(runId: string): void
  /** Hand a finished child's result text to its parent (steer or new turn). */
  deliverToParent(runId: string, parentAgentId: string, text: string): void
  /** Child turn boundary hooks (status aggregation — spec §4.5e). */
  onChildTurnStart(agentId: string, runId: string): void
  onChildTurnSettled(agentId: string, runId: string, error: string | null): void
}

export type ChildAgentRuntime = ReturnType<typeof createChildAgentRuntime>

const now = () => new Date().toISOString()

/**
 * Render a spawn child's system prompt: the plugin's spawn template with the
 * child context (role/name/task) and capabilities ZEROED (spec §3.7) — a child
 * can never finish, submit flags, manage targets, or spawn, so its prompt must
 * not advertise abilities its tool set lacks.
 */
export function renderChildSystemPrompt(
  template: string,
  ctx: PromptContext,
  name: string,
  task: string
): string {
  return renderTemplateBody(template, {
    ...ctx,
    agent: { role: "child", isMain: false, name, task },
    capabilities: {
      canFinish: false,
      canSubmitFlag: false,
      canManageTarget: false,
      canSpawn: false,
    },
  })
}

/** Background child-agent orchestration for `spawn_agent`. Each run may have
 * background children (capped); each runs to completion, then its result is
 * delivered to the parent. The parent-delivery routing (steer vs. new turn) is
 * the caller's — this module only builds the result text and hands it over. */
export function createChildAgentRuntime(deps: ChildAgentDeps) {
  const { db, bus, containerManager } = deps
  const createHost = deps.createHost ?? createAgentHost

  /** Drive a child to completion, then settle + deliver its result. */
  async function runInBackground(
    runId: string,
    childAgentId: string,
    childName: string,
    task: string,
    childSession: HostAgentSession
  ): Promise<void> {
    deps.onChildTurnStart(childAgentId, runId)
    let runError: string | null = null
    try {
      await childSession.session.prompt(task)
    } catch (error) {
      runError = error instanceof Error ? error.message : String(error)
    }
    // External teardown (run close / finish / timeout / delete) has already
    // disposed this session and removed it from childSessions (abortAll deletes
    // first; the normal path is this function deleting last). The teardown
    // persists the agent state (idle), so settle here would overwrite it with
    // failed and emit against a closed run — exit instead. Single-threaded
    // event loop: no race between the check and the delete.
    if (!deps.childSessions.has(childAgentId)) {
      return
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
    deps.onChildTurnSettled(childAgentId, runId, runError)
    void childSession.dispose()
    deps.childSessions.delete(childAgentId)
    deps.emitAgents(runId)
    deliverResult(runId, childAgentId, childName, status, summary, runError)
  }

  /** Build the child-result message and route it to the child's PARENT (spec
   * §4.4 rule 1: a finished child's result is delivered to its parent, not the
   * run's entry — parents are the spawn-capable agents). */
  function deliverResult(
    runId: string,
    childAgentId: string,
    childName: string,
    status: string,
    summary: string,
    error: string | null
  ): void {
    const parentAgentId = deps
      .listAgents(runId)
      .find((agent) => agent.id === childAgentId)?.parentAgentId
    if (!parentAgentId) return
    const text = [
      `Background agent ${childName} (${childAgentId}) ${status}.`,
      "",
      "Final output:",
      summary,
      ...(error ? ["", `Error: ${error}`] : []),
    ].join("\n")
    deps.deliverToParent(runId, parentAgentId, text)
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
    // Spawn children render the plugin's spawn template with capabilities
    // ZEROED (spec §3.7): a child can never finish/submit/manage targets/spawn,
    // and its prompt must not advertise abilities its tool set lacks.
    const childSystemPrompt = renderChildSystemPrompt(
      ctx.childTemplate,
      ctx.promptContext,
      childName,
      input.task
    )
    db.insert(agents)
      .values({
        id: childAgentId,
        runId,
        slot: `child-${childAgentId.slice(0, 8)}`,
        role: "child",
        parentAgentId,
        isEntry: false,
        model: ctx.defaultModelRef,
        systemPrompt: childSystemPrompt,
        tools: "[]",
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

    // Children: file tools only (no finish/flag/target/spawn) — they get the
    // common host tool set with no extras, reusing the run's container + model.
    if (!ctx.sdkModel) {
      throw new RunActionError(
        "invalid_state",
        "Run model is unavailable; cannot spawn a child agent"
      )
    }
    const childSdkModel = ctx.sdkModel
    let childSession: HostAgentSession
    try {
      childSession = await createHost({
        owner: { agentId: childAgentId, runId },
        channel: runId,
        agentId: childAgentId,
        cwd: ctx.containerWorkspace,
        containerName: ctx.containerName,
        containerManager,
        modelRuntime: ctx.modelRuntime,
        model: childSdkModel,
        thinkingLevel: ctx.thinkingLevel,
        agentSettings: deps.agentSettings(),
        systemPrompt: childSystemPrompt,
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
