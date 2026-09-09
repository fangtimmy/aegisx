import { describe, expect, test } from "bun:test"

import type { AgentSummary, EntryItem, LiveEvent } from "@/api"
import { ConversationStore } from "@/stream/conversation-store"

// The store batches listener notifications on requestAnimationFrame; the test
// env has no DOM, so drive it with a macrotask (mirrors the rAF timing).
;(globalThis as { window?: unknown }).window ??= {
  requestAnimationFrame: (cb: () => void) =>
    setTimeout(cb, 0) as unknown as number,
  cancelAnimationFrame: (id: unknown) => clearTimeout(id as number),
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 5))

function item(
  seq: number,
  key: string,
  entry: Record<string, unknown>
): EntryItem {
  return { seq, key, entry: entry as EntryItem["entry"] }
}

function userItem(text: string, seq = 1, key = `u${seq}`): EntryItem {
  return item(seq, key, {
    type: "message",
    id: key,
    timestamp: "2025-01-01T00:00:00Z",
    message: { role: "user", content: [{ type: "text", text }] },
  })
}

function assistantText(text: string, seq = 2, key = `a${seq}`): EntryItem {
  return item(seq, key, {
    type: "message",
    id: key,
    timestamp: "2025-01-01T00:00:01Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason: "done",
    },
  })
}

function assistantToolCall(
  id: string,
  name: string,
  seq = 3,
  key = `a${seq}`
): EntryItem {
  return item(seq, key, {
    type: "message",
    id: key,
    timestamp: "2025-01-01T00:00:02Z",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id, name, arguments: { command: "ls" } }],
      stopReason: "toolCall",
    },
  })
}

function progressEvent(
  agentId: string,
  key: string,
  revision: number,
  entry: Record<string, unknown>
): LiveEvent {
  return {
    type: "message.progress",
    agentId,
    key,
    revision,
    entry: entry as EntryItem["entry"],
  }
}

function committedEvent(
  agentId: string,
  key: string,
  seq: number,
  entry: Record<string, unknown>
): LiveEvent {
  return {
    type: "message.committed",
    agentId,
    item: {
      key,
      seq,
      entry: entry as EntryItem["entry"],
    },
  }
}

function toolEvent(
  agentId: string,
  toolCallId: string,
  status: "running" | "done" | "error",
  revision: number,
  extra: Record<string, unknown> = {}
): LiveEvent {
  return {
    type: "tool.progress",
    agentId,
    toolCallId,
    toolName: "bash",
    revision,
    status,
    ...extra,
  }
}

function agentUpdatedEvent(agent: Partial<AgentSummary>): LiveEvent {
  return { type: "agent.updated", agent: agent as AgentSummary }
}

describe("ConversationStore", () => {
  test("applySnapshot renders the committed conversation", () => {
    const store = new ConversationStore()
    store.applySnapshot("a1", [userItem("hello"), assistantText("hi there")])
    const items = store.get("a1")
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ type: "user", body: "hello" })
    expect(items[1]!.type).toBe("agent")
  })

  test("message.progress drafts stream in; message.committed replaces without duplication", () => {
    const store = new ConversationStore()
    store.applySnapshot("a1", [userItem("go")])
    store.applyEvent(
      progressEvent("a1", "draft", 1, {
        type: "message",
        id: "draft",
        timestamp: "2025-01-01T00:00:01Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "working…" }],
        },
      })
    )
    const streamed = store.get("a1")
    expect(streamed).toHaveLength(2)
    expect(streamed[1]!.type).toBe("agent")

    store.applyEvent(
      committedEvent("a1", "draft", 2, {
        type: "message",
        id: "draft",
        timestamp: "2025-01-01T00:00:01Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "working…" }],
        },
      })
    )
    const committed = store.get("a1")
    expect(committed).toHaveLength(2)
    expect(committed[1]!.type).toBe("agent")
  })

  test("tool.progress running → done merges into the committed tool block", () => {
    const store = new ConversationStore()
    store.applySnapshot("a1", [
      userItem("run"),
      assistantToolCall("tc-1", "bash"),
    ])
    store.applyEvent(toolEvent("a1", "tc-1", "running", 1))
    const running = store.get("a1")
    const runningBlock =
      running[1]!.type === "agent" ? running[1]!.blocks[0] : null
    expect(runningBlock).toMatchObject({ type: "tool", status: "running" })

    store.applyEvent(
      toolEvent("a1", "tc-1", "done", 2, { result: "exploit.py" })
    )
    const done = store.get("a1")
    const doneBlock = done[1]!.type === "agent" ? done[1]!.blocks[0] : null
    expect(doneBlock).toMatchObject({
      type: "tool",
      status: "done",
      output: "exploit.py",
    })
  })

  test("older message revisions are ignored", () => {
    const store = new ConversationStore()
    const entry = () => ({
      type: "message",
      id: "m1",
      timestamp: "2025-01-01T00:00:00Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "v2" }],
      },
    })
    store.applyEvent(progressEvent("a1", "m1", 2, entry()))
    store.applyEvent(progressEvent("a1", "m1", 1, entry()))
    const items = store.get("a1")
    const block = items[0]!.type === "agent" ? items[0]!.blocks[0] : null
    expect(block).toMatchObject({ type: "text", body: "v2" })
  })

  test("resetForReconnect keeps committed history but drops live state", async () => {
    const store = new ConversationStore()
    store.applySnapshot("a1", [userItem("keep me"), assistantText("done")])
    store.applyEvent(
      progressEvent("a1", "draft", 1, {
        type: "message",
        id: "draft",
        timestamp: "2025-01-01T00:00:02Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "draft" }],
        },
      })
    )
    store.applyEvent(toolEvent("a1", "tc-9", "running", 1))
    store.applyEvent({
      type: "agent.activity",
      agentId: "a1",
      activity: "retrying",
    })
    expect(store.getActivity("a1")).not.toBeNull()
    expect(store.getRunningTool("a1")).not.toBeNull()

    store.resetForReconnect()
    expect(store.get("a1")).toHaveLength(2)
    expect(store.getActivity("a1")).toBeNull()
    expect(store.getRunningTool("a1")).toBeNull()
    await flush()
  })

  test("reset clears the agent view entirely", () => {
    const store = new ConversationStore()
    store.applySnapshot("a1", [userItem("x"), assistantText("y")])
    expect(store.get("a1")).toHaveLength(2)
    store.reset("a1")
    expect(store.get("a1")).toHaveLength(0)
  })

  test("message.committed before the first snapshot is kept by it", () => {
    const store = new ConversationStore()
    store.applyEvent({
      type: "message.committed",
      agentId: "a1",
      item: userItem("hello", 1, "u1"),
    })
    store.applySnapshot("a1", [])
    expect(store.get("a1")).toHaveLength(1)
  })

  test("message.committed landing in the reset window is still dropped", () => {
    const store = new ConversationStore()
    store.applySnapshot("a1", [userItem("old", 1, "u1")])
    store.reset("a1")
    store.applyEvent({
      type: "message.committed",
      agentId: "a1",
      item: userItem("ghost", 2, "u2"),
    })
    store.applySnapshot("a1", [])
    expect(store.get("a1")).toHaveLength(0)
  })

  test("agent.updated updates store state and notifies listeners", async () => {
    const store = new ConversationStore()
    let notified = 0
    const unsubscribe = store.subscribe("a1", () => {
      notified += 1
    })
    store.applyEvent(agentUpdatedEvent({ id: "a1", role: "solver" }))
    expect(store.getAgents()).toHaveLength(1)
    await flush()
    expect(notified).toBeGreaterThan(0)
    unsubscribe()
  })
})
