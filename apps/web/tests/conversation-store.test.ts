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
  store.applySnapshot("child", [
    assistant("c1", 1, "child answer", "child"),
  ])

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
