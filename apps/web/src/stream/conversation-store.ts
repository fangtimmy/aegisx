import type {
  AgentSummary,
  ContextSnapshot,
  EntryItem,
  LiveEvent,
  SessionEntryView,
} from "@/api"
import {
  buildConversation,
  type ConversationItem,
  type LiveEntry,
} from "@/domain/conversation"

import { liveConnection } from "./live-connection"

type Listener = () => void

type MessageProgress = {
  agentId: string
  key: string
  revision: number
  entry: SessionEntryView
}

type ToolProgress = {
  agentId: string
  toolCallId: string
  revision: number
  toolName: string
  /** Server-side execution start (epoch ms) — true elapsed time even when the
   * dialog opened mid-execution. Only the tool_execution_start frame carries
   * it; update/end frames supersede this entry without one. */
  startedAt?: number
  args?: unknown
  result?: unknown
  status: "running" | "done" | "error"
  isError: boolean
  terminal?: "timed_out" | "cancelled" | "failed"
  terminalMessage?: string
}

type ActivityState = {
  activity: "retrying" | "compacting"
  detail?: string
  attempt?: number
  maxAttempts?: number
  delayMs?: number
  reason?: "manual" | "threshold" | "overflow"
}

type QueueState = {
  steering: string[]
  followUp: string[]
}

type AgentView = {
  stableThroughKey: string | null
  stable: ConversationItem[]
  tail: EntryItem[]
}

const emptyItems: ConversationItem[] = []

/** A user message entry — a turn boundary for the stable/tail split. */
function isUserTurn(item: EntryItem): boolean {
  return item.entry.type === "message" && item.entry.message.role === "user"
}

/** Tool-call id of a toolResult entry, if any. */
function toolCallIdOf(entry: SessionEntryView): string | null {
  if (entry.type === "message" && entry.message.role === "toolResult") {
    return entry.message.toolCallId
  }
  return null
}

/**
 * Per-agent conversation state, keyed by agentId, fed by the multiplexed
 * live connection ({@link ingest}) and by REST snapshots
 * ({@link applySnapshot}); consumers subscribe per agent and read selectors.
 *
 * Optimization: the committed history is split at the last user-turn boundary.
 * Everything up to that boundary is memoized ("stable") and only the tail
 * (boundary onwards + live) is rebuilt on each event — so high-frequency
 * text_delta streaming only re-renders the active turn, not the whole history.
 * Notifications are rAF-batched so a burst of deltas collapses into one frame.
 */
export class ConversationStore {
  private readonly messages = new Map<string, Map<string, EntryItem>>()
  private readonly messageProgress = new Map<
    string,
    Map<string, MessageProgress>
  >()
  private readonly toolProgress = new Map<string, Map<string, ToolProgress>>()
  private readonly completedTools = new Map<string, Set<string>>()
  private readonly activity = new Map<string, ActivityState>()
  private readonly context = new Map<string, ContextSnapshot>()
  private readonly queues = new Map<string, QueueState>()
  private readonly views = new Map<string, AgentView>()
  private readonly snapshots = new Map<string, ConversationItem[]>()
  private readonly listeners = new Map<string, Set<Listener>>()
  private readonly pendingNotifications = new Set<string>()
  private notificationFrame: number | null = null
  private agents = new Map<string, AgentSummary>()
  /** Agents whose durable history the UI is rendering (see {@link retain}).
   * Only their message frames are ingested: on the multiplexed stream every
   * agent's frames arrive, so without this the browser would accumulate the
   * whole fleet's history. */
  private retained = new Set<string>()
  /** Generation per agent, bumped by reset()/retain-eviction. Async reloads
   * capture it up front and applySnapshot rejects responses from older
   * generations — the request/response guard for server-side truncations
   * (session switch / backtrack): an in-flight listMessages response landing
   * after a reset must not merge deleted rows back in. */
  private readonly epochs = new Map<string, number>()
  /** Per-session lastSeq cursor (seq is session-scoped — multi-session
   * agents must not share one), fed by message.committed frames. The merge
   * rule for the durable face is total: drop anything with seq ≤ lastSeq,
   * which makes snapshot-vs-live ordering races impossible by construction.
   * `activeSession` tracks which session the agent is currently committing
   * to (the cursor the next catch-up reads). */
  private readonly lastSeqBySession = new Map<string, Map<string, number>>()
  private readonly activeSession = new Map<string, string>()

  constructor() {
    // Queued notifications drain on rAF, which hidden tabs suspend; the
    // visibility handler force-drains on restore (see notify). No DOM in unit
    // tests — there the store is pure state.
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.handleVisibilityChange)
    }
  }

  /** Queued notifications drain here; rAF stalls in hidden tabs, so the
   * visibility handler force-drains on restore (see notify). */
  private readonly handleVisibilityChange = () => {
    if (
      document.hidden ||
      this.notificationFrame !== null ||
      this.pendingNotifications.size === 0
    ) {
      return
    }
    this.flushNotifications()
  }

  subscribe(agentId: string, listener: Listener) {
    const listeners = this.listeners.get(agentId) ?? new Set<Listener>()
    listeners.add(listener)
    this.listeners.set(agentId, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.listeners.delete(agentId)
    }
  }

  get(agentId: string) {
    return this.snapshots.get(agentId) ?? emptyItems
  }

  /** Current generation for an agent — capture before an async reload and
   * pass back to applySnapshot so a stale response (an older reload landing
   * after a newer reset) cannot merge truncated rows back in. */
  epochOf(agentId: string) {
    return this.epochs.get(agentId) ?? 0
  }

  /** The active session's lastSeq — the `after` cursor for the next
   * incremental catch-up (0 when nothing has been seen: full pull). */
  cursorOf(agentId: string) {
    const sessionId = this.activeSession.get(agentId)
    if (sessionId === undefined) return 0
    return this.lastSeqBySession.get(agentId)?.get(sessionId) ?? 0
  }

  getAgents() {
    return [...this.agents.values()]
  }

  /** Per-agent row (the SAME object reference until the next agent.updated),
   * so consumers can dedupe by identity instead of deep comparison. */
  getAgent(agentId: string) {
    return this.agents.get(agentId) ?? null
  }

  getActivity(agentId: string) {
    return this.activity.get(agentId) ?? null
  }

  /** Latest context snapshot for the stat strip (null until first sample). */
  getContext(agentId: string): ContextSnapshot | null {
    return this.context.get(agentId) ?? null
  }

  /** Latest steer/followUp queue for an agent (empty when none queued). */
  getQueue(agentId: string): QueueState | null {
    return this.queues.get(agentId) ?? null
  }

  /** Latest running tool for an agent, for the "Working…" activity badge. */
  getRunningTool(agentId: string): { toolName: string; args: unknown } | null {
    const tools = this.toolProgress.get(agentId)
    if (!tools) return null
    let latest: ToolProgress | null = null
    for (const tool of tools.values()) {
      if (tool.status === "running") latest = tool
    }
    if (!latest) return null
    return { toolName: latest.toolName, args: latest.args }
  }

  /** Drop ALL state for one agent (session switch / flat backtrack / a
   * detected server-side truncation). The caller re-fetches committed
   * messages from scratch afterwards — the cursor state is cleared with the
   * maps, so the reload is a full pull and the next append after a
   * backtrack (which reuses seqs) merges normally. */
  reset(agentId: string) {
    this.epochs.set(agentId, (this.epochs.get(agentId) ?? 0) + 1)
    this.messages.delete(agentId)
    this.messageProgress.delete(agentId)
    this.toolProgress.delete(agentId)
    this.completedTools.delete(agentId)
    this.activity.delete(agentId)
    this.queues.delete(agentId)
    this.context.delete(agentId)
    this.views.delete(agentId)
    this.snapshots.delete(agentId)
    this.lastSeqBySession.delete(agentId)
    this.activeSession.delete(agentId)
    this.notify(agentId)
  }

  /**
   * Drop ALL ephemeral live state after an SSE disconnect: streamed drafts,
   * running tool progress and transient activity are cleared so a reconnect
   * re-derives them from the freshly re-fetched committed history + the new
   * live stream (the server's seed snapshot replays in-flight tools; message
   * drafts reappear with the next delta or commit).
   */
  resetForReconnect() {
    const agentIds = new Set([
      ...this.messageProgress.keys(),
      ...this.toolProgress.keys(),
      ...this.activity.keys(),
    ])
    this.messageProgress.clear()
    this.toolProgress.clear()
    this.activity.clear()
    for (const agentId of agentIds) this.rebuildLive(agentId)
  }

  private rebuildCommitted(agentId: string) {
    const messages = [...(this.messages.get(agentId)?.values() ?? [])].toSorted(
      (left, right) => left.seq - right.seq
    )
    let boundary = -1
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index] && isUserTurn(messages[index])) {
        boundary = index
        break
      }
    }
    const stableThroughKey = messages[boundary]?.key ?? null
    const previous = this.views.get(agentId)
    const stable =
      previous && previous.stableThroughKey === stableThroughKey
        ? previous.stable
        : buildConversation(messages.slice(0, boundary + 1), [])
    this.views.set(agentId, {
      stableThroughKey,
      stable,
      tail: messages.slice(boundary + 1),
    })
    this.rebuildLive(agentId)
  }

  private rebuildLive(agentId: string) {
    const view = this.views.get(agentId) ?? {
      stableThroughKey: null,
      stable: [],
      tail: [],
    }
    const live: LiveEntry[] = [
      ...[...(this.messageProgress.get(agentId)?.values() ?? [])].map(
        (entry) => ({
          key: `message:${entry.key}`,
          type: "message" as const,
          entry: entry.entry,
        })
      ),
      ...[...(this.toolProgress.get(agentId)?.values() ?? [])].map((entry) => ({
        key: `tool:${entry.toolCallId}`,
        type: "tool" as const,
        toolCallId: entry.toolCallId,
        toolName: entry.toolName,
        args: entry.args,
        result: entry.result,
        isError: entry.isError,
        status: entry.status === "error" ? "done" : entry.status,
        ...("startedAt" in entry && entry.startedAt !== undefined
          ? { startedAt: entry.startedAt }
          : {}),
        ...("terminal" in entry ? { terminal: entry.terminal } : {}),
        ...("terminalMessage" in entry
          ? { terminalMessage: entry.terminalMessage }
          : {}),
      })),
    ]
    const tail = buildConversation(view.tail, live)
    this.snapshots.set(
      agentId,
      tail.length === 0 ? view.stable : [...view.stable, ...tail]
    )
    this.notify(agentId)
  }

  /**
   * Apply a REST snapshot of the agent's committed history.
   *
   * Callers mid-reload pass the generation captured before their fetch so a
   * stale response (an older reload landing after a newer reset) cannot merge
   * truncated rows back in; without one the snapshot is treated as current.
   * `after` is the cursor the request was made with: a FULL-PULL response
   * (after === 0) is the authoritative read of the active session and
   * REPLACES the stored messages and that session's cursor instead of
   * merging — a stale `message.committed` frame that landed in a reset
   * window must not poison the cursor (its ghost seq would make the merge
   * drop this very snapshot's surviving rows, leaving a ghost-only view).
   * Incremental snapshots keep the seq-ordered merge.
   */
  applySnapshot(
    agentId: string,
    items: EntryItem[],
    epoch?: number,
    after?: number
  ) {
    const current = this.epochOf(agentId)
    if (epoch !== undefined && epoch !== current) return
    const fullPull = after === 0
    const cursor = this.cursorOf(agentId)
    const stored = fullPull
      ? new Map<string, EntryItem>()
      : (this.messages.get(agentId) ?? new Map())
    const committedKeys = new Set<string>()
    const completedTools = fullPull
      ? new Set<string>()
      : (this.completedTools.get(agentId) ?? new Set<string>())
    let head = 0
    for (const item of items) {
      if (!fullPull && item.seq <= cursor) continue
      stored.set(item.key, item)
      committedKeys.add(item.key)
      if (item.seq > head) head = item.seq
      const toolCallId = toolCallIdOf(item.entry)
      if (toolCallId) completedTools.add(toolCallId)
    }
    if (fullPull) {
      const sessionId = this.activeSession.get(agentId)
      if (sessionId !== undefined) {
        const sessions =
          this.lastSeqBySession.get(agentId) ?? new Map<string, number>()
        if (head === 0) sessions.delete(sessionId)
        else sessions.set(sessionId, head)
        this.lastSeqBySession.set(agentId, sessions)
      }
      this.completedTools.set(agentId, completedTools)
    }
    this.messages.set(agentId, stored)
    const progress = this.messageProgress.get(agentId)
    if (progress) {
      for (const key of committedKeys) progress.delete(key)
    }
    const tools = this.toolProgress.get(agentId)
    if (tools) {
      for (const toolCallId of completedTools) tools.delete(toolCallId)
    }
    this.rebuildCommitted(agentId)
  }

  applyEvent(event: LiveEvent) {
    if (event.type === "agent.updated") {
      this.agents.set(event.agent.id, event.agent)
      for (const listeners of this.listeners.values()) {
        for (const listener of listeners) listener()
      }
      return
    }
    if (event.type === "message.committed") {
      // The durable face is seq-ordered: anything at or below the session's
      // cursor was already merged (a replayed or duplicated frame) — drop it.
      const sessions = this.lastSeqBySession.get(event.agentId) ?? new Map()
      const cursor = sessions.get(event.sessionId) ?? 0
      if (event.item.seq <= cursor) return
      sessions.set(event.sessionId, event.item.seq)
      this.lastSeqBySession.set(event.agentId, sessions)
      this.activeSession.set(event.agentId, event.sessionId)
      const stored = this.messages.get(event.agentId) ?? new Map()
      stored.set(event.item.key, event.item)
      this.messages.set(event.agentId, stored)
      this.messageProgress.get(event.agentId)?.delete(event.item.key)
      const toolCallId = toolCallIdOf(event.item.entry)
      if (toolCallId) {
        const completedTools =
          this.completedTools.get(event.agentId) ?? new Set<string>()
        completedTools.add(toolCallId)
        this.completedTools.set(event.agentId, completedTools)
        this.toolProgress.get(event.agentId)?.delete(toolCallId)
      }
      this.rebuildCommitted(event.agentId)
      return
    }
    if (event.type === "message.progress") {
      if (this.messages.get(event.agentId)?.has(event.key)) return
      const progress = this.messageProgress.get(event.agentId) ?? new Map()
      const existing = progress.get(event.key)
      if (!existing || event.revision > existing.revision) {
        progress.set(event.key, {
          agentId: event.agentId,
          key: event.key,
          revision: event.revision,
          entry: event.entry,
        })
        this.messageProgress.set(event.agentId, progress)
        this.rebuildLive(event.agentId)
      }
      return
    }
    if (event.type === "tool.progress") {
      if (this.completedTools.get(event.agentId)?.has(event.toolCallId)) return
      const tools = this.toolProgress.get(event.agentId) ?? new Map()
      const existing = tools.get(event.toolCallId)
      if (!existing || event.revision > existing.revision) {
        tools.set(event.toolCallId, {
          ...event,
          isError: event.isError === true,
        })
        this.toolProgress.set(event.agentId, tools)
        this.rebuildLive(event.agentId)
      }
      return
    }
    if (event.type === "agent.activity") {
      if (event.activity === null) {
        if (this.activity.delete(event.agentId)) this.notify(event.agentId)
      } else {
        const state: ActivityState = { activity: event.activity }
        if (typeof event.detail === "string") state.detail = event.detail
        if (typeof event.attempt === "number") state.attempt = event.attempt
        if (typeof event.maxAttempts === "number")
          state.maxAttempts = event.maxAttempts
        if (typeof event.delayMs === "number") state.delayMs = event.delayMs
        if (event.reason) state.reason = event.reason
        this.activity.set(event.agentId, state)
        this.notify(event.agentId)
      }
      return
    }
    if (event.type === "context.updated") {
      this.context.set(event.agentId, {
        tokens: event.tokens,
        contextWindow: event.contextWindow,
        percent: event.percent,
        cacheHitRate: event.cacheHitRate,
        totals: event.totals,
      })
      this.notify(event.agentId)
      return
    }
    if (event.type === "queue.updated") {
      this.queues.set(event.agentId, {
        steering: event.steering,
        followUp: event.followUp,
      })
      this.notify(event.agentId)
    }
  }

  private notify(agentId: string) {
    this.pendingNotifications.add(agentId)
    if (this.notificationFrame !== null) return
    // Hidden tabs suspend rAF, which would freeze background streams; fall
    // back to a macrotask there (browsers throttle it to ~1 Hz — fine for a
    // tab the user cannot see). The visibility handler drains on restore.
    const hidden = typeof document !== "undefined" && document.hidden
    if (hidden) {
      this.notificationFrame = window.setTimeout(
        () => this.flushNotifications(),
        0
      )
    } else {
      this.notificationFrame = window.requestAnimationFrame(() =>
        this.flushNotifications()
      )
    }
  }

  private flushNotifications() {
    this.notificationFrame = null
    const pending = [...this.pendingNotifications]
    this.pendingNotifications.clear()
    for (const id of pending) {
      for (const listener of this.listeners.get(id) ?? []) listener()
    }
  }

  /**
   * Ingest one frame from the multiplexed live connection.
   *
   * Fleet-wide, bounded state (agent status, context, queue, activity,
   * in-flight tools) is kept for every agent — that is what makes the
   * connection's replay visible the moment an agent is selected, instead of
   * only from the next live event. Message frames are the unbounded part, so
   * they are kept only for retained agents (see {@link retain}); the REST
   * snapshot of a newly selected agent covers everything before its frame.
   * Channel messages are not conversation state — the channel view consumes
   * them straight off the connection.
   */
  ingest(event: LiveEvent) {
    switch (event.type) {
      case "agent.updated":
      case "context.updated":
      case "queue.updated":
      case "agent.activity":
      case "tool.progress":
        this.applyEvent(event)
        return
      case "message.progress":
      case "message.committed":
        if (this.retained.has(event.agentId)) this.applyEvent(event)
        return
      default:
        return
    }
  }

  /**
   * Declare which agents' durable history stays materialized. The UI passes
   * the agent(s) it renders; evicted agents keep their bounded state (context
   * / queue / activity / tools) so switching back shows the live picture
   * without a per-agent reconnect. Eviction also drops the seq cursors and
   * bumps the epoch: re-selecting the agent re-reads history from scratch
   * (the server may have truncated or switched sessions meanwhile).
   */
  retain(agentIds: Iterable<string>) {
    this.retained = new Set(agentIds)
    const evicted = new Set<string>()
    for (const map of [
      this.messages,
      this.messageProgress,
      this.views,
      this.snapshots,
    ]) {
      for (const agentId of map.keys()) {
        if (!this.retained.has(agentId)) evicted.add(agentId)
      }
    }
    for (const agentId of evicted) {
      this.messages.delete(agentId)
      this.messageProgress.delete(agentId)
      this.views.delete(agentId)
      this.snapshots.delete(agentId)
      this.completedTools.delete(agentId)
      this.lastSeqBySession.delete(agentId)
      this.activeSession.delete(agentId)
      this.epochs.set(agentId, this.epochOf(agentId) + 1)
      this.notify(agentId)
    }
  }
}

/** The process-level conversation state: one live connection feeds every
 * agent's state, and any number of components can subscribe to any agent. */
export const conversationStore = new ConversationStore()

let conversationStreamStarted = false

/** Wire the singleton store to the multiplexed live connection, exactly once.
 * Called from the app root: idempotent so StrictMode double-effects and HMR
 * remounts cannot double-subscribe. A reconnect drops the ephemeral state,
 * which the connection's replay then re-establishes from the server's bus
 * snapshot; durable history is the caller's to re-read. */
export function startConversationStream(): void {
  if (conversationStreamStarted) return
  conversationStreamStarted = true
  liveConnection.subscribe((event) => conversationStore.ingest(event))
  liveConnection.onReconnect(() => conversationStore.resetForReconnect())
}
