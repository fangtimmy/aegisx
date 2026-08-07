import type {
  AgentSummary,
  ContextSnapshot,
  EntryItem,
  LiveEvent,
  RunPublic,
  SessionEntry,
} from "@/api"
import {
  buildConversation,
  type ConversationItem,
  type LiveEntry,
} from "@/domain/conversation"

import { parseLiveEvent } from "./parse-event"

type Listener = () => void

type MessageProgress = {
  agentId: string
  key: string
  revision: number
  entry: SessionEntry
  pending: boolean
}

type ToolProgress = {
  agentId: string
  toolCallId: string
  revision: number
  toolName: string
  args: unknown
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
  tokensBefore?: number
  tokensAfter?: number
  aborted?: boolean
  success?: boolean
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
function toolCallIdOf(entry: SessionEntry): string | null {
  if (entry.type === "message" && entry.message.role === "toolResult") {
    return entry.message.toolCallId
  }
  return null
}

/**
 * Merges durable committed entries (from GET /messages) with ephemeral live
 * progress (from the SSE stream) into ConversationItem[] snapshots.
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
  private source: EventSource | null = null
  private run: RunPublic | null = null
  private agents = new Map<string, AgentSummary>()

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

  getRun() {
    return this.run
  }

  getAgents() {
    return [...this.agents.values()]
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

  /**
   * Drop ephemeral live state that may be stale after an SSE disconnect.
   * Keeps optimistic pending user messages; clears running tool/activity
   * progress and non-pending streamed drafts so a reconnect re-derives them
   * from the freshly re-fetched committed history + new live stream.
   */
  resetForReconnect() {
    const agentIds = new Set([
      ...this.messageProgress.keys(),
      ...this.toolProgress.keys(),
      ...this.activity.keys(),
    ])
    for (const [agentId, progress] of this.messageProgress) {
      for (const [key, entry] of progress) {
        if (!entry.pending) progress.delete(key)
      }
      if (progress.size === 0) this.messageProgress.delete(agentId)
    }
    this.toolProgress.clear()
    this.activity.clear()
    for (const agentId of agentIds) this.rebuildLive(agentId)
  }

  private rebuildCommitted(agentId: string) {
    const messages = [...(this.messages.get(agentId)?.values() ?? [])].sort(
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

  applySnapshot(agentId: string, items: EntryItem[]) {
    const stored = this.messages.get(agentId) ?? new Map()
    const committedKeys = new Set<string>()
    const completedTools = this.completedTools.get(agentId) ?? new Set<string>()
    for (const item of items) {
      stored.set(item.key, item)
      committedKeys.add(item.key)
      const toolCallId = toolCallIdOf(item.entry)
      if (toolCallId) completedTools.add(toolCallId)
    }
    this.messages.set(agentId, stored)
    this.completedTools.set(agentId, completedTools)
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
    if (event.type === "ready") return
    if (event.type === "run.updated") {
      this.run = event.run
      for (const listeners of this.listeners.values()) {
        for (const listener of listeners) listener()
      }
      return
    }
    if (event.type === "agent.updated") {
      this.agents.set(event.agent.id, event.agent)
      for (const listeners of this.listeners.values()) {
        for (const listener of listeners) listener()
      }
      return
    }
    if (event.type === "message.committed") {
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
        progress.set(event.key, { ...event, pending: false })
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
        if (typeof event.tokensBefore === "number")
          state.tokensBefore = event.tokensBefore
        if (typeof event.tokensAfter === "number")
          state.tokensAfter = event.tokensAfter
        if (typeof event.aborted === "boolean") state.aborted = event.aborted
        if (typeof event.success === "boolean") state.success = event.success
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
      for (const listeners of this.listeners.values()) {
        for (const listener of listeners) listener()
      }
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
    this.notificationFrame = window.requestAnimationFrame(() => {
      this.notificationFrame = null
      const pending = [...this.pendingNotifications]
      this.pendingNotifications.clear()
      for (const id of pending) {
        for (const listener of this.listeners.get(id) ?? []) listener()
      }
    })
  }

  /**
   * Connect the SSE stream for a run. On (re)connect, `onReconnect` is called
   * so the caller can re-fetch durable committed entries from the API.
   */
  connect(
    runId: string,
    onReconnect: () => void,
    onDisconnectedChange: (disconnected: boolean) => void,
    streamPath?: string
  ) {
    this.close()
    const source = new EventSource(streamPath ?? `/api/runs/${runId}/stream`)
    this.source = source
    let opened = false
    source.onopen = () => {
      if (this.source !== source) return
      const reconnecting = opened
      opened = true
      onDisconnectedChange(false)
      if (reconnecting) {
        this.resetForReconnect()
        onReconnect()
      }
    }
    source.onerror = () => {
      if (this.source !== source) return
      onDisconnectedChange(true)
    }
    source.onmessage = (message) => {
      if (this.source !== source) return
      let payload: unknown
      try {
        payload = JSON.parse(message.data)
      } catch {
        return
      }
      const event = parseLiveEvent(payload)
      if (event) this.applyEvent(event)
    }
    return () => this.close()
  }

  close() {
    if (this.source) {
      this.source.onopen = null
      this.source.onerror = null
      this.source.onmessage = null
      this.source.close()
    }
    this.source = null
    if (this.notificationFrame !== null) {
      window.cancelAnimationFrame(this.notificationFrame)
      this.notificationFrame = null
      this.pendingNotifications.clear()
    }
  }
}
