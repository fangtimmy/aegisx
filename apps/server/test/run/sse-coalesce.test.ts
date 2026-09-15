import { describe, expect, test } from "bun:test"

import type { LiveEvent } from "@aegisx/shared/live-event"

import { createProgressCoalescer } from "../../src/run/sse"
import { refine } from "../support"

function mp(key: string, revision: number, agentId = "agent-1"): LiveEvent {
  return refine<LiveEvent>({
    type: "message.progress",
    agentId,
    key,
    revision,
    entry: { type: "message" },
  })
}

function tp(
  toolCallId: string,
  revision: number,
  agentId = "agent-1"
): LiveEvent {
  return refine<LiveEvent>({
    type: "tool.progress",
    agentId,
    toolCallId,
    revision,
    toolName: "bash",
    status: "running",
  })
}

function committed(seq: number): LiveEvent {
  return refine<LiveEvent>({
    type: "message.committed",
    agentId: "agent-1",
    sessionId: "sess-1",
    item: { seq },
  })
}

function activity(name: string | null): LiveEvent {
  return refine<LiveEvent>({
    type: "agent.activity",
    agentId: "agent-1",
    activity: name,
  })
}

/** Compact outline of a drained batch: progress frames as kind:key#revision,
 * everything else by type. */
function outline(events: LiveEvent[]): string[] {
  return events.map((event) => {
    if (event.type === "message.progress")
      return `mp:${event.key}#${event.revision}`
    if (event.type === "tool.progress")
      return `tp:${event.toolCallId}#${event.revision}`
    return event.type
  })
}

describe("createProgressCoalescer", () => {
  test("non-progress events pass through in order", () => {
    const coalescer = createProgressCoalescer()
    coalescer.push(committed(1))
    coalescer.push(activity("retrying"))
    coalescer.push(committed(2))
    coalescer.push(activity(null))
    expect(outline(coalescer.drain())).toEqual([
      "message.committed",
      "agent.activity",
      "message.committed",
      "agent.activity",
    ])
  })

  test("message.progress collapses to the highest revision per key", () => {
    const coalescer = createProgressCoalescer()
    coalescer.push(mp("m1", 1))
    coalescer.push(mp("m1", 2))
    coalescer.push(mp("m1", 5))
    coalescer.push(mp("m1", 3)) // late lower revision is ignored
    const drained = coalescer.drain()
    expect(outline(drained)).toEqual(["mp:m1#5"])
  })

  test("distinct message keys and tool call ids never merge", () => {
    const coalescer = createProgressCoalescer()
    coalescer.push(mp("m1", 1))
    coalescer.push(mp("m2", 2))
    coalescer.push(tp("t1", 3))
    coalescer.push(tp("t2", 4))
    expect(outline(coalescer.drain())).toEqual([
      "mp:m1#1",
      "mp:m2#2",
      "tp:t1#3",
      "tp:t2#4",
    ])
  })

  test("tool.progress collapses per toolCallId; terminal supersedes running", () => {
    const coalescer = createProgressCoalescer()
    coalescer.push(tp("t1", 1))
    coalescer.push(tp("t1", 2))
    const done = refine<LiveEvent>({
      type: "tool.progress",
      agentId: "agent-1",
      toolCallId: "t1",
      revision: 3,
      toolName: "bash",
      status: "done",
    })
    coalescer.push(done)
    coalescer.push(committed(1))
    expect(outline(coalescer.drain())).toEqual(["tp:t1#3", "message.committed"])
  })

  test("a replacement keeps the first arrival's slot relative to other frames", () => {
    const coalescer = createProgressCoalescer()
    coalescer.push(mp("m1", 1))
    coalescer.push(committed(1))
    coalescer.push(mp("m1", 2))
    coalescer.push(mp("m2", 3))
    expect(outline(coalescer.drain())).toEqual([
      "mp:m1#2",
      "message.committed",
      "mp:m2#3",
    ])
  })

  test("the same key on a different agent is a separate identity", () => {
    const coalescer = createProgressCoalescer()
    coalescer.push(mp("m1", 1, "agent-1"))
    coalescer.push(mp("m1", 2, "agent-2"))
    coalescer.push(tp("t1", 3, "agent-1"))
    coalescer.push(tp("t1", 4, "agent-2"))
    expect(outline(coalescer.drain())).toEqual([
      "mp:m1#1",
      "mp:m1#2",
      "tp:t1#3",
      "tp:t1#4",
    ])
  })

  test("equal revisions dedupe (seed replay of the latest live frame)", () => {
    const coalescer = createProgressCoalescer()
    coalescer.push(tp("t1", 7))
    coalescer.push(tp("t1", 7))
    expect(outline(coalescer.drain())).toEqual(["tp:t1#7"])
  })

  test("drain resets the buffer — slots do not leak across batches", () => {
    const coalescer = createProgressCoalescer()
    coalescer.push(mp("m1", 5))
    expect(coalescer.size).toBe(1)
    expect(outline(coalescer.drain())).toEqual(["mp:m1#5"])

    // A post-drain lower revision must be kept, not compared against the
    // already-flushed frame.
    coalescer.push(mp("m1", 1))
    expect(coalescer.size).toBe(1)
    expect(outline(coalescer.drain())).toEqual(["mp:m1#1"])
    expect(coalescer.size).toBe(0)
  })

  test("seed then live interleaving: seed frames survive, progress supersede", () => {
    const coalescer = createProgressCoalescer()
    // Seed (subscribe happened before, snapshot replay).
    coalescer.push(committed(9))
    coalescer.push(tp("t1", 4)) // in-flight tool replay
    coalescer.push(activity("compacting"))
    // Live.
    coalescer.push(mp("m1", 1))
    coalescer.push(tp("t1", 5))
    coalescer.push(mp("m1", 2))
    expect(outline(coalescer.drain())).toEqual([
      "message.committed",
      "tp:t1#5",
      "agent.activity",
      "mp:m1#2",
    ])
  })
})
