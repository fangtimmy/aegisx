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
  sessionId: string,
  key: string,
  seq: number,
  entry: Record<string, unknown>
): LiveEvent {
  return {
    type: "message.committed",
    agentId,
    sessionId,
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

function contextUpdatedEvent(agentId: string): LiveEvent {
  return {
    type: "context.updated",
    agentId,
    tokens: 1200,
    contextWindow: 200_000,
    percent: 0.6,
    cacheHitRate: null,
    totals: { input: 1200, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
  }
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
      committedEvent("a1", "s1", "draft", 2, {
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
    store.applyEvent(
      committedEvent("a1", "s1", "u1", 1, userItem("hello").entry)
    )
    store.applySnapshot("a1", [])
    expect(store.get("a1")).toHaveLength(1)
  })

  test("a duplicate or replayed commit at or below the session cursor is dropped", () => {
    const store = new ConversationStore()
    store.retain(["a1"])
    store.ingest(committedEvent("a1", "s1", "u1", 1, userItem("one").entry))
    store.ingest(committedEvent("a1", "s1", "u2", 2, userItem("two").entry))
    // Same seq, different key (a replayed/duplicated frame or a stale draft):
    // the seq-ordered merge rule drops it.
    store.ingest(
      committedEvent("a1", "s1", "u2-dup", 2, userItem("ghost").entry)
    )
    const items = store.get("a1")
    expect(items).toHaveLength(2)
    expect(items.some((i) => i.type === "user" && i.body === "ghost")).toBe(
      false
    )
  })

  test("cursors are per session: a new session's low seqs merge normally", () => {
    const store = new ConversationStore()
    store.retain(["a1"])
    store.ingest(
      committedEvent("a1", "s1", "u1", 5, userItem("old world", 5, "u1").entry)
    )
    expect(store.cursorOf("a1")).toBe(5)
    // Session switch: reset clears state AND the cursor, then the new
    // session's seq space restarts at 1 and merges without being dropped
    // against the OLD session's cursor.
    store.reset("a1")
    store.ingest(
      committedEvent("a1", "s2", "n1", 1, userItem("new world", 1, "n1").entry)
    )
    expect(store.get("a1")).toHaveLength(1)
    expect(store.cursorOf("a1")).toBe(1)
  })

  test("applySnapshot drops rows at or below the live cursor (catch-up merge)", () => {
    const store = new ConversationStore()
    store.retain(["a1"])
    store.ingest(
      committedEvent("a1", "s1", "u3", 3, userItem("three", 3, "u3").entry)
    )
    // A catch-up fetch (after=3) re-delivered rows 2..5: rows ≤ cursor are
    // already held, rows above merge.
    store.applySnapshot("a1", [
      userItem("two", 2, "u2"),
      userItem("four", 4, "u4"),
      userItem("five", 5, "u5"),
    ])
    const items = store.get("a1")
    expect(items.map((i) => (i.type === "user" ? i.body : null))).toEqual([
      "three",
      "four",
      "five",
    ])
  })

  test("reset clears the cursors so a post-backtrack full reload rebuilds state", () => {
    const store = new ConversationStore()
    store.retain(["a1"])
    store.ingest(
      committedEvent("a1", "s1", "u10", 10, userItem("ten", 10, "u10").entry)
    )
    expect(store.cursorOf("a1")).toBe(10)
    store.reset("a1")
    expect(store.cursorOf("a1")).toBe(0)
    // The backtrack world reuses seqs: the fresh commit must merge.
    store.applyEvent(
      committedEvent("a1", "s1", "u6", 6, userItem("six", 6, "u6").entry)
    )
    expect(store.get("a1")).toHaveLength(1)
  })

  test("a stale commit landing in the reset window does not survive the full-pull snapshot", () => {
    const store = new ConversationStore()
    store.retain(["a1"])
    store.ingest(
      committedEvent("a1", "s1", "u10", 10, userItem("ten", 10, "u10").entry)
    )
    // A session op (backtrack) resets the store...
    store.reset("a1")
    // ...but the pre-reset in-flight commit frame lands in the window,
    // poisoning the fresh cursor with the OLD session's seq.
    store.ingest(
      committedEvent("a1", "s1", "u10-ghost", 10, userItem("ghost", 10).entry)
    )
    expect(store.cursorOf("a1")).toBe(10)
    // The following full-pull snapshot (after=0) carries the surviving rows.
    // It REPLACES the stored rows and the poisoned cursor — a merge would
    // drop seq ≤ 10 (i.e. everything) and leave the ghost alone.
    store.applySnapshot("a1", [userItem("six", 6, "u6")], undefined, 0)
    const items = store.get("a1")
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ type: "user", body: "six" })
    // The cursor is the snapshot's head, not the stale seq: the next
    // incremental catch-up resumes from real state.
    expect(store.cursorOf("a1")).toBe(6)
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

  test("getAgent returns the stored reference until the next agent.updated", () => {
    const store = new ConversationStore()
    expect(store.getAgent("a1")).toBeNull()
    const agent = { id: "a1", role: "solver" } as AgentSummary
    store.applyEvent({ type: "agent.updated", agent })
    expect(store.getAgent("a1")).toBe(agent)
    const updated = { id: "a1", role: "orchestrator" } as AgentSummary
    store.applyEvent({ type: "agent.updated", agent: updated })
    expect(store.getAgent("a1")).toBe(updated)
  })

  test("interleaved events for two agents keep their state isolated", () => {
    const store = new ConversationStore()
    // Both agents are on screen (the multiplexed stream carries both).
    store.retain(["a1", "a2"])
    store.applySnapshot("a1", [userItem("ask one")])
    store.applySnapshot("a2", [userItem("ask two")])

    const draft = (text: string) => ({
      type: "message",
      id: "draft",
      timestamp: "2025-01-01T00:00:01Z",
      message: { role: "assistant", content: [{ type: "text", text }] },
    })
    store.ingest(progressEvent("a1", "draft", 1, draft("one…")))
    store.ingest(progressEvent("a2", "draft", 1, draft("two…")))
    store.ingest(toolEvent("a1", "tc-1", "running", 1))
    store.ingest(toolEvent("a2", "tc-2", "done", 2, { result: "two done" }))
    store.ingest(committedEvent("a1", "s1", "draft", 2, draft("one done")))
    store.ingest(contextUpdatedEvent("a1"))

    const agentA = store.get("a1")
    const agentB = store.get("a2")
    expect(agentA).toHaveLength(2)
    expect(agentB).toHaveLength(2)
    const bodyOf = (items: typeof agentA) =>
      items.flatMap((item) =>
        item.type === "user"
          ? [item.body]
          : item.type === "agent"
            ? item.blocks.flatMap((block) =>
                block.type === "text" ? [block.body] : []
              )
            : []
      )
    expect(bodyOf(agentA)).toEqual(["ask one", "one done"])
    expect(bodyOf(agentB)).toEqual(["ask two", "two…"])
    expect(store.getRunningTool("a1")).toMatchObject({ toolName: "bash" })
    expect(store.getRunningTool("a2")).toBeNull()
    expect(store.getContext("a1")).toMatchObject({ tokens: 1200 })
    expect(store.getContext("a2")).toBeNull()
  })

  test("ingest keeps bounded live state for every agent, messages only for retained ones", () => {
    const store = new ConversationStore()
    store.retain(["a1"])
    store.ingest(
      progressEvent("a2", "draft", 1, {
        type: "message",
        id: "draft",
        timestamp: "2025-01-01T00:00:01Z",
        message: { role: "assistant", content: [{ type: "text", text: "x" }] },
      })
    )
    store.ingest(committedEvent("a2", "s2", "draft", 2, userItem("late").entry))
    expect(store.get("a2")).toHaveLength(0)

    store.ingest(toolEvent("a2", "tc-2", "running", 1))
    store.ingest(contextUpdatedEvent("a2"))
    store.ingest(agentUpdatedEvent({ id: "a2", role: "solver" }))
    expect(store.getRunningTool("a2")).toMatchObject({ toolName: "bash" })
    expect(store.getContext("a2")).toMatchObject({ tokens: 1200 })
    expect(store.getAgent("a2")).not.toBeNull()
  })

  test("retain evicts other agents' durable history and keeps their live state", () => {
    const store = new ConversationStore()
    store.retain(["a1", "a2"])
    store.applySnapshot("a1", [userItem("one")])
    store.applySnapshot("a2", [userItem("two")])
    store.ingest(contextUpdatedEvent("a2"))

    store.retain(["a1"])
    expect(store.get("a1")).toHaveLength(1)
    expect(store.get("a2")).toHaveLength(0)
    expect(store.getContext("a2")).toMatchObject({ tokens: 1200 })

    // A commit for the evicted agent no longer lands; the REST snapshot when
    // it is selected again is the durable source.
    store.ingest(
      committedEvent("a2", "s2", "later", 9, userItem("later").entry)
    )
    expect(store.get("a2")).toHaveLength(0)
  })

  test("context.updated notifies only the event's own agent listeners", async () => {
    const store = new ConversationStore()
    let currentAgentNotifications = 0
    let otherAgentNotifications = 0
    const unsubscribeCurrent = store.subscribe("a1", () => {
      currentAgentNotifications += 1
    })
    const unsubscribeOther = store.subscribe("a2", () => {
      otherAgentNotifications += 1
    })
    store.applyEvent(contextUpdatedEvent("a1"))
    expect(store.getContext("a1")).toMatchObject({ tokens: 1200 })
    await flush()
    expect(currentAgentNotifications).toBeGreaterThan(0)
    expect(otherAgentNotifications).toBe(0)
    unsubscribeCurrent()
    unsubscribeOther()
  })
})
