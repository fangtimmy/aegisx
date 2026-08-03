import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent"
import { eq, max } from "drizzle-orm"
import type {
  MessageUsage,
  AssistantMessage as WireAssistant,
  Message as WireMessage,
  ToolResultMessage as WireToolResult,
  UserMessage as WireUser,
} from "../../../shared"
import type { createDatabase } from "../db"
import { runEvents } from "../db/schema"
import type { LiveBus } from "./live"

type Database = ReturnType<typeof createDatabase>["db"]

/** Deterministic, stable id for an SDK AgentMessage (it has none of its own). */
export function messageIdOf(agentId: string, msg: AgentMessage): string {
  if (msg.role === "toolResult") {
    return `${agentId}:toolResult:${msg.toolCallId}`
  }
  return `${agentId}:${msg.role}:${msg.timestamp}`
}

/** Map an SDK `Usage` into the wire `MessageUsage` (guards missing fields). */
function toMessageUsage(usage: unknown): MessageUsage | undefined {
  if (!usage || typeof usage !== "object") return undefined
  const u = usage as Record<string, unknown>
  const cost = (u.cost && typeof u.cost === "object" ? u.cost : {}) as Record<
    string,
    unknown
  >
  return {
    input: toNum(u.input),
    output: toNum(u.output),
    cacheRead: toNum(u.cacheRead),
    cacheWrite: toNum(u.cacheWrite),
    reasoning: typeof u.reasoning === "number" ? u.reasoning : undefined,
    totalTokens: toNum(u.totalTokens),
    cost: {
      input: toNum(cost.input),
      output: toNum(cost.output),
      cacheRead: toNum(cost.cacheRead),
      cacheWrite: toNum(cost.cacheWrite),
      total: toNum(cost.total),
    },
  }
}

function toNum(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

/**
 * JSON content column for a committed message. user/assistant/toolResult carry
 * `content`; a notice carries `text`. (Notices are not committed today, but the
 * branch keeps the writer correct for the full union.)
 */
function serializeContent(msg: WireMessage): string {
  return JSON.stringify(msg.role === "notice" ? msg.text : msg.content)
}

/** Normalize an SDK AgentMessage into the wire Message (seq assigned at commit). */
export function normalizeMessage(
  agentId: string,
  msg: AgentMessage,
  source: WireUser["source"] = "user"
): WireMessage | null {
  const timestamp =
    typeof msg.timestamp === "number" ? msg.timestamp : Date.now()
  const createdAt = new Date(timestamp).toISOString()
  const id = messageIdOf(agentId, msg)

  if (msg.role === "user") {
    const message: WireUser = {
      role: "user",
      id,
      seq: 0,
      agentId,
      createdAt,
      source,
      content: msg.content as WireUser["content"],
      timestamp,
    }
    return message
  }
  if (msg.role === "assistant") {
    const message: WireAssistant = {
      role: "assistant",
      id,
      seq: 0,
      agentId,
      createdAt,
      content: msg.content as WireAssistant["content"],
      stopReason: msg.stopReason,
      errorMessage: msg.errorMessage,
      api: msg.api,
      provider: msg.provider,
      model: msg.model,
      usage: toMessageUsage(msg.usage),
      timestamp,
    }
    return message
  }
  if (msg.role === "toolResult") {
    const message: WireToolResult = {
      role: "toolResult",
      id,
      seq: 0,
      agentId,
      createdAt,
      toolCallId: msg.toolCallId,
      toolName: msg.toolName,
      content: msg.content as WireToolResult["content"],
      isError: msg.isError || undefined,
      details: msg.details,
      timestamp,
    }
    return message
  }
  return null
}

export type RunEventPipeline = ReturnType<typeof createRunEventPipeline>

/**
 * Per-agent event pipeline. Subscribed to one AgentSession; normalizes SDK
 * events into committed messages (durable, in run_events) and live progress
 * (ephemeral, over the SSE bus).
 *
 * Committed messages are written on `message_end` (and reconciled from
 * turn_end/agent_end) with dedup by message id, so the messages API reflects a
 * growing, reconnect-safe history during the run.
 */
export function createRunEventPipeline(options: {
  runId: string
  agentId: string
  db: Database
  bus: LiveBus
}) {
  const { runId, agentId, db, bus } = options
  let revision = 0
  const nextRevision = () => (revision += 1)

  /**
   * Persist a message and emit `message.committed` exactly once. Duplicate
   * commits (the same id re-emitted by turn_end/agent_end reconciliation) are
   * no-ops: they neither insert nor emit, so the emitted wire `seq` is never
   * overwritten with the placeholder 0 from normalizeMessage.
   */
  function commit(msg: WireMessage): void {
    const finalized: WireMessage = { ...msg }
    let inserted = false
    db.transaction((tx) => {
      const existing = tx
        .select({ id: runEvents.id })
        .from(runEvents)
        .where(eq(runEvents.id, msg.id))
        .get()
      if (existing) return
      const row = tx
        .select({ seq: max(runEvents.seq) })
        .from(runEvents)
        .where(eq(runEvents.runId, runId))
        .get()
      const seq = (row?.seq ?? 0) + 1
      finalized.seq = seq
      tx.insert(runEvents)
        .values({
          id: msg.id,
          runId,
          agentId,
          seq,
          role: msg.role,
          content: serializeContent(msg),
          toolName: msg.role === "toolResult" ? msg.toolName : null,
          toolCallId: msg.role === "toolResult" ? msg.toolCallId : null,
          isError: msg.role === "toolResult" ? msg.isError === true : null,
          payload: JSON.stringify(extras(msg)),
          createdAt: msg.createdAt,
        })
        .run()
      inserted = true
    })
    if (inserted) {
      bus.emit(runId, {
        type: "message.committed",
        agentId,
        message: finalized,
      })
    }
  }

  /** Persist + emit a committed message from a raw SDK AgentMessage. */
  function commitAgentMessage(
    msg: AgentMessage,
    source?: WireUser["source"]
  ): void {
    const wire = normalizeMessage(agentId, msg, source)
    if (wire) commit(wire)
  }

  function handle(event: AgentSessionEvent): void {
    switch (event.type) {
      case "message_update": {
        const ae = event.assistantMessageEvent
        if (
          ae.type === "text_delta" ||
          ae.type === "thinking_delta" ||
          ae.type === "text_end" ||
          ae.type === "thinking_end" ||
          ae.type === "toolcall_end"
        ) {
          // event.message is the full accumulated partial assistant message.
          const wire = normalizeMessage(agentId, event.message)
          if (wire) {
            bus.emit(runId, {
              type: "message.progress",
              agentId,
              messageId: wire.id,
              revision: nextRevision(),
              message: wire,
            })
          }
        }
        return
      }
      case "message_start": {
        // Emit an initial progress frame so the UI shows the turn immediately.
        const wire = normalizeMessage(agentId, event.message)
        if (wire) {
          bus.emit(runId, {
            type: "message.progress",
            agentId,
            messageId: wire.id,
            revision: nextRevision(),
            message: wire,
          })
        }
        return
      }
      case "message_end": {
        commitAgentMessage(event.message)
        return
      }
      case "turn_end": {
        // Reconcile: commit the assistant message and any tool results.
        commitAgentMessage(event.message)
        for (const result of event.toolResults) commitAgentMessage(result)
        return
      }
      case "agent_end": {
        if (event.willRetry) return
        // Final reconciliation of every new message this run produced.
        for (const msg of event.messages) commitAgentMessage(msg)
        return
      }
      case "tool_execution_start": {
        bus.emit(runId, {
          type: "tool.progress",
          agentId,
          toolCallId: event.toolCallId,
          revision: nextRevision(),
          toolName: event.toolName,
          args: event.args,
          status: "running",
        })
        return
      }
      case "tool_execution_update": {
        bus.emit(runId, {
          type: "tool.progress",
          agentId,
          toolCallId: event.toolCallId,
          revision: nextRevision(),
          toolName: event.toolName,
          args: event.args,
          result: event.partialResult,
          status: "running",
        })
        return
      }
      case "tool_execution_end": {
        bus.emit(runId, {
          type: "tool.progress",
          agentId,
          toolCallId: event.toolCallId,
          revision: nextRevision(),
          toolName: event.toolName,
          args: null,
          result: event.result,
          status: event.isError ? "error" : "done",
          isError: event.isError || undefined,
          ...(event.isError ? { terminal: "failed" } : {}),
        })
        return
      }
      case "auto_retry_start": {
        bus.emit(runId, {
          type: "agent.activity",
          agentId,
          activity: "retrying",
          detail: event.errorMessage,
        })
        return
      }
      case "auto_retry_end": {
        if (event.success) {
          bus.emit(runId, { type: "agent.activity", agentId, activity: null })
        }
        return
      }
      case "compaction_start": {
        bus.emit(runId, {
          type: "agent.activity",
          agentId,
          activity: "compacting",
        })
        return
      }
      case "compaction_end": {
        bus.emit(runId, { type: "agent.activity", agentId, activity: null })
        return
      }
      default:
        return
    }
  }

  return { handle, commitAgentMessage, commit }
}

/** Extra fields stored in run_events.payload (everything not in content/role). */
function extras(msg: WireMessage): Record<string, unknown> {
  if (msg.role === "user")
    return { source: msg.source, timestamp: msg.timestamp }
  if (msg.role === "assistant") {
    return {
      stopReason: msg.stopReason,
      errorMessage: msg.errorMessage,
      api: msg.api,
      provider: msg.provider,
      model: msg.model,
      usage: msg.usage,
      timestamp: msg.timestamp,
    }
  }
  if (msg.role === "toolResult") {
    return { details: msg.details, timestamp: msg.timestamp }
  }
  return { timestamp: msg.timestamp }
}

/** Reconstruct a wire Message from a run_events row (messages API). */
export function rowToMessage(
  row: typeof runEvents.$inferSelect
): WireMessage | null {
  let content: unknown
  try {
    content = JSON.parse(row.content)
  } catch {
    content = ""
  }
  let payload: Record<string, unknown> = {}
  if (row.payload) {
    try {
      payload = JSON.parse(row.payload)
    } catch {
      payload = {}
    }
  }
  if (row.role === "user") {
    return {
      role: "user",
      id: row.id,
      seq: row.seq,
      agentId: row.agentId,
      createdAt: row.createdAt,
      source: (payload.source as WireUser["source"]) ?? "user",
      content: content as WireUser["content"],
      timestamp: payload.timestamp as number | undefined,
    }
  }
  if (row.role === "assistant") {
    return {
      role: "assistant",
      id: row.id,
      seq: row.seq,
      agentId: row.agentId,
      createdAt: row.createdAt,
      content: content as WireAssistant["content"],
      stopReason: payload.stopReason as WireAssistant["stopReason"],
      errorMessage: payload.errorMessage as string | undefined,
      api: payload.api as string | undefined,
      provider: payload.provider as string | undefined,
      model: payload.model as string | undefined,
      usage: payload.usage as WireAssistant["usage"],
      timestamp: payload.timestamp as number | undefined,
    }
  }
  if (row.role === "toolResult") {
    return {
      role: "toolResult",
      id: row.id,
      seq: row.seq,
      agentId: row.agentId,
      createdAt: row.createdAt,
      toolCallId: row.toolCallId ?? "",
      toolName: row.toolName ?? "",
      content: content as WireToolResult["content"],
      isError: row.isError ? true : undefined,
      details: payload.details,
      timestamp: payload.timestamp as number | undefined,
    }
  }
  return null
}
