import assert from "node:assert/strict"
import test from "node:test"
import type { Message } from "@/api"
import { ConversationStore } from "@/stream/conversation-store"

const fakeWindow = {
  requestAnimationFrame(callback: FrameRequestCallback) {
    callback(0)
    return 1
  },
  cancelAnimationFrame() {},
}

Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: fakeWindow,
})

function user(
  id: string,
  seq: number,
  text: string,
  agentId = "agent-1"
): Message {
  return {
    role: "user",
    id,
    agentId,
    seq,
    createdAt: new Date(seq * 1000).toISOString(),
    source: "user",
    content: [{ type: "text", text }],
  }
}

function assistant(
  id: string,
  seq: number,
  text: string,
  agentId = "agent-1"
): Message {
  return {
    role: "assistant",
    id,
    agentId,
    seq,
    createdAt: new Date(seq * 1000).toISOString(),
    content: [{ type: "text", text }],
  }
}

test("isolates conversation snapshots by agent", () => {
  const store = new ConversationStore()
  store.applySnapshot("main", [user("m1", 1, "main task", "main")])
  store.applySnapshot("child", [assistant("c1", 1, "child answer", "child")])

  const main = store.get("main")
  const child = store.get("child")
  assert.equal(main[0]?.type, "user")
  assert.equal(child[0]?.type, "agent")
  if (main[0]?.type === "user") assert.equal(main[0].body, "main task")
  if (child[0]?.type === "agent") {
    assert.equal(child[0].blocks[0]?.type, "text")
  }
})

test("pending user message is removed after failure cleanup", () => {
  const store = new ConversationStore()
  store.addPendingMessage(user("pending-1", 99, "hello"))
  assert.equal(store.get("agent-1").length, 1)
  store.removePendingMessage("agent-1", "pending-1")
  assert.equal(store.get("agent-1").length, 0)
})

test("resetForReconnect keeps pending messages and drops live progress", () => {
  const store = new ConversationStore()
  store.addPendingMessage(user("pending-1", 99, "still sending"))
  store.applyEvent({
    type: "message.progress",
    agentId: "agent-1",
    messageId: "assistant-1",
    revision: 1,
    message: assistant("assistant-1", 0, "ephemeral"),
  })
  store.applyEvent({
    type: "agent.activity",
    agentId: "agent-1",
    activity: "retrying",
  })
  assert.ok(store.getActivity("agent-1"))

  store.resetForReconnect()
  const items = store.get("agent-1")
  assert.equal(items.length, 1)
  assert.equal(items[0]?.type, "user")
  assert.equal(store.getActivity("agent-1"), null)
})

test("running tool lookup prefers the latest running entry", () => {
  const store = new ConversationStore()
  store.applyEvent({
    type: "tool.progress",
    agentId: "agent-1",
    toolCallId: "t1",
    revision: 1,
    toolName: "bash",
    args: { command: "first" },
    status: "done",
  })
  store.applyEvent({
    type: "tool.progress",
    agentId: "agent-1",
    toolCallId: "t2",
    revision: 1,
    toolName: "read",
    args: { path: "flag.txt" },
    status: "running",
  })
  assert.deepEqual(store.getRunningTool("agent-1"), {
    toolName: "read",
    args: { path: "flag.txt" },
  })
})

test("message.committed replaces progress when ids match", () => {
  const store = new ConversationStore()
  store.applySnapshot("agent-1", [user("u1", 1, "hi")])
  store.applyEvent({
    type: "message.progress",
    agentId: "agent-1",
    messageId: "a1",
    revision: 1,
    message: assistant("a1", 0, "partial"),
  })
  store.applyEvent({
    type: "message.progress",
    agentId: "agent-1",
    messageId: "a1",
    revision: 2,
    message: assistant("a1", 0, "partial more"),
  })
  assert.equal(store.get("agent-1").length, 2)

  store.applyEvent({
    type: "message.committed",
    agentId: "agent-1",
    message: assistant("a1", 2, "final answer"),
  })
  const items = store.get("agent-1")
  assert.equal(items.length, 2)
  assert.equal(items[0]?.type, "user")
  assert.equal(items[1]?.type, "agent")
  if (items[1]?.type === "agent") {
    assert.equal(items[1].blocks[0]?.type, "text")
    if (items[1].blocks[0]?.type === "text") {
      assert.equal(items[1].blocks[0].body, "final answer")
    }
  }
})

test("committed user clears pending when clientMessageId differs from server id", () => {
  const store = new ConversationStore()
  store.addPendingMessage({
    role: "user",
    id: "client-1",
    agentId: "agent-1",
    seq: 99,
    createdAt: new Date(99_000).toISOString(),
    source: "user",
    clientMessageId: "client-1",
    content: [{ type: "text", text: "hello" }],
  })
  assert.equal(store.get("agent-1").length, 1)

  store.applyEvent({
    type: "message.committed",
    agentId: "agent-1",
    message: {
      role: "user",
      id: "server-1",
      agentId: "agent-1",
      seq: 1,
      createdAt: new Date(1000).toISOString(),
      source: "user",
      clientMessageId: "client-1",
      content: [{ type: "text", text: "hello" }],
    },
  })

  const items = store.get("agent-1")
  assert.equal(items.length, 1)
  assert.equal(items[0]?.type, "user")
  if (items[0]?.type === "user") assert.equal(items[0].body, "hello")
})

test("snapshot clears pending by clientMessageId", () => {
  const store = new ConversationStore()
  store.addPendingMessage({
    role: "user",
    id: "client-2",
    agentId: "agent-1",
    seq: 99,
    createdAt: new Date(99_000).toISOString(),
    source: "user",
    clientMessageId: "client-2",
    content: [{ type: "text", text: "ping" }],
  })

  store.applySnapshot("agent-1", [
    {
      role: "user",
      id: "server-2",
      agentId: "agent-1",
      seq: 1,
      createdAt: new Date(1000).toISOString(),
      source: "user",
      clientMessageId: "client-2",
      content: [{ type: "text", text: "ping" }],
    },
  ])

  const items = store.get("agent-1")
  assert.equal(items.length, 1)
  assert.equal(items[0]?.type, "user")
})

test("committed toolResult clears tool: progress key and tool progress", () => {
  const store = new ConversationStore()
  store.applyEvent({
    type: "message.progress",
    agentId: "agent-1",
    messageId: "tool:call-1",
    revision: 1,
    message: {
      role: "toolResult",
      id: "tool:call-1",
      agentId: "agent-1",
      seq: 0,
      createdAt: new Date().toISOString(),
      toolCallId: "call-1",
      toolName: "bash",
      content: [{ type: "text", text: "partial out" }],
    },
  })
  store.applyEvent({
    type: "tool.progress",
    agentId: "agent-1",
    toolCallId: "call-1",
    revision: 1,
    toolName: "bash",
    args: { command: "echo hi" },
    status: "running",
  })
  assert.ok(store.getRunningTool("agent-1"))

  store.applyEvent({
    type: "message.committed",
    agentId: "agent-1",
    message: {
      role: "toolResult",
      id: "tool:call-1",
      agentId: "agent-1",
      seq: 1,
      createdAt: new Date().toISOString(),
      toolCallId: "call-1",
      toolName: "bash",
      content: [{ type: "text", text: "final out" }],
    },
  })
  assert.equal(store.getRunningTool("agent-1"), null)
  const items = store.get("agent-1")
  assert.equal(items.length, 1)
  assert.equal(items[0]?.type, "agent")
})

test("reset clears committed and live state", () => {
  const store = new ConversationStore()
  store.applySnapshot("agent-1", [user("u1", 1, "hi")])
  store.applyEvent({
    type: "message.progress",
    agentId: "agent-1",
    messageId: "a1",
    revision: 1,
    message: assistant("a1", 0, "live"),
  })
  store.reset()
  assert.equal(store.get("agent-1").length, 0)
  assert.equal(store.getActivity("agent-1"), null)
  assert.equal(store.getRunningTool("agent-1"), null)
})

test("multiple progress events in one frame collapse into a single rebuild", () => {
  // Override window with a deferred rAF so we can batch calls inside one frame.
  const queue: FrameRequestCallback[] = []
  const deferredWindow = {
    requestAnimationFrame(cb: FrameRequestCallback) {
      queue.push(cb)
      return queue.length
    },
    cancelAnimationFrame() {},
  }
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: deferredWindow,
  })

  const store = new ConversationStore()
  store.applySnapshot("agent-1", [user("u1", 1, "hi")])

  // Three progress events before the frame flushes.
  store.applyEvent({
    type: "message.progress",
    agentId: "agent-1",
    messageId: "a1",
    revision: 1,
    message: assistant("a1", 0, "first"),
  })
  store.applyEvent({
    type: "message.progress",
    agentId: "agent-1",
    messageId: "a1",
    revision: 2,
    message: assistant("a1", 0, "second"),
  })
  store.applyEvent({
    type: "message.progress",
    agentId: "agent-1",
    messageId: "a1",
    revision: 3,
    message: assistant("a1", 0, "third"),
  })

  // Snapshot not yet updated — rebuild is deferred to the frame.
  let items = store.get("agent-1")
  assert.equal(items.length, 1)

  // Flush all deferred frames (rebuild + notify).
  for (const cb of queue) cb(0)
  queue.length = 0

  items = store.get("agent-1")
  assert.equal(items.length, 2)
  const agentItem = items[1]
  if (agentItem?.type !== "agent") assert.fail("expected agent item")
  const block = agentItem.blocks[0]
  if (block?.type !== "text") assert.fail("expected text block")
  assert.equal(block.body, "third")

  // Restore synchronous fakeWindow for subsequent tests.
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: fakeWindow,
  })
})

test("tool.progress clears the streaming flag from a generating tool call", () => {
  const store = new ConversationStore()
  // Simulate toolcall_delta phase: assistant message with a toolCall in progress
  store.applyEvent({
    type: "message.progress",
    agentId: "agent-1",
    messageId: "a1",
    revision: 1,
    message: {
      role: "assistant",
      id: "a1",
      agentId: "agent-1",
      seq: 0,
      createdAt: new Date(0).toISOString(),
      content: [
        {
          type: "toolCall",
          id: "call-1",
          name: "bash",
          arguments: { command: "ls" },
        },
      ],
    },
  })

  let items = store.get("agent-1")
  let block = items[0]?.blocks?.[0]
  if (block?.type !== "tool") assert.fail("expected tool block")
  assert.equal(block.streaming, true)
  assert.equal(block.status, "pending")

  // Tool execution starts — streaming should be cleared
  store.applyEvent({
    type: "tool.progress",
    agentId: "agent-1",
    toolCallId: "call-1",
    revision: 1,
    toolName: "bash",
    args: { command: "ls" },
    status: "running",
  })

  items = store.get("agent-1")
  block = items[0]?.blocks?.[0]
  if (block?.type !== "tool") assert.fail("expected tool block")
  assert.equal(block.streaming, false)
  assert.equal(block.status, "running")
})
