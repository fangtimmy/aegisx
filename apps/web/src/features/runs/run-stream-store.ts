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
}

const emptyItems: ConversationItem[] = []

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined
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
        }
      : undefined
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

  private invalidate(agentId: string) {
    const messages = [...(this.messages.get(agentId)?.values() ?? [])].sort(
      (left, right) => left.sequence - right.sequence
    )
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
      })),
    ]
    this.snapshots.set(agentId, buildConversation(messages, live))
    this.notify(agentId)
  }

  applySnapshot(agentId: string, messages: ConversationMessage[]) {
    const stored = this.messages.get(agentId) ?? new Map()
    const committedIds = new Set<string>()
    const completedTools = new Set<string>()
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
    const progress = this.messageProgress.get(agentId)
    if (progress) {
      for (const messageId of committedIds) progress.delete(messageId)
    }
    const tools = this.toolProgress.get(agentId)
    if (tools) {
      for (const toolCallId of completedTools) tools.delete(toolCallId)
    }
    this.invalidate(agentId)
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
        this.toolProgress
          .get(event.agentId)
          ?.delete(event.message.message.toolCallId)
      }
      this.invalidate(event.agentId)
      return
    }
    if (event.type === "message.progress") {
      if (this.messages.get(event.agentId)?.has(event.messageId)) return
      const progress = this.messageProgress.get(event.agentId) ?? new Map()
      const existing = progress.get(event.messageId)
      if (!existing || event.revision > existing.revision) {
        progress.set(event.messageId, { ...event, pending: false })
        this.messageProgress.set(event.agentId, progress)
        this.invalidate(event.agentId)
      }
      return
    }
    if (event.type === "tool.progress") {
      const hasResult = [
        ...(this.messages.get(event.agentId)?.values() ?? []),
      ].some(
        (message) =>
          message.message.role === "toolResult" &&
          message.message.toolCallId === event.toolCallId
      )
      if (hasResult) return
      const tools = this.toolProgress.get(event.agentId) ?? new Map()
      const existing = tools.get(event.toolCallId)
      if (!existing || event.revision > existing.revision) {
        tools.set(event.toolCallId, {
          ...event,
          isError: event.isError === true,
        })
        this.toolProgress.set(event.agentId, tools)
        this.invalidate(event.agentId)
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
    this.invalidate(message.agentId)
  }

  removePendingMessage(agentId: string, messageId: string) {
    if (!this.messageProgress.get(agentId)?.delete(messageId)) return
    this.invalidate(agentId)
  }

  clearEphemeral() {
    const agentIds = new Set([
      ...this.messageProgress.keys(),
      ...this.toolProgress.keys(),
    ])
    this.messageProgress.clear()
    this.toolProgress.clear()
    for (const agentId of agentIds) this.invalidate(agentId)
  }

  resetForReconnect() {
    const agentIds = new Set([
      ...this.messageProgress.keys(),
      ...this.toolProgress.keys(),
    ])
    for (const [agentId, progress] of this.messageProgress) {
      for (const [messageId, entry] of progress) {
        if (!entry.pending) progress.delete(messageId)
      }
      if (progress.size === 0) this.messageProgress.delete(agentId)
    }
    this.toolProgress.clear()
    for (const agentId of agentIds) this.invalidate(agentId)
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
