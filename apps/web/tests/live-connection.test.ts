import { describe, expect, test } from "bun:test"

import type { LiveEvent } from "@/api"
import { createLiveConnection } from "@/stream/live-connection"

/** Stand-in for the browser's EventSource: records listeners and lets the test
 * drive open/error/message frames. */
class FakeEventSource {
  readonly listeners = new Map<string, Set<(event: unknown) => void>>()
  closed = false

  constructor(readonly url: string) {}

  addEventListener(type: string, handler: (event: unknown) => void) {
    const set = this.listeners.get(type) ?? new Set()
    set.add(handler)
    this.listeners.set(type, set)
  }

  emit(type: string, event: unknown = {}) {
    for (const handler of this.listeners.get(type) ?? []) handler(event)
  }

  /** Push one parsed wire frame (the server always sends JSON). */
  frame(payload: unknown) {
    this.emit("message", { data: JSON.stringify(payload) })
  }

  raw(data: string) {
    this.emit("message", { data })
  }

  close() {
    this.closed = true
  }
}

function makeConnection() {
  const sources: FakeEventSource[] = []
  const connection = createLiveConnection("/api/stream", (url) => {
    const source = new FakeEventSource(url)
    sources.push(source)
    return source as unknown as EventSource
  })
  return { connection, sources }
}

function activity(agentId: string): LiveEvent {
  return { type: "agent.activity", agentId, activity: "retrying" }
}

function progress(agentId: string, key: string, text: string): LiveEvent {
  return {
    type: "message.progress",
    agentId,
    key,
    revision: 1,
    entry: {
      type: "message",
      id: key,
      timestamp: "2025-01-01T00:00:00Z",
      message: { role: "assistant", content: [{ type: "text", text }] },
    },
  }
}

describe("createLiveConnection", () => {
  test("one EventSource serves every subscriber", () => {
    const { connection, sources } = makeConnection()
    const seen: LiveEvent[] = []
    const first = connection.subscribe((event) => seen.push(event))
    const second = connection.subscribe(() => {})
    expect(sources).toHaveLength(1)

    sources[0]!.frame(activity("a1"))
    expect(seen).toHaveLength(1)

    first()
    second()
    expect(sources[0]!.closed).toBe(true)
  })

  test("interleaved frames for several agents ride the one connection", () => {
    const { connection, sources } = makeConnection()
    const seen: LiveEvent[] = []
    connection.subscribe((event) => seen.push(event))
    const source = sources[0]!
    source.emit("open")

    source.frame(progress("a1", "d1", "draft one"))
    source.frame(progress("a2", "d2", "draft two"))
    source.frame(activity("a1"))
    source.frame(activity("a2"))

    expect(
      seen.map((event) =>
        event.type === "message.progress"
          ? `${event.agentId}:${event.key}`
          : event.type
      )
    ).toEqual(["a1:d1", "a2:d2", "agent.activity", "agent.activity"])
  })

  test("malformed payloads are dropped, not delivered", () => {
    const { connection, sources } = makeConnection()
    const seen: LiveEvent[] = []
    connection.subscribe((event) => seen.push(event))

    sources[0]!.raw("{not json")
    sources[0]!.frame({ type: "wat" })
    sources[0]!.frame({ type: "agent.activity" })
    expect(seen).toHaveLength(0)

    sources[0]!.frame(activity("a1"))
    expect(seen).toHaveLength(1)
  })

  test("status and reconnect report the drop and the successful re-open", () => {
    const { connection, sources } = makeConnection()
    const statuses: boolean[] = []
    let reconnects = 0
    connection.subscribe(() => {})
    connection.onStatus((disconnected) => statuses.push(disconnected))
    connection.onReconnect(() => {
      reconnects += 1
    })
    const source = sources[0]!

    source.emit("open")
    expect(statuses).toEqual([false])
    expect(reconnects).toBe(0)

    source.emit("error")
    expect(statuses).toEqual([false, true])

    source.emit("open")
    expect(statuses).toEqual([false, true, false])
    expect(reconnects).toBe(1)
  })

  test("a later subscriber re-opens a closed connection on a fresh source", () => {
    const { connection, sources } = makeConnection()
    const unsubscribe = connection.subscribe(() => {})
    unsubscribe()
    expect(sources).toHaveLength(1)

    connection.subscribe(() => {})
    expect(sources).toHaveLength(2)
    expect(sources[1]!.closed).toBe(false)
  })

  test("a stale source's frames are ignored after it was replaced", () => {
    const { connection, sources } = makeConnection()
    const seen: LiveEvent[] = []
    const unsubscribe = connection.subscribe((event) => seen.push(event))
    unsubscribe()
    connection.subscribe((event) => seen.push(event))

    sources[0]!.frame(activity("a1"))
    sources[1]!.frame(activity("a2"))
    expect(seen.map((event) => event.agentId)).toEqual(["a2"])
  })
})
