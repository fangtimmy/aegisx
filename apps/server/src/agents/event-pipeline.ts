import type { TimingBlockType, TimingMeta } from "@aegisx/shared"
import type { ContextSnapshot, ToolTerminal } from "@aegisx/shared/live-event"
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type {
  AgentSession,
  AgentSessionEvent,
  SessionEntry,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent"

import { isRecord } from "../lib/guards"
import { accumulateEntryUsage } from "./entry-usage"
import type { LiveBus } from "./live"

/** AssistantMessageEvent (from pi-ai) reached indirectly via the SDK union —
 * extracting it avoids a deep pi-ai import and stays in lockstep with the
 * AgentSessionEvent shape the pipeline already consumes. */
type AssistantMessageEvent = Extract<
  AgentSessionEvent,
  { type: "message_update" }
>["assistantMessageEvent"]

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
function messageIdOf(agentId: string, msg: AgentMessage): string {
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
 * AgentToolResult side channel that survives into the persisted toolResult
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
      ? details.terminal
      : sdkError
        ? "failed"
        : undefined
  return { terminal, isError: terminal !== undefined }
}

function isTerminalValue(value: unknown): value is ToolTerminal {
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
 * The `channel` is the LiveBus key: the agent id. The pipeline is agnostic
 * to anything above the agent.
 */
export function createAgentEventPipeline(options: {
  channel: string
  agentId: string
  bus: LiveBus
  /** Live context snapshot for the conversation stat strip. */
  sampleContext?: () => ContextSnapshot | null
  /** Fired after a commit that may change run-wide usage (compaction /
   * branch_summary), so the service can recompute + re-emit the run snapshot. */
  onUsageMaybeChanged?: () => void
}) {
  const { channel, agentId, bus } = options
  let revision = 0
  const nextRevision = () => (revision += 1)

  function emitContext(): void {
    const sample = options.sampleContext?.()
    if (!sample) return
    bus.emit(channel, { type: "context.updated", agentId, ...sample })
  }

  // --- timing state machine (v10 meta) -------------------------------------
  // Two paths: assistant messages (message_start → deltas → message_end) and
  // toolResult messages (tool_execution_start → tool_execution_end). The pi
  // pipeline skips message_start for toolResult, so its duration comes only
  // from tool execution. Finalized timing is read by `metaFor` (the
  // DbSessionManager metaProvider) and attached to the committed entry, then
  // dropped to bound memory.
  let assistantT0: number | null = null
  const blockTimings = new Map<
    number,
    { type: TimingBlockType; startMs: number; endMs: number }
  >()
  const assistantFinalized = new Map<string, TimingMeta>()
  const toolExecStart = new Map<string, number>()
  const toolResultDuration = new Map<string, number>()

  /** Fold one streaming block event into the in-flight assistant accumulator.
   * The first event for a content index records its type + start; subsequent
   * events advance endMs. Only thinking/text/toolCall blocks are timed. */
  function recordBlockTiming(ae: AssistantMessageEvent): void {
    if (assistantT0 === null) return
    const offset = Date.now() - assistantT0
    let type: TimingBlockType | null = null
    let index = -1
    switch (ae.type) {
      case "text_start":
      case "text_delta":
      case "text_end":
        type = "text"
        index = ae.contentIndex
        break
      case "thinking_start":
      case "thinking_delta":
      case "thinking_end":
        type = "thinking"
        index = ae.contentIndex
        break
      case "toolcall_start":
      case "toolcall_delta":
      case "toolcall_end":
        type = "toolCall"
        index = ae.contentIndex
        break
      default:
        return
    }
    const existing = blockTimings.get(index)
    if (existing) {
      existing.endMs = offset
      return
    }
    blockTimings.set(index, { type, startMs: offset, endMs: offset })
  }

  /** Freeze the assistant timing into a TimingMeta keyed by the message id.
   * Called at message_end (pi appends the message right after, so the commit
   * that reads it via `metaFor` follows). */
  function finalizeAssistant(message: AgentMessage): void {
    if (message.role !== "assistant" || assistantT0 === null) return
    const durationMs = Date.now() - assistantT0
    const blocks = [...blockTimings.entries()]
      .toSorted((a, b) => a[0] - b[0])
      .map(([index, b]) => ({
        type: b.type,
        index,
        startMs: b.startMs,
        endMs: b.endMs,
      }))
    assistantFinalized.set(messageIdOf(agentId, message), {
      durationMs,
      ...(blocks.length > 0 ? { blocks } : {}),
    })
    assistantT0 = null
    blockTimings.clear()
  }

  /** Timing meta for a session entry, or null when none was recorded. The
   * DbSessionManager calls this pre-commit (metaProvider) to write the `meta`
   * column; `commitEntry` calls it again to attach meta to the live
   * message.committed item. */
  function metaFor(entry: SessionEntry): TimingMeta | null {
    if (entry.type !== "message") return null
    const message = entry.message
    if (message.role === "assistant") {
      return assistantFinalized.get(messageIdOf(agentId, message)) ?? null
    }
    if (message.role === "toolResult") {
      const durationMs = toolResultDuration.get(message.toolCallId)
      return durationMs !== undefined ? { durationMs } : null
    }
    return null
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
    const meta = metaFor(entry)
    bus.emit(channel, {
      type: "message.committed",
      agentId,
      item: {
        entry,
        seq,
        key: entryKeyOf(agentId, entry),
        ...(meta ? { meta } : {}),
      },
    })
    // Bound memory: the timing is now persisted on the row (meta column) and
    // carried on the live item above, so drop the in-memory copy.
    if (entry.type === "message") {
      if (entry.message.role === "assistant") {
        assistantFinalized.delete(messageIdOf(agentId, entry.message))
      } else if (entry.message.role === "toolResult") {
        toolResultDuration.delete(entry.message.toolCallId)
      }
    }
    if (entry.type === "compaction" || entry.type === "branch_summary") {
      emitContext()
      options.onUsageMaybeChanged?.()
    }
  }

  function handle(event: AgentSessionEvent): void {
    switch (event.type) {
      case "message_update": {
        const ae = event.assistantMessageEvent
        recordBlockTiming(ae)
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
          bus.emit(channel, {
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
        // timing: begin a new assistant accumulation window (message_start
        // resets the per-message state machine; toolResult is skipped above).
        if (event.message.role === "assistant") {
          assistantT0 = Date.now()
          blockTimings.clear()
        }
        const entry = syntheticMessageEntry(agentId, event.message)
        bus.emit(channel, {
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
        // timing: freeze the assistant meta (durationMs + blocks). pi appends
        // the message right after emitting message_end, so this runs before
        // the commit that consumes it via `metaFor`.
        finalizeAssistant(event.message)
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
        // W6: the emitted event carries the server-side start time (the same
        // value the timing state machine records), so the frontend can render
        // the true elapsed time even when the dialog opened mid-execution.
        const startedAt = Date.now()
        toolExecStart.set(event.toolCallId, startedAt)
        bus.emit(channel, {
          type: "tool.progress",
          agentId,
          toolCallId: event.toolCallId,
          revision: nextRevision(),
          toolName: event.toolName,
          args: event.args,
          status: "running",
          startedAt,
        })
        return
      }
      case "tool_execution_update": {
        bus.emit(channel, {
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
        const execStart = toolExecStart.get(event.toolCallId)
        if (execStart !== undefined) {
          toolResultDuration.set(event.toolCallId, Date.now() - execStart)
          toolExecStart.delete(event.toolCallId)
        }
        // The SDK's tool_execution_end carries no args; omitting `args` lets
        // the store keep the args captured at tool_execution_start/_update
        // (null here would clobber them). The terminal reason + isError come
        // from result.details.terminal (structured) when the tool provides it,
        // falling back to the SDK's isError for untyped tools that still throw.
        const { terminal, isError } = terminalOf(event.result, event.isError)
        bus.emit(channel, {
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
        bus.emit(channel, {
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
        bus.emit(channel, { type: "agent.activity", agentId, activity: null })
        return
      }
      case "summarization_retry_scheduled": {
        // Retry of a compaction/branch-summary summarization call (shared pi
        // retry budget). Transient SSE badge — mirrors auto_retry_start.
        bus.emit(channel, {
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
        bus.emit(channel, { type: "agent.activity", agentId, activity })
        return
      }
      case "summarization_retry_finished": {
        bus.emit(channel, { type: "agent.activity", agentId, activity: null })
        return
      }
      case "compaction_start": {
        bus.emit(channel, {
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
        bus.emit(channel, { type: "agent.activity", agentId, activity: null })
        return
      }
      case "queue_update": {
        bus.emit(channel, {
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

  return { handle, commitEntry, metaFor }
}
