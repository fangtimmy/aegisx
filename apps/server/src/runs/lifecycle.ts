import type { AgentPublic, AgentStatus, RunStatus } from "../../../shared"
import type { RuntimeOutcome } from "../agents/runtime"
import type { createDatabase } from "../db"
import { agentInbox, type runAgents, type runs } from "../db/schema"
import type { RunHandleRegistry } from "./run-handle"
import type { AgentChange } from "./state-store"

type Database = ReturnType<typeof createDatabase>["db"]
type StoredRun = typeof runs.$inferSelect
type StoredAgent = typeof runAgents.$inferSelect

const terminalRunStatuses: RunStatus[] = ["completed", "failed", "stopped"]
const terminalAgentStatuses: AgentStatus[] = ["completed", "failed", "stopped"]

export function createSettledHandlers(options: {
  db: Database
  handles: RunHandleRegistry
  isClosed(): boolean
  withRunLock<T>(runId: string, operation: () => T | Promise<T>): Promise<T>
  getStored(runId: string): StoredRun | undefined
  getStoredAgent(agentId: string): StoredAgent | undefined
  getMainAgent(runId: string): StoredAgent | undefined
  listStoredAgents(runId: string): StoredAgent[]
  takeContainerFailure(runId: string): string | undefined
  abortRun(runId: string, exceptAgentId?: string): Promise<void>
  releaseRun(runId: string): Promise<void>
  releaseAgent(agentId: string): void
  transitionRun(
    runId: string,
    values: Partial<typeof runs.$inferInsert>,
    agentChanges: AgentChange[]
  ): unknown
  updateAgent(
    agentId: string,
    values: Partial<typeof runAgents.$inferInsert>
  ): AgentPublic
  getMainRuntime(agentId: string): { replayPending(): void } | undefined
}) {
  const {
    db,
    handles,
    isClosed,
    withRunLock,
    getStored,
    getStoredAgent,
    getMainAgent,
    listStoredAgents,
    takeContainerFailure,
    abortRun,
    releaseRun,
    releaseAgent,
    transitionRun,
    updateAgent,
    getMainRuntime,
  } = options

  async function handleMainSettled(
    runId: string,
    agentId: string,
    outcome: RuntimeOutcome
  ) {
    if (isClosed() || handles.isAborting(runId)) return
    return withRunLock(runId, async () => {
      if (isClosed() || handles.isAborting(runId)) return
      const storedRun = getStored(runId)
      if (
        !storedRun ||
        terminalRunStatuses.includes(storedRun.status as RunStatus)
      ) {
        await releaseRun(runId)
        return
      }
      if (getStoredAgent(agentId)?.status !== "running") return

      const containerFailure = takeContainerFailure(runId)
      if (containerFailure) {
        handles.beginAbort(runId, "paused")
        try {
          await abortRun(runId, agentId)
          const changes = listStoredAgents(runId)
            .filter(
              (agent) =>
                !terminalAgentStatuses.includes(agent.status as AgentStatus)
            )
            .map((agent) => ({
              agentId: agent.id,
              values: { status: "paused" as const },
            }))
          await releaseRun(runId)
          transitionRun(
            runId,
            { status: "paused", error: containerFailure },
            changes
          )
        } finally {
          handles.endAbort(runId)
        }
        return
      }

      if (outcome.status === "success" && storedRun.pendingCompletionSummary) {
        const completedAt = new Date().toISOString()
        handles.beginAbort(runId, "stopped")
        try {
          await abortRun(runId, agentId)
          const changes: AgentChange[] = []
          for (const agent of listStoredAgents(runId)) {
            if (agent.id === agentId) {
              changes.push({
                agentId,
                values: {
                  status: "completed",
                  completedAt,
                  summary: storedRun.pendingCompletionSummary,
                  error: null,
                },
              })
              continue
            }
            if (!terminalAgentStatuses.includes(agent.status as AgentStatus)) {
              changes.push({
                agentId: agent.id,
                values: { status: "stopped", completedAt },
              })
            }
          }
          await releaseRun(runId)
          transitionRun(
            runId,
            {
              status: "completed",
              completedAt,
              summary: storedRun.pendingCompletionSummary,
              pendingCompletionSummary: null,
              error: null,
            },
            changes
          )
        } finally {
          handles.endAbort(runId)
        }
        return
      }
      if (outcome.status === "success") {
        updateAgent(agentId, { status: "idle" })
        return
      }

      const completedAt = new Date().toISOString()
      const error = outcome.error ?? "Agent session failed"
      handles.beginAbort(runId, "stopped")
      try {
        await abortRun(runId, agentId)
        const changes: AgentChange[] = []
        for (const agent of listStoredAgents(runId)) {
          if (agent.id === agentId) {
            changes.push({
              agentId,
              values: {
                status: "failed",
                completedAt,
                summary: outcome.summary,
                error,
              },
            })
            continue
          }
          if (!terminalAgentStatuses.includes(agent.status as AgentStatus)) {
            changes.push({
              agentId: agent.id,
              values: { status: "stopped", completedAt },
            })
          }
        }
        await releaseRun(runId)
        transitionRun(runId, { status: "failed", completedAt, error }, changes)
      } finally {
        handles.endAbort(runId)
      }
    })
  }

  async function handleChildSettled(
    runId: string,
    agentId: string,
    outcome: RuntimeOutcome
  ) {
    if (
      isClosed() ||
      handles.isAborting(runId) ||
      getStoredAgent(agentId)?.status !== "running"
    ) {
      releaseAgent(agentId)
      return
    }
    return withRunLock(runId, async () => {
      if (
        isClosed() ||
        handles.isAborting(runId) ||
        getStoredAgent(agentId)?.status !== "running"
      ) {
        releaseAgent(agentId)
        return
      }
      const finished = updateAgent(agentId, {
        status: outcome.status === "success" ? "completed" : "failed",
        completedAt: new Date().toISOString(),
        summary: outcome.summary,
        error:
          outcome.status === "success"
            ? null
            : (outcome.error ?? "Agent session failed"),
      })
      await notifyMain(finished)
      releaseAgent(agentId)
    })
  }

  async function notifyMain(agent: AgentPublic) {
    if (isClosed() || handles.isAborting(agent.runId)) return
    const run = getStored(agent.runId)
    const main = getMainAgent(agent.runId)
    if (
      run?.status !== "running" ||
      !main ||
      (main.status !== "running" && main.status !== "idle")
    ) {
      return
    }
    const result =
      agent.summary ?? agent.error ?? "No final output was produced."
    const message = [
      `Background agent ${agent.name} (${agent.id}) ${agent.status}.`,
      "Final output:",
      result,
    ].join("\n\n")
    db.insert(agentInbox)
      .values({
        id: crypto.randomUUID(),
        agentId: main.id,
        kind: "child_result",
        content: message,
        metadata: JSON.stringify({
          handoff: {
            agentId: agent.id,
            agentName: agent.name,
            status: agent.status,
          },
        }),
        createdAt: new Date().toISOString(),
      })
      .run()
    if (main.status === "idle") updateAgent(main.id, { status: "running" })
    const runtime = getMainRuntime(main.id)
    if (runtime) runtime.replayPending()
  }

  return {
    handleMainSettled,
    handleChildSettled,
    notifyMain,
  }
}

export type SettledHandlers = ReturnType<typeof createSettledHandlers>
