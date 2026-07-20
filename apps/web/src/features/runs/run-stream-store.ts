import type { RunStreamEvent, SessionEntry } from "@/lib/api"
import {
  isRecord,
  type LiveEntry,
  liveEntries,
  mergeLiveEntries,
  pruneLiveEntries,
  text,
} from "./timeline-model"

type Listener = () => void

const emptyEntries: LiveEntry[] = []

export class RunStreamStore {
  private readonly entries = new Map<string, LiveEntry[]>()
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
    return this.entries.get(agentId) ?? emptyEntries
  }

  clear() {
    this.entries.clear()
    for (const agentId of this.listeners.keys()) this.notify(agentId)
  }

  connect(
    runId: string,
    afterCursor: number,
    onEvent: (event: RunStreamEvent) => void,
    onConnectionChange: (connected: boolean) => void
  ) {
    this.close()
    this.clear()
    const source = new EventSource(
      `/api/runs/${runId}/events?after=${encodeURIComponent(afterCursor)}`
    )
    this.source = source
    source.onopen = () => {
      if (this.source !== source) return
      onConnectionChange(true)
    }
    source.onerror = () => {
      if (this.source !== source) return
      onConnectionChange(false)
    }
    source.onmessage = (message) => {
      if (this.source !== source) return
      let payload: unknown
      try {
        payload = JSON.parse(message.data)
      } catch {
        return
      }
      if (!isRecord(payload)) return
      const agentId = text(payload.agentId)
      const agentEvent = isRecord(payload.event) ? payload.event : null
      if (agentId && agentEvent) {
        this.add(agentId, liveEntries(agentEvent, text(payload.messageId)))
        onEvent({
          type: "agent_event",
          agentId,
          event: agentEvent,
          ...(text(payload.messageId)
            ? { messageId: text(payload.messageId) }
            : {}),
          ...(typeof payload.eventCursor === "number"
            ? { eventCursor: payload.eventCursor }
            : {}),
        })
      }
      if (payload.type === "status" || payload.type === "agent_status") {
        onEvent(payload as RunStreamEvent)
        return
      }
      if (payload.type === "ready") {
        onEvent(payload as RunStreamEvent)
      }
    }
    return () => this.close()
  }

  add(agentId: string, values: LiveEntry[]) {
    if (values.length === 0) return
    const next = mergeLiveEntries(this.get(agentId), values)
    this.entries.set(agentId, next)
    this.notify(agentId)
  }

  remove(agentId: string, key: string) {
    const current = this.get(agentId)
    const next = current.filter((entry) => entry.key !== key)
    if (next.length === current.length) return
    this.entries.set(agentId, next)
    this.notify(agentId)
  }

  prune(agentId: string, history: SessionEntry[]) {
    const current = this.get(agentId)
    const entries = pruneLiveEntries(history, current)
    if (entries.length === current.length) return
    this.entries.set(agentId, entries)
    this.notify(agentId)
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
