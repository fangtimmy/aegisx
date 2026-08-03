import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type {
  AgentSession,
  AgentSessionEvent,
} from "@earendil-works/pi-coding-agent"
import { eq, max } from "drizzle-orm"
import type {
  MessageUsage,
  NoticeSystemKind,
  AssistantMessage as WireAssistant,
  Message as WireMessage,
  NoticeMessage as WireNotice,
  ToolResultMessage as WireToolResult,
  UserMessage as WireUser,
} from "../../../shared"
import type { ContextSnapshot } from "../../../shared/live-event"
import type { createDatabase } from "../db"
import { runEvents } from "../db/schema"
import type { LiveBus } from "./live"

type Database = ReturnType<typeof createDatabase>["db"]

type UsageLike = {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  reasoning?: number
  totalTokens?: number
  cost?: { total?: number }
}

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

function entryUsage(entry: unknown): UsageLike | undefined {
  if (!entry || typeof entry !== "object") return undefined
  const e = entry as { type?: string; message?: unknown; usage?: unknown }
  if (e.type === "message") {
    const m = e.message as { role?: string; usage?: unknown } | undefined
    return m?.usage as UsageLike | undefined
  }
  if (e.type === "compaction" || e.type === "branch_summary") {
    return e.usage as UsageLike | undefined
  }
  return undefined
}

/** Port of the pi-TUI footer accumulation (footer.js): walk ALL session entries
 * (including history compacted away + compaction/branch-summary usage), sum
 * cumulative tokens/cost, and capture the latest assistant cache-hit rate.
 * Paired with `session.getContextUsage()` for the live context meter. */
export function computeContextSample(session: AgentSession): ContextSnapshot {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
  let cacheHitRate: number | null = null
  const entries = session.sessionManager.getEntries()
  for (const entry of entries) {
    const usage = entryUsage(entry)
    if (!usage) continue
    totals.input += toNum(usage.input)
    totals.output += toNum(usage.output)
    totals.cacheRead += toNum(usage.cacheRead)
    totals.cacheWrite += toNum(usage.cacheWrite)
    totals.cost += toNum(usage.cost?.total)
    const e = entry as { type?: string; message?: { role?: string } }
    if (e.type === "message" && e.message?.role === "assistant") {
      const prompt =
        toNum(usage.input) + toNum(usage.cacheRead) + toNum(usage.cacheWrite)
      if (prompt > 0) cacheHitRate = (toNum(usage.cacheRead) / prompt) * 100
    }
  }
  const cu = session.getContextUsage()
  return {
    tokens: cu?.tokens ?? null,
    contextWindow: cu?.contextWindow ?? 0,
    percent: cu?.percent ?? null,
    cacheHitRate,
    totals,
  }
}

/**
 * JSON content column for a committed message. user/assistant/toolResult carry
 * `content`; a notice carries `text` (the marker title for system notices).
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
  /** Live context snapshot for the conversation stat strip (null before the
   * session is wired up or after disposal). */
  sampleContext?: () => ContextSnapshot | null
  /** Fired after a commit that may change run-wide usage (compaction), so the
   * service can recompute + re-emit the run snapshot. */
  onUsageMaybeChanged?: () => void
}) {
  const { runId, agentId, db, bus } = options
  let revision = 0
  const nextRevision = () => (revision += 1)

  function emitContext(): void {
    const sample = options.sampleContext?.()
    if (!sample) return
    bus.emit(runId, { type: "context.updated", agentId, ...sample })
  }

  /** Persist a durable system-marker notice (retry/compaction transparency)
   * so it survives reconnect and is reviewable in the timeline post-hoc. */
  function commitSystemNotice(
    kind: NoticeSystemKind,
    fields: { title: string; detail?: string; usage?: MessageUsage }
  ): void {
    const timestamp = Date.now()
    const notice: WireNotice = {
      role: "notice",
      id: `${agentId}:notice:${kind}:${nextRevision()}`,
      seq: 0,
      agentId,
      createdAt: new Date(timestamp).toISOString(),
      source: "system",
      text: fields.title,
      kind,
      title: fields.title,
      timestamp,
      ...(fields.detail !== undefined ? { detail: fields.detail } : {}),
      ...(fields.usage ? { usage: fields.usage } : {}),
    }
    commit(notice)
  }

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
        // Surface the context window as soon as a turn starts (tokens may be
        // null before the first response; the window still renders).
        emitContext()
        return
      }
      case "message_end": {
        commitAgentMessage(event.message)
        emitContext()
        return
      }
      case "turn_end": {
        // Reconcile: commit the assistant message and any tool results.
        commitAgentMessage(event.message)
        for (const result of event.toolResults) commitAgentMessage(result)
        emitContext()
        return
      }
      case "agent_end": {
        if (event.willRetry) return
        // Final reconciliation of every new message this run produced.
        for (const msg of event.messages) commitAgentMessage(msg)
        emitContext()
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
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
        })
        commitSystemNotice("retry_start", {
          title: `Retry ${event.attempt}/${event.maxAttempts}`,
          detail:
            event.delayMs > 0
              ? `${event.errorMessage} (waiting ${Math.round(event.delayMs / 1000)}s)`
              : event.errorMessage,
        })
        return
      }
      case "auto_retry_end": {
        bus.emit(runId, { type: "agent.activity", agentId, activity: null })
        commitSystemNotice("retry_end", {
          title: event.success ? "Retry succeeded" : "Retry failed",
          detail: event.success ? undefined : event.finalError,
        })
        return
      }
      case "compaction_start": {
        bus.emit(runId, {
          type: "agent.activity",
          agentId,
          activity: "compacting",
          reason: event.reason,
        })
        commitSystemNotice("compact_start", {
          title: `Compacting context · ${event.reason}`,
        })
        return
      }
      case "compaction_end": {
        bus.emit(runId, { type: "agent.activity", agentId, activity: null })
        const result = event.result
        const tokensBefore = result?.tokensBefore
        const tokensAfter = result?.estimatedTokensAfter
        commitSystemNotice("compact_end", {
          title:
            tokensBefore !== undefined && tokensAfter !== undefined
              ? `Compacted ${formatTokensLabel(tokensBefore)} → ~${formatTokensLabel(tokensAfter)}`
              : result
                ? "Compacted context"
                : event.aborted
                  ? "Compaction aborted"
                  : "Compaction ended",
          detail: event.errorMessage,
          usage: result?.usage ? toMessageUsage(result.usage) : undefined,
        })
        emitContext()
        options.onUsageMaybeChanged?.()
        return
      }
      case "queue_update": {
        bus.emit(runId, {
          type: "queue.updated",
          agentId,
          steering: [...event.steering],
          followUp: [...event.followUp],
        })
        return
      }
      default:
        return
    }
  }

  function formatTokensLabel(count: number): string {
    if (count < 1000) return String(count)
    if (count < 1_000_000) return `${Math.round(count / 1000)}k`
    return `${(count / 1_000_000).toFixed(1)}M`
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
  // notice (child_result handoff or system marker)
  const extra: Record<string, unknown> = {
    source: msg.source,
    timestamp: msg.timestamp,
  }
  if (msg.kind) extra.kind = msg.kind
  if (msg.title) extra.title = msg.title
  if (msg.detail !== undefined) extra.detail = msg.detail
  if (msg.usage) extra.usage = msg.usage
  if (msg.handoff) extra.handoff = msg.handoff
  return extra
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
  if (row.role === "notice") {
    const text = typeof content === "string" ? content : ""
    return {
      role: "notice",
      id: row.id,
      seq: row.seq,
      agentId: row.agentId,
      createdAt: row.createdAt,
      source: (payload.source as WireNotice["source"]) ?? "child_result",
      text,
      ...(payload.handoff
        ? { handoff: payload.handoff as WireNotice["handoff"] }
        : {}),
      ...(payload.kind ? { kind: payload.kind as WireNotice["kind"] } : {}),
      ...(payload.title ? { title: payload.title as string } : {}),
      ...(payload.detail !== undefined
        ? { detail: payload.detail as string }
        : {}),
      ...(payload.usage ? { usage: payload.usage as MessageUsage } : {}),
      timestamp: payload.timestamp as number | undefined,
    }
  }
  return null
}
