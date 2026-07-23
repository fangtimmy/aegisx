import type { LiveEvent, Message, RunPublic } from "@/api"
import {
  buildConversation,
  type ConversationItem,
  type LiveEntry,
} from "@/domain/conversation"
import { parseLiveEvent } from "./parse-event"

type Listener = () => void

type MessageProgress = {
  agentId: string
  messageId: string
  revision: number
  message: Message
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
  tail: Message[]
}

const emptyItems: ConversationItem[] = []
const terminalStatuses = new Set<RunPublic["status"]>([
  "completed",
  "failed",
  "stopped",
])

function isUserLike(message: Message) {
  return message.role === "user" || message.role === "notice"
}

export class ConversationStore {
  private readonly messages = new Map<string, Map<string, Message>>()
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
      (left, right) => left.seq - right.seq
    )
    let boundary = -1
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index] && isUserLike(messages[index])) {
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

  applySnapshot(agentId: string, messages: Message[]) {
    const stored = this.messages.get(agentId) ?? new Map()
    const committedIds = new Set<string>()
    const completedTools = this.completedTools.get(agentId) ?? new Set<string>()
    for (const message of messages) {
      stored.set(message.id, message)
      committedIds.add(message.id)
      if (message.role === "toolResult") {
        completedTools.add(message.toolCallId)
        committedIds.add(`tool:${message.toolCallId}`)
      }
    }
    this.messages.set(agentId, stored)
    this.completedTools.set(agentId, completedTools)
    const progress = this.messageProgress.get(agentId)
    if (progress) {
      for (const messageId of committedIds) progress.delete(messageId)
      if (progress.size === 0) this.messageProgress.delete(agentId)
    }
    const tools = this.toolProgress.get(agentId)
    if (tools) {
      for (const toolCallId of completedTools) tools.delete(toolCallId)
      if (tools.size === 0) this.toolProgress.delete(agentId)
    }
    this.rebuildCommitted(agentId)
  }

  applyEvent(event: LiveEvent) {
    if (event.type === "ready") return
    if (event.type === "message.committed") {
      const stored = this.messages.get(event.agentId) ?? new Map()
      stored.set(event.message.id, event.message)
      this.messages.set(event.agentId, stored)
      const progress = this.messageProgress.get(event.agentId)
      if (progress) {
        progress.delete(event.message.id)
        // Legacy / defensive: progress may have used tool:<callId> while commit used a UUID.
        if (event.message.role === "toolResult") {
          progress.delete(`tool:${event.message.toolCallId}`)
        }
        if (progress.size === 0) this.messageProgress.delete(event.agentId)
      }
      if (event.message.role === "toolResult") {
        const completedTools =
          this.completedTools.get(event.agentId) ?? new Set<string>()
        completedTools.add(event.message.toolCallId)
        this.completedTools.set(event.agentId, completedTools)
        this.toolProgress.get(event.agentId)?.delete(event.message.toolCallId)
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

  addPendingMessage(message: Message) {
    const progress = this.messageProgress.get(message.agentId) ?? new Map()
    progress.set(message.id, {
      agentId: message.agentId,
      messageId: message.id,
      revision: 0,
      message,
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

  /** Drop all conversation state (e.g. when switching runs). */
  reset() {
    this.close()
    const agentIds = new Set([
      ...this.messages.keys(),
      ...this.messageProgress.keys(),
      ...this.toolProgress.keys(),
      ...this.activity.keys(),
      ...this.views.keys(),
      ...this.snapshots.keys(),
      ...this.listeners.keys(),
    ])
    this.messages.clear()
    this.messageProgress.clear()
    this.toolProgress.clear()
    this.completedTools.clear()
    this.activity.clear()
    this.views.clear()
    this.snapshots.clear()
    for (const agentId of agentIds) this.notify(agentId)
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
    onEvent: (event: LiveEvent) => void,
    onDisconnectedChange: (disconnected: boolean) => void,
    onReconnect: () => void
  ) {
    this.close()
    const source = new EventSource(`/api/runs/${runId}/stream`)
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
      const event = parseLiveEvent(payload)
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
