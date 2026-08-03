import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type {
  AgentSession,
  AgentSessionEvent,
  SessionEntry,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent"
import type { ContextSnapshot } from "../../../shared/live-event"
import type { LiveBus } from "./live"

/**
 * Stable identity / match key for a session entry.
 *
 * For message entries it is derived from the AgentMessage so it is identical
 * before the entry is persisted (a streaming `message.progress` draft) and
 * after (`message.committed`), letting the frontend store swap the draft for
 * the committed entry. For other kinds (compaction, ...) it is the entry's own
 * id (those are never streamed in-progress).
 */
export function entryKeyOf(agentId: string, entry: SessionEntry): string {
  if (entry.type === "message") {
    return messageIdOf(agentId, entry.message)
  }
  return entry.id
}

/** Deterministic, stable key for an SDK AgentMessage (it has none of its own). */
export function messageIdOf(agentId: string, msg: AgentMessage): string {
  if (msg.role === "toolResult") {
    return `${agentId}:toolResult:${msg.toolCallId}`
  }
  return `${agentId}:${msg.role}:${msg.timestamp}`
}

/** Build a synthetic message entry for a streaming (not-yet-persisted)
 * AgentMessage, so `message.progress` carries the same SessionEntry shape the
 * committed event will. id/parentId are placeholders (the store keys by `key`). */
function syntheticMessageEntry(
  agentId: string,
  msg: AgentMessage
): SessionMessageEntry {
  const ts = typeof msg.timestamp === "number" ? msg.timestamp : Date.now()
  return {
    type: "message",
    id: messageIdOf(agentId, msg),
    parentId: null,
    timestamp: new Date(ts).toISOString(),
    message: msg,
  }
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
    if (entry.type === "message" && entry.message.role === "assistant") {
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

type EntryUsage = {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  cost?: { total?: number }
}

function entryUsage(entry: SessionEntry): EntryUsage | undefined {
  if (entry.type === "message") {
    const msg = entry.message
    if (msg.role === "assistant" || msg.role === "toolResult") {
      return msg.usage as EntryUsage | undefined
    }
    return undefined
  }
  if (entry.type === "compaction" || entry.type === "branch_summary") {
    return entry.usage as EntryUsage | undefined
  }
  return undefined
}

function toNum(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

export type RunEventPipeline = ReturnType<typeof createRunEventPipeline>

/**
 * Per-agent event pipeline. Subscribed to one AgentSession; translates SDK
 * events into live SSE progress (ephemeral) over the bus. Durable persistence
 * is owned by the injected SessionManager (DbSessionManager writes
 * session_entries as pi appends) — this pipeline never writes storage itself.
 *
 * `message.committed` is emitted by diffing the session tree (via
 * `getSessionEntries`) against already-emitted entry ids, so each item's `seq`
 * always matches the persisted append order. retry is intentionally transient
 * (SSE activity only); compaction surfaces as its own entry (a centered marker
 * on the timeline).
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
      emittedEntryIds.add(entry.id)
      bus.emit(runId, {
        type: "message.committed",
        agentId,
        item: {
          entry,
          seq: i + 1,
          key: entryKeyOf(agentId, entry),
        },
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
          const entry = syntheticMessageEntry(agentId, event.message)
          bus.emit(runId, {
            type: "message.progress",
            agentId,
            key: messageIdOf(agentId, event.message),
            revision: nextRevision(),
            entry,
          })
        }
        return
      }
      case "message_start": {
        const entry = syntheticMessageEntry(agentId, event.message)
        bus.emit(runId, {
          type: "message.progress",
          agentId,
          key: messageIdOf(agentId, event.message),
          revision: nextRevision(),
          entry,
        })
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
        // The compaction entry was appended to the session tree; emit it so the
        // timeline marker appears + usage is folded into totals.
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
