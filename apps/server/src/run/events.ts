import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type {
  AgentSession,
  AgentSessionEvent,
  SessionEntry,
} from "@earendil-works/pi-coding-agent"
import type {
  MessageUsage,
  AssistantMessage as WireAssistant,
  Message as WireMessage,
  NoticeMessage as WireNotice,
  ToolResultMessage as WireToolResult,
  UserMessage as WireUser,
} from "../../../shared"
import type { ContextSnapshot } from "../../../shared/live-event"
import type { runEvents } from "../db/schema"
import type { LiveBus } from "./live"

type CompactionEntry = Extract<SessionEntry, { type: "compaction" }>

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

function entryUsage(entry: unknown): unknown {
  if (!entry || typeof entry !== "object") return undefined
  const e = entry as { type?: string; message?: unknown; usage?: unknown }
  if (e.type === "message") {
    const m = e.message as { role?: string; usage?: unknown } | undefined
    return m?.usage
  }
  if (e.type === "compaction" || e.type === "branch_summary") {
    return e.usage
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
    const u = usage as Record<string, unknown>
    totals.input += toNum(u.input)
    totals.output += toNum(u.output)
    totals.cacheRead += toNum(u.cacheRead)
    totals.cacheWrite += toNum(u.cacheWrite)
    totals.cost += toNum((u.cost as { total?: number } | undefined)?.total)
    const e = entry as { type?: string; message?: { role?: string } }
    if (e.type === "message" && e.message?.role === "assistant") {
      const prompt = toNum(u.input) + toNum(u.cacheRead) + toNum(u.cacheWrite)
      if (prompt > 0) cacheHitRate = (toNum(u.cacheRead) / prompt) * 100
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

function formatTokensLabel(count: number): string {
  if (count < 1000) return String(count)
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`
  return `${(count / 1_000_000).toFixed(1)}M`
}

/** Normalize an SDK AgentMessage into the wire Message (seq assigned by caller). */
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

/** Project a persisted session entry into the wire Message shape. message
 * entries normalize their AgentMessage; compaction entries become a system
 * notice (centered timeline marker). Other entry kinds (model_change, label,
 * ...) are dropped (not rendered). `seq` is the entry's append position. */
export function entryToWireMessage(
  agentId: string,
  entry: SessionEntry,
  seq: number
): WireMessage | null {
  if (entry.type === "message") {
    const wire = normalizeMessage(agentId, entry.message)
    if (!wire) return null
    wire.seq = seq
    wire.createdAt = entry.timestamp
    return wire
  }
  if (entry.type === "compaction") {
    return compactionEntryToNotice(agentId, entry, seq)
  }
  return null
}

function compactionEntryToNotice(
  agentId: string,
  entry: CompactionEntry,
  seq: number
): WireNotice {
  const timestamp = Date.parse(entry.timestamp) || Date.now()
  const title = `Compacted ${formatTokensLabel(entry.tokensBefore)} tokens`
  return {
    role: "notice",
    id: `${agentId}:compaction:${entry.id}`,
    seq,
    agentId,
    createdAt: entry.timestamp,
    source: "system",
    kind: "compact_end",
    text: title,
    title,
    timestamp,
    ...(entry.usage ? { usage: toMessageUsage(entry.usage) } : {}),
  }
}

/** Reconstruct a wire Message from a run_events row (legacy runs only:
 * pre-db-session runs keep their history in run_events, read-only). */
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

export type RunEventPipeline = ReturnType<typeof createRunEventPipeline>

/**
 * Per-agent event pipeline. Subscribed to one AgentSession; translates SDK
 * events into live SSE progress (ephemeral) over the bus. Durable persistence
 * is owned by the injected SessionManager (DbSessionManager writes
 * session_entries as pi appends) — this pipeline never writes storage itself.
 *
 * `message.committed` is emitted by diffing the session tree (via
 * `getSessionEntries`) against already-emitted entry ids, so the wire `seq`
 * always matches the persisted append order. retry is intentionally transient
 * (SSE activity only); compaction surfaces as a notice derived from its entry.
 */
export function createRunEventPipeline(options: {
  runId: string
  agentId: string
  bus: LiveBus
  /** Live session entries (null before the session is wired up). */
  getSessionEntries: () => SessionEntry[] | null
  /** Live context snapshot for the conversation stat strip. */
  sampleContext?: () => ContextSnapshot | null
  /** Fired after a commit that may change run-wide usage (compaction), so the
   * service can recompute + re-emit the run snapshot. */
  onUsageMaybeChanged?: () => void
}) {
  const { runId, agentId, bus } = options
  let revision = 0
  const nextRevision = () => (revision += 1)
  const emittedEntryIds = new Set<string>()

  function emitContext(): void {
    const sample = options.sampleContext?.()
    if (!sample) return
    bus.emit(runId, { type: "context.updated", agentId, ...sample })
  }

  /** Emit message.committed for every new message/compaction entry in the
   * session tree. seq is the entry's append position (1-based), matching the
   * persisted session_entries.seq / jsonl line number. */
  function emitNewCommitted(): void {
    const entries = options.getSessionEntries()
    if (!entries) return
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i]
      if (emittedEntryIds.has(entry.id)) continue
      if (entry.type !== "message" && entry.type !== "compaction") continue
      const wire = entryToWireMessage(agentId, entry, i + 1)
      if (!wire) continue
      emittedEntryIds.add(entry.id)
      bus.emit(runId, {
        type: "message.committed",
        agentId,
        message: wire,
      })
    }
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
        emitContext()
        return
      }
      case "message_end": {
        // pi appends the message to the session tree synchronously before
        // emitting message_end, so the new entry (with its seq) is readable.
        emitNewCommitted()
        emitContext()
        return
      }
      case "turn_end": {
        emitContext()
        return
      }
      case "agent_end": {
        if (event.willRetry) return
        emitNewCommitted()
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
        // Transient: retry never persists (pi itself doesn't); SSE badge only.
        bus.emit(runId, {
          type: "agent.activity",
          agentId,
          activity: "retrying",
          detail: event.errorMessage,
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
        })
        return
      }
      case "auto_retry_end": {
        bus.emit(runId, { type: "agent.activity", agentId, activity: null })
        return
      }
      case "compaction_start": {
        bus.emit(runId, {
          type: "agent.activity",
          agentId,
          activity: "compacting",
          reason: event.reason,
        })
        return
      }
      case "compaction_end": {
        bus.emit(runId, {
          type: "agent.activity",
          agentId,
          activity: null,
          ...(event.result?.tokensBefore !== undefined
            ? { tokensBefore: event.result.tokensBefore }
            : {}),
          ...(event.result?.estimatedTokensAfter !== undefined
            ? { tokensAfter: event.result.estimatedTokensAfter }
            : {}),
          ...(event.aborted ? { aborted: true } : {}),
        })
        // The compaction entry was appended to the session tree; emit it as a
        // notice so the timeline marker appears + usage is folded into totals.
        emitNewCommitted()
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

  return { handle }
}
