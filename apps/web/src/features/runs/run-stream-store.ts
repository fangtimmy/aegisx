import type {
  AgentSummary,
  ConversationMessage,
  RunPublic,
  RunStreamEvent,
} from "@/lib/api"
import {
  buildConversation,
  type ConversationItem,
  type LiveEntry,
} from "./timeline-model"

type Listener = () => void

type MessageProgress = {
  agentId: string
  messageId: string
  revision: number
  message: Record<string, unknown>
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

type AgentView = {
  stableThroughId: string | null
  stable: ConversationItem[]
  tail: ConversationMessage[]
}

const emptyItems: ConversationItem[] = []
const terminalStatuses = new Set<RunPublic["status"]>([
  "completed",
  "failed",
  "stopped",
])

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined
}

function isTerminal(
  value: unknown
): value is "timed_out" | "cancelled" | "failed" {
  return value === "timed_out" || value === "cancelled" || value === "failed"
}

function isTransientActivity(
  value: unknown
): value is "retrying" | "compacting" {
  return value === "retrying" || value === "compacting"
}

function parseEvent(value: unknown): RunStreamEvent | undefined {
  if (!record(value) || typeof value.type !== "string") return undefined
  if (value.type === "ready") {
    const cursor = numberValue(value.cursor)
    return typeof value.runId === "string" && cursor !== undefined
      ? { type: "ready", runId: value.runId, cursor }
      : undefined
  }
  if (value.type === "run.updated") {
    if (!record(value.run)) return undefined
    const cursor = numberValue(value.cursor)
    return {
      type: "run.updated",
      run: value.run as RunPublic,
      ...(cursor !== undefined ? { cursor } : {}),
    }
  }
  if (value.type === "agent.updated") {
    if (!record(value.agent)) return undefined
    const cursor = numberValue(value.cursor)
    return {
      type: "agent.updated",
      agent: value.agent as AgentSummary,
      ...(cursor !== undefined ? { cursor } : {}),
    }
  }
  if (value.type === "message.progress") {
    const revision = numberValue(value.revision)
    return typeof value.agentId === "string" &&
      typeof value.messageId === "string" &&
      revision !== undefined &&
      record(value.message)
      ? {
          type: "message.progress",
          agentId: value.agentId,
          messageId: value.messageId,
          revision,
          message: value.message,
        }
      : undefined
  }
  if (value.type === "tool.progress") {
    const revision = numberValue(value.revision)
    const status = value.status
    return typeof value.agentId === "string" &&
      typeof value.toolCallId === "string" &&
      typeof value.toolName === "string" &&
      revision !== undefined &&
      (status === "running" || status === "done" || status === "error")
      ? {
          type: "tool.progress",
          agentId: value.agentId,
          toolCallId: value.toolCallId,
          revision,
          toolName: value.toolName,
          args: value.args,
          ...("result" in value ? { result: value.result } : {}),
          status,
          ...(value.isError === true ? { isError: true } : {}),
          ...(isTerminal(value.terminal)
            ? {
                terminal: value.terminal,
                ...(typeof value.terminalMessage === "string"
                  ? { terminalMessage: value.terminalMessage }
                  : {}),
              }
            : {}),
        }
      : undefined
  }
  if (value.type === "agent.activity") {
    if (typeof value.agentId !== "string") return undefined
    if (value.activity === null) {
      return { type: "agent.activity", agentId: value.agentId, activity: null }
    }
    if (!isTransientActivity(value.activity)) return undefined
    return {
      type: "agent.activity",
      agentId: value.agentId,
      activity: value.activity,
      ...(typeof value.detail === "string" ? { detail: value.detail } : {}),
    }
  }
  if (value.type === "message.committed") {
    const cursor = numberValue(value.cursor)
    return typeof value.agentId === "string" &&
      cursor !== undefined &&
      record(value.message)
      ? {
          type: "message.committed",
          agentId: value.agentId,
          cursor,
          message: value.message as ConversationMessage,
        }
      : undefined
  }
  return undefined
}

export class RunStreamStore {
  private readonly messages = new Map<
    string,
    Map<string, ConversationMessage>
  >()
  private readonly messageProgress = new Map<
    string,
    Map<string, MessageProgress>
  >()
  private readonly toolProgress = new Map<string, Map<string, ToolProgress>>()
  private readonly completedTools = new Map<string, Set<string>>()
  private readonly activity = new Map<
    string,
    { activity: "retrying" | "compacting"; detail?: string }
  >()
  private readonly views = new Map<string, AgentView>()
  private readonly snapshots = new Map<string, ConversationItem[]>()
  private readonly listeners = new Map<string, Set<Listener>>()
  private readonly pendingNotifications = new Set<string>()
  private notificationFrame: number | null = null
  private source: EventSource | null = null

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

  getActivity(agentId: string): {
    activity: "retrying" | "compacting"
    detail?: string
  } | null {
    return this.activity.get(agentId) ?? null
  }

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

  private rebuildCommitted(agentId: string) {
    const messages = [...(this.messages.get(agentId)?.values() ?? [])].sort(
      (left, right) => left.sequence - right.sequence
    )
    let boundary = -1
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.message.role === "user") {
        boundary = index
        break
      }
    }
    const stableThroughId = messages[boundary]?.id ?? null
    const previous = this.views.get(agentId)
    const stable =
      previous?.stableThroughId === stableThroughId
        ? previous.stable
        : buildConversation(messages.slice(0, boundary + 1), [])
    this.views.set(agentId, {
      stableThroughId,
      stable,
      tail: messages.slice(boundary + 1),
    })
    this.rebuildLive(agentId)
  }

  private rebuildLive(agentId: string) {
    const view = this.views.get(agentId) ?? {
      stableThroughId: null,
      stable: [],
      tail: [],
    }
    const live: LiveEntry[] = [
      ...[...(this.messageProgress.get(agentId)?.values() ?? [])].map(
        (entry) => ({
          key: `message:${entry.messageId}`,
          type: "message" as const,
          message: entry.message,
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

  applySnapshot(agentId: string, messages: ConversationMessage[]) {
    const stored = this.messages.get(agentId) ?? new Map()
    const committedIds = new Set<string>()
    const completedTools = this.completedTools.get(agentId) ?? new Set<string>()
    for (const message of messages) {
      stored.set(message.id, message)
      committedIds.add(message.id)
      if (
        message.message.role === "toolResult" &&
        typeof message.message.toolCallId === "string"
      ) {
        completedTools.add(message.message.toolCallId)
      }
    }
    this.messages.set(agentId, stored)
    this.completedTools.set(agentId, completedTools)
    const progress = this.messageProgress.get(agentId)
    if (progress) {
      for (const messageId of committedIds) progress.delete(messageId)
    }
    const tools = this.toolProgress.get(agentId)
    if (tools) {
      for (const toolCallId of completedTools) tools.delete(toolCallId)
    }
    this.rebuildCommitted(agentId)
  }

  applyEvent(event: RunStreamEvent) {
    if (event.type === "ready") {
      return
    }
    if (event.type === "message.committed") {
      const stored = this.messages.get(event.agentId) ?? new Map()
      stored.set(event.message.id, event.message)
      this.messages.set(event.agentId, stored)
      this.messageProgress.get(event.agentId)?.delete(event.message.id)
      if (
        event.message.message.role === "toolResult" &&
        typeof event.message.message.toolCallId === "string"
      ) {
        const completedTools =
          this.completedTools.get(event.agentId) ?? new Set<string>()
        completedTools.add(event.message.message.toolCallId)
        this.completedTools.set(event.agentId, completedTools)
        this.toolProgress
          .get(event.agentId)
          ?.delete(event.message.message.toolCallId)
      }
      this.rebuildCommitted(event.agentId)
      return
    }
    if (event.type === "message.progress") {
      if (this.messages.get(event.agentId)?.has(event.messageId)) return
      const progress = this.messageProgress.get(event.agentId) ?? new Map()
      const existing = progress.get(event.messageId)
      if (!existing || event.revision > existing.revision) {
        progress.set(event.messageId, { ...event, pending: false })
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
        this.activity.set(event.agentId, {
          activity: event.activity,
          ...("detail" in event ? { detail: event.detail } : {}),
        })
        this.notify(event.agentId)
      }
    }
  }

  addPendingMessage(message: ConversationMessage) {
    const progress = this.messageProgress.get(message.agentId) ?? new Map()
    progress.set(message.id, {
      agentId: message.agentId,
      messageId: message.id,
      revision: 0,
      message: message.message,
      pending: true,
    })
    this.messageProgress.set(message.agentId, progress)
    this.rebuildLive(message.agentId)
  }

  removePendingMessage(agentId: string, messageId: string) {
    if (!this.messageProgress.get(agentId)?.delete(messageId)) return
    this.rebuildLive(agentId)
  }

  clearEphemeral() {
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

  resetForReconnect() {
    const agentIds = new Set([
      ...this.messageProgress.keys(),
      ...this.toolProgress.keys(),
      ...this.activity.keys(),
    ])
    for (const [agentId, progress] of this.messageProgress) {
      for (const [messageId, entry] of progress) {
        if (!entry.pending) progress.delete(messageId)
      }
      if (progress.size === 0) this.messageProgress.delete(agentId)
    }
    this.toolProgress.clear()
    this.activity.clear()
    for (const agentId of agentIds) this.rebuildLive(agentId)
  }

  closeOnTerminal(
    status: RunPublic["status"],
    refresh: () => Promise<unknown>
  ) {
    if (!terminalStatuses.has(status)) return false
    const close = () => {
      this.close()
      this.clearEphemeral()
    }
    void refresh().then(close, close)
    return true
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

  connect(
    runId: string,
    afterCursor: number,
    onEvent: (event: RunStreamEvent) => void,
    onDisconnectedChange: (disconnected: boolean) => void,
    onReconnect: () => void
  ) {
    this.close()
    const source = new EventSource(
      `/api/runs/${runId}/events?after=${encodeURIComponent(afterCursor)}`
    )
    this.source = source
    let opened = false
    source.onopen = () => {
      if (this.source !== source) return
      const reconnecting = opened
      opened = true
      onDisconnectedChange(false)
      if (reconnecting) onReconnect()
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
      const event = parseEvent(payload)
      if (!event) return
      this.applyEvent(event)
      onEvent(event)
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
