import assert from "node:assert/strict"
import test from "node:test"
import type { ConversationMessage, PublicAgentMessage } from "@/api"
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

function message(
  id: string,
  sequence: number,
  value: PublicAgentMessage,
  agentId = "agent-1"
): ConversationMessage {
  return {
    id,
    agentId,
    sequence,
    message: value,
    createdAt: new Date(sequence * 1000).toISOString(),
  }
}

test("isolates conversation snapshots by agent", () => {
  const store = new ConversationStore()
  store.applySnapshot("main", [
    message("m1", 1, {
      role: "user",
      content: [{ type: "text", text: "main task" }],
    }),
  ])
  store.applySnapshot("child", [
    message(
      "c1",
      1,
      {
        role: "assistant",
        content: [{ type: "text", text: "child answer" }],
      },
      "child"
    ),
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
  store.addPendingMessage(
    message("pending-1", 99, {
      role: "user",
      content: [{ type: "text", text: "hello" }],
    })
  )
  assert.equal(store.get("agent-1").length, 1)
  store.removePendingMessage("agent-1", "pending-1")
  assert.equal(store.get("agent-1").length, 0)
})

test("resetForReconnect keeps pending messages and drops live progress", () => {
  const store = new ConversationStore()
  store.addPendingMessage(
    message("pending-1", 99, {
      role: "user",
      content: [{ type: "text", text: "still sending" }],
    })
  )
  store.applyEvent({
    type: "message.progress",
    agentId: "agent-1",
    messageId: "assistant-1",
    revision: 1,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "ephemeral" }],
    },
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
