import { describe, expect, test } from "bun:test"

import { parseLiveEvent } from "@/stream/parse-event"

function validMessageEntry(overrides: Record<string, unknown> = {}) {
  return {
    type: "message",
    id: "m1",
    timestamp: "2025-01-01T00:00:00Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
    },
    ...overrides,
  }
}

describe("parseLiveEvent", () => {
  test("ready requires agentId", () => {
    expect(parseLiveEvent({ type: "ready", agentId: "a1" })).toEqual({
      type: "ready",
      agentId: "a1",
    })
    expect(parseLiveEvent({ type: "ready" })).toBeUndefined()
  })

  test("channel.message passes the payload through", () => {
    const message = { id: 7, body: "hi" }
    expect(parseLiveEvent({ type: "channel.message", message })).toEqual({
      type: "channel.message",
      message,
    })
  })

  test("agent.updated requires a record payload", () => {
    const agent = { id: "a1", status: "running" }
    expect(parseLiveEvent({ type: "agent.updated", agent })).toEqual({
      type: "agent.updated",
      agent,
    })
    expect(
      parseLiveEvent({ type: "agent.updated", agent: "nope" })
    ).toBeUndefined()
    expect(parseLiveEvent({ type: "agent.updated" })).toBeUndefined()
  })

  test("message.progress requires a valid session entry", () => {
    expect(
      parseLiveEvent({
        type: "message.progress",
        agentId: "a1",
        key: "msg:1",
        revision: 3,
        entry: validMessageEntry(),
      })
    ).toMatchObject({ type: "message.progress", revision: 3 })
    expect(
      parseLiveEvent({
        type: "message.progress",
        agentId: "a1",
        key: "msg:1",
        revision: 3,
        entry: { type: "message" }, // no id/timestamp
      })
    ).toBeUndefined()
    expect(
      parseLiveEvent({
        type: "message.progress",
        agentId: "a1",
        revision: -1,
        entry: validMessageEntry(),
      })
    ).toBeUndefined()
  })

  test("tool.progress accepts running/done/error + terminal", () => {
    const base = {
      type: "tool.progress",
      agentId: "a1",
      toolCallId: "tc-1",
      toolName: "bash",
      revision: 1,
    }
    expect(parseLiveEvent({ ...base, status: "running" })).toMatchObject({
      status: "running",
    })
    expect(
      parseLiveEvent({
        ...base,
        status: "error",
        terminal: "timed_out",
        terminalMessage: "killed",
      })
    ).toMatchObject({ status: "error", terminal: "timed_out" })
    expect(parseLiveEvent({ ...base, status: "bogus" })).toBeUndefined()
  })

  test("agent.activity null clears; other values must be transient", () => {
    expect(
      parseLiveEvent({ type: "agent.activity", agentId: "a1", activity: null })
    ).toEqual({ type: "agent.activity", agentId: "a1", activity: null })
    expect(
      parseLiveEvent({
        type: "agent.activity",
        agentId: "a1",
        activity: "retrying",
        attempt: 2,
        maxAttempts: 3,
      })
    ).toMatchObject({ activity: "retrying", attempt: 2 })
    expect(
      parseLiveEvent({ type: "agent.activity", agentId: "a1", activity: "x" })
    ).toBeUndefined()
  })

  test("context.updated coerces missing totals to zero", () => {
    const event = parseLiveEvent({
      type: "context.updated",
      agentId: "a1",
      tokens: 100,
      totals: {},
    })
    expect(event).toMatchObject({
      type: "context.updated",
      tokens: 100,
      totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    })
  })

  test("queue.updated keeps only string steering/followUp entries", () => {
    expect(
      parseLiveEvent({
        type: "queue.updated",
        agentId: "a1",
        steering: ["a", 1, null, "b"],
        followUp: [],
      })
    ).toEqual({
      type: "queue.updated",
      agentId: "a1",
      steering: ["a", "b"],
      followUp: [],
    })
  })

  test("message.committed keeps timing meta when present", () => {
    const event = parseLiveEvent({
      type: "message.committed",
      agentId: "a1",
      item: {
        key: "msg:1",
        seq: 9,
        entry: validMessageEntry(),
        meta: { durationMs: 12 },
      },
    })
    expect(event).toMatchObject({
      type: "message.committed",
      item: { seq: 9, key: "msg:1", meta: { durationMs: 12 } },
    })
  })

  test("unknown types and non-objects are rejected", () => {
    expect(parseLiveEvent({ type: "wat" })).toBeUndefined()
    expect(parseLiveEvent(null)).toBeUndefined()
    expect(parseLiveEvent("ready")).toBeUndefined()
    expect(parseLiveEvent([1, 2])).toBeUndefined()
  })
})
