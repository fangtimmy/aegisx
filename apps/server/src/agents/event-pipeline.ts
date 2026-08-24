import type { ContextSnapshot, ToolTerminal } from "@aegisx/shared/live-event"
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type {
  AgentSession,
  AgentSessionEvent,
  SessionEntry,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent"

import { accumulateEntryUsage } from "./entry-usage"
import type { LiveBus } from "./live"

/**
 * Stable identity / match key for a session entry.
 *
 * For message entries it is derived from the AgentMessage so it is identical
 * before the entry is persisted (a streaming `message.progress` draft) and
 * after (`message.committed`), letting the frontend store swap the draft for
 * the committed entry. For other kinds (compaction, branch_summary, ...) it is
 * the entry's own id (those are never streamed in-progress).
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

/** Read a tool's structured terminal reason from its result.details — the
 * AgentToolResult side topic that survives into the persisted toolResult
 * (unlike `content`, `details` is not sent to the model). Tools that classify
 * outcomes (the AegisX bash tool) put a `terminal` field there so the UI can
 * show 已超时 / 已取消 instead of a generic 失败, without the pipeline parsing
 * prose. Falls back to "failed" when the SDK reports an error but the tool
 * gave no structured reason (e.g. an untyped tool that still throws). */
function terminalOf(
  result: unknown,
  sdkError: boolean
): { terminal: ToolTerminal | undefined; isError: boolean } {
  const details =
    result && typeof result === "object"
      ? (result as { details?: unknown }).details
      : undefined
  const terminal =
    isRecord(details) && isTerminalValue(details.terminal)
      ? (details.terminal as ToolTerminal)
      : sdkError
        ? "failed"
        : undefined
  return { terminal, isError: terminal !== undefined }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isTerminalValue(value: unknown): boolean {
  return value === "timed_out" || value === "cancelled" || value === "failed"
}

/** Per-agent context snapshot for the conversation stat strip (pi-TUI footer
 * parity: cumulative usage from session entries via the shared accumulator +
 * live context usage from `session.getContextUsage()`). */
export function computeContextSample(session: AgentSession): ContextSnapshot {
  const sample = accumulateEntryUsage(session.sessionManager.getEntries())
  const cu = session.getContextUsage()
  return {
    tokens: cu?.tokens ?? null,
    contextWindow: cu?.contextWindow ?? 0,
    percent: cu?.percent ?? null,
    cacheHitRate: sample.cacheHitRate,
    totals: {
      input: sample.input,
      output: sample.output,
      cacheRead: sample.cacheRead,
      cacheWrite: sample.cacheWrite,
      cost: sample.cost,
    },
  }
}

export type AgentEventPipeline = ReturnType<typeof createAgentEventPipeline>

/**
 * Per-agent event pipeline. Subscribed to one AgentSession; translates SDK
 * events into live SSE progress (ephemeral) over the bus. Durable persistence
 * is owned by the injected SessionManager (DbSessionManager writes
 * session_entries as pi appends) — this pipeline never writes storage itself.
 *
 * `message.committed` is driven by the storage layer: DbSessionManager fires
 * `onAppend(entry, seq)` from its `commit()` for every persisted entry (pi emits
 * no equivalent event for regular messages — it `_emit`s `message_end` *before*
 * calling `appendMessage`). That callback is the authoritative "entry just
 * persisted" signal, carrying the entry's real `seq`. No tree diffing, no
 * positional guess. retry is intentionally transient (SSE activity only);
 * compaction / branch_summary surface as their own entries (centered markers).
 *
 * The `topic` is the LiveBus key: a run id for solver agents, an event id
 * for the orchestrator. The pipeline is agnostic to which.
 */
export function createAgentEventPipeline(options: {
  topic: string
  agentId: string
  bus: LiveBus
  /** Live context snapshot for the conversation stat strip. */
  sampleContext?: () => ContextSnapshot | null
  /** Fired after a commit that may change run-wide usage (compaction /
   * branch_summary), so the service can recompute + re-emit the run snapshot. */
  onUsageMaybeChanged?: () => void
}) {
  const { topic, agentId, bus } = options
  let revision = 0
  const nextRevision = () => (revision += 1)

  function emitContext(): void {
    const sample = options.sampleContext?.()
    if (!sample) return
    bus.emit(topic, { type: "context.updated", agentId, ...sample })
  }

  /** Called by DbSessionManager.onAppend for every persisted entry. Emits
   * message.committed for renderable kinds with the entry's real seq, and
   * refreshes context/totals when a compaction/branch_summary lands (they carry
   * their own usage). Non-renderable kinds (model_change, custom, ...) are
   * skipped but still occupied a seq, so the gap matches `listMessages`. */
  function commitEntry(entry: SessionEntry, seq: number): void {
    if (
      entry.type !== "message" &&
      entry.type !== "compaction" &&
      entry.type !== "branch_summary"
    ) {
      return
    }
    bus.emit(topic, {
      type: "message.committed",
      agentId,
      item: { entry, seq, key: entryKeyOf(agentId, entry) },
    })
    if (entry.type === "compaction" || entry.type === "branch_summary") {
      emitContext()
      options.onUsageMaybeChanged?.()
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
          ae.type === "toolcall_start" ||
          ae.type === "toolcall_delta" ||
          ae.type === "toolcall_end"
        ) {
          const entry = syntheticMessageEntry(agentId, event.message)
          bus.emit(topic, {
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
        // A toolResult message is driven by tool.progress (status + result)
        // and finalized by message.committed; a streaming draft for it is
        // redundant (the tool block already shows it). Skip it, only refresh
        // the stat strip.
        if (event.message.role === "toolResult") {
          emitContext()
          return
        }
        const entry = syntheticMessageEntry(agentId, event.message)
        bus.emit(topic, {
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
        // The entry is committed via DbSessionManager.onAppend (pi appends the
        // message right after emitting message_end). Here we only refresh the
        // stat strip.
        emitContext()
        return
      }
      case "turn_end": {
        emitContext()
        return
      }
      case "agent_end": {
        if (event.willRetry) return
        emitContext()
        return
      }
      case "tool_execution_start": {
        bus.emit(topic, {
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
        bus.emit(topic, {
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
        // The SDK's tool_execution_end carries no args; omitting `args` lets
        // the store keep the args captured at tool_execution_start/_update
        // (null here would clobber them). The terminal reason + isError come
        // from result.details.terminal (structured) when the tool provides it,
        // falling back to the SDK's isError for untyped tools that still throw.
        const { terminal, isError } = terminalOf(event.result, event.isError)
        bus.emit(topic, {
          type: "tool.progress",
          agentId,
          toolCallId: event.toolCallId,
          revision: nextRevision(),
          toolName: event.toolName,
          result: event.result,
          status: isError ? "error" : "done",
          isError: isError || undefined,
          ...(terminal ? { terminal } : {}),
        })
        return
      }
      case "auto_retry_start": {
        // Transient: retry never persists (pi itself doesn't); SSE badge only.
        bus.emit(topic, {
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
        bus.emit(topic, { type: "agent.activity", agentId, activity: null })
        return
      }
      case "summarization_retry_scheduled": {
        // Retry of a compaction/branch-summary summarization call (shared pi
        // retry budget). Transient SSE badge — mirrors auto_retry_start.
        bus.emit(topic, {
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
      case "summarization_retry_attempt_start": {
        // source "branchSummary" → still a retry; "compaction" → re-entering
        // compaction. Reflect it so the badge matches what pi is doing.
        const activity =
          event.source === "branchSummary" ? "retrying" : "compacting"
        bus.emit(topic, { type: "agent.activity", agentId, activity })
        return
      }
      case "summarization_retry_finished": {
        bus.emit(topic, { type: "agent.activity", agentId, activity: null })
        return
      }
      case "compaction_start": {
        bus.emit(topic, {
          type: "agent.activity",
          agentId,
          activity: "compacting",
          reason: event.reason,
        })
        return
      }
      case "compaction_end": {
        // The compaction summary (tokensBefore) is surfaced as a committed
        // system marker via message.committed; here we only clear the badge.
        bus.emit(topic, { type: "agent.activity", agentId, activity: null })
        return
      }
      case "queue_update": {
        bus.emit(topic, {
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

  return { handle, commitEntry }
}
