import { and, asc, eq, gt } from "drizzle-orm"
import type {
  AgentPublic,
  ConversationMessage,
  RunPublic,
  RunStreamEvent,
  UsageSummary,
} from "../../../shared"
import type { createDatabase } from "../db"
import { agentMessages, runEvents } from "../db/schema"

type Database = ReturnType<typeof createDatabase>["db"]

/** Stream events emitted by the bus (ready is routes-only). */
export type RunEvent = Exclude<RunStreamEvent, { type: "ready" }>

export type RunEventListener = (
  event: RunEvent,
  sequence: number,
  replay: boolean
) => void

type EventBusOptions = {
  db: Database
  getRun(runId: string): RunPublic | undefined
  getAgent(agentId: string): AgentPublic | undefined
  getAgentUsage(agentId: string): UsageSummary
  conversationMessage(
    row: typeof agentMessages.$inferSelect
  ): ConversationMessage
}

export function createRunEventBus(options: EventBusOptions) {
  const { db } = options
  const listeners = new Map<string, Set<RunEventListener>>()

  function emit(runId: string, event: RunEvent) {
    const sequence = "cursor" in event ? (event.cursor ?? 0) : 0
    for (const listener of listeners.get(runId) ?? []) {
      listener(event, sequence, false)
    }
  }

  function replayEvents(
    runId: string,
    afterCursor: number,
    listener: RunEventListener
  ) {
    const rows = db
      .select()
      .from(runEvents)
      .where(and(eq(runEvents.runId, runId), gt(runEvents.id, afterCursor)))
      .orderBy(asc(runEvents.id))
      .all()
    for (const row of rows) {
      let event: RunEvent | undefined
      if (row.type === "run_updated") {
        const run = options.getRun(runId)
        if (run) event = { type: "run.updated", run, cursor: row.id }
      } else if (row.type === "agent_updated" && row.agentId) {
        const agent = options.getAgent(row.agentId)
        if (agent) {
          event = {
            type: "agent.updated",
            agent: { ...agent, usage: options.getAgentUsage(agent.id) },
            cursor: row.id,
          }
        }
      } else if (row.type === "message_committed" && row.entityId) {
        const stored = db
          .select()
          .from(agentMessages)
          .where(eq(agentMessages.id, row.entityId))
          .get()
        if (stored) {
          event = {
            type: "message.committed",
            agentId: stored.agentId,
            cursor: row.id,
            message: options.conversationMessage(stored),
          }
        }
      }
      if (event) listener(event, row.id, true)
    }
  }

  return {
    emit,
    subscribe(runId: string, listener: RunEventListener, afterCursor = 0) {
      const runListeners = listeners.get(runId) ?? new Set<RunEventListener>()
      runListeners.add(listener)
      listeners.set(runId, runListeners)
      replayEvents(runId, afterCursor, listener)
      return () => {
        runListeners.delete(listener)
        if (runListeners.size === 0) {
          listeners.delete(runId)
        }
      }
    },
    clearRun(runId: string) {
      listeners.delete(runId)
    },
    clear() {
      listeners.clear()
    },
  }
}

export type RunEventBus = ReturnType<typeof createRunEventBus>
