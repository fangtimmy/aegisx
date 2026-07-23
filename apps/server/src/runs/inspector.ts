import { homedir } from "node:os"
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import { and, asc, count, eq, sql } from "drizzle-orm"
import type {
  AgentInspector,
  AgentPublic,
  AgentRuntimeSnapshot,
  ConversationMessage,
} from "../../../shared"
import { parseAgentMessage } from "../agents/messages"
import { publicAgentMessage } from "../agents/runtime"
import {
  parseUsage,
  summarizeUsage,
  summarizeUsageRecords,
  sumUsage,
} from "../agents/usage"
import type { createDatabase } from "../db"
import {
  agentMessages,
  agentToolCalls,
  agentUsage,
  type runAgents,
  runEvents,
} from "../db/schema"
import { replaceText } from "../infrastructure/redaction"
import { RunActionError } from "./errors"

type Database = ReturnType<typeof createDatabase>["db"]
type StoredAgent = typeof runAgents.$inferSelect
type StoredRun = {
  id: string
  modelConfig: string
}

export function createRunInspector(options: {
  db: Database
  dataDir: string
  getStoredRun(runId: string): StoredRun | undefined
  getStoredAgent(agentId: string): StoredAgent | undefined
  getAgentPublic(agentId: string): AgentPublic | undefined
  parseModelConfig(value: string): { costKnown?: boolean }
  parseRuntimeSnapshot(value: string | null): AgentRuntimeSnapshot | null
}) {
  const {
    db,
    dataDir,
    getStoredRun,
    getStoredAgent,
    getAgentPublic,
    parseModelConfig,
    parseRuntimeSnapshot,
  } = options

  function messageRowsForAgent(agentId: string) {
    if (!getStoredAgent(agentId)) {
      throw new RunActionError("not_found", "Agent not found")
    }
    return db
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.agentId, agentId))
      .orderBy(asc(agentMessages.sequence))
      .all()
  }

  function messagesForAgent(agentId: string): AgentMessage[] {
    return messageRowsForAgent(agentId).map(({ message }) =>
      parseAgentMessage(message)
    )
  }

  function conversationMessage(
    row: typeof agentMessages.$inferSelect
  ): ConversationMessage {
    return {
      id: row.runtimeId ?? row.id,
      agentId: row.agentId,
      sequence: row.sequence,
      message: publicAgentMessage(
        parseAgentMessage(row.message)
      ) as ConversationMessage["message"],
      createdAt: row.createdAt,
    }
  }

  function conversationSnapshot(agentId: string) {
    const agent = getStoredAgent(agentId)
    if (!agent) throw new RunActionError("not_found", "Agent not found")
    let snapshot:
      | {
          messages: ConversationMessage[]
          cursor: number
        }
      | undefined
    db.transaction((tx) => {
      const rows = tx
        .select()
        .from(agentMessages)
        .where(eq(agentMessages.agentId, agentId))
        .orderBy(asc(agentMessages.sequence))
        .all()
      const value = tx
        .select({ value: sql<number>`coalesce(max(${runEvents.id}), 0)` })
        .from(runEvents)
        .where(eq(runEvents.runId, agent.runId))
        .get()?.value
      snapshot = {
        messages: rows.map(conversationMessage),
        cursor: value ?? 0,
      }
    })
    if (!snapshot) throw new Error("Conversation snapshot is unavailable")
    return snapshot
  }

  function conversationMessageForRuntime(agentId: string, runtimeId: string) {
    const row = db
      .select()
      .from(agentMessages)
      .where(
        and(
          eq(agentMessages.agentId, agentId),
          eq(agentMessages.runtimeId, runtimeId)
        )
      )
      .get()
    return row ? conversationMessage(row) : undefined
  }

  function usageForAgent(agentId: string) {
    const agent = getStoredAgent(agentId)
    if (!agent) throw new RunActionError("not_found", "Agent not found")
    const run = getStoredRun(agent.runId)
    if (!run) throw new RunActionError("not_found", "Run not found")
    const costKnown = parseModelConfig(run.modelConfig).costKnown !== false
    return sumUsage([
      summarizeUsage(messagesForAgent(agentId), costKnown),
      summarizeUsageRecords(
        db
          .select({ usage: agentUsage.usage })
          .from(agentUsage)
          .where(eq(agentUsage.agentId, agentId))
          .all()
          .map(({ usage }) => parseUsage(usage)),
        costKnown
      ),
    ])
  }

  function toolStatsForAgent(agentId: string) {
    return db
      .select({
        toolName: agentToolCalls.toolName,
        callCount: count(),
        failedCount: sql<number>`coalesce(sum(case when ${agentToolCalls.succeeded} = 0 then 1 else 0 end), 0)`,
        durationMs: sql<number>`coalesce(sum(${agentToolCalls.durationMs}), 0)`,
        outputBytes: sql<number>`coalesce(sum(${agentToolCalls.outputBytes}), 0)`,
        truncatedCount: sql<number>`coalesce(sum(case when ${agentToolCalls.truncated} = 1 then 1 else 0 end), 0)`,
      })
      .from(agentToolCalls)
      .where(eq(agentToolCalls.agentId, agentId))
      .groupBy(agentToolCalls.toolName)
      .orderBy(agentToolCalls.toolName)
      .all()
      .map((value) => ({
        ...value,
        callCount: Number(value.callCount),
        failedCount: Number(value.failedCount),
        durationMs: Number(value.durationMs),
        outputBytes: Number(value.outputBytes),
        truncatedCount: Number(value.truncatedCount),
      }))
  }

  function inspectorForAgent(agentId: string): AgentInspector {
    const stored = getStoredAgent(agentId)
    const agent = getAgentPublic(agentId)
    if (!stored || !agent) {
      throw new RunActionError("not_found", "Agent not found")
    }
    const runtime = parseRuntimeSnapshot(stored.runtimeSnapshot)
    if (runtime) {
      replaceText(runtime, dataDir, "$DATA")
      replaceText(runtime, homedir(), "$HOME")
    }
    return {
      agent,
      task: stored.task,
      runtime,
      usage: usageForAgent(agentId),
      toolStats: toolStatsForAgent(agentId),
    }
  }

  return {
    messagesForAgent,
    conversationMessage,
    conversationSnapshot,
    conversationMessageForRuntime,
    usageForAgent,
    inspectorForAgent,
  }
}
