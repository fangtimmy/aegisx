import assert from "node:assert/strict"
import test from "node:test"
import type { Message } from "@/api"
import { buildConversation, type LiveEntry } from "@/domain/conversation"
import { ConversationStore } from "@/stream/conversation-store"

const fakeWindow = {
  requestAnimationFrame(callback: FrameRequestCallback) {
    callback(0)
    return 1
  },
  cancelAnimationFrame() {},
}

class FakeEventSource {
  static latest: FakeEventSource | undefined
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  closed = false

  constructor(readonly url: string) {
    FakeEventSource.latest = this
  }

  close() {
    this.closed = true
  }
}

Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: fakeWindow,
})
Object.defineProperty(globalThis, "EventSource", {
  configurable: true,
  value: FakeEventSource,
})

function assistant(
  id: string,
  seq: number,
  content: Message extends { role: "assistant" } ? Message["content"] : never,
  extra?: Partial<Extract<Message, { role: "assistant" }>>
): Message {
  return {
    role: "assistant",
    id,
    agentId: "agent-1",
    seq,
    createdAt: new Date(seq * 1000).toISOString(),
    content,
    timestamp: seq,
    ...extra,
  }
}

function user(
  id: string,
  seq: number,
  text: string,
  extra?: Partial<Extract<Message, { role: "user" }>>
): Message {
  return {
    role: "user",
    id,
    agentId: "agent-1",
    seq,
    createdAt: new Date(seq * 1000).toISOString(),
    source: "user",
    content: [{ type: "text", text }],
    ...extra,
  }
}

test("pairs live tool progress with the persisted assistant message", () => {
  const history: Message[] = [
    assistant("assistant-1", 1, [
      {
        type: "toolCall",
        id: "call-1",
        name: "bash",
        arguments: { command: "ls" },
      },
    ]),
  ]
  const live: LiveEntry[] = [
    {
      key: "tool:call-1",
      type: "tool",
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "ls" },
      result: "file.txt",
      isError: false,
      status: "running",
    },
  ]

  const items = buildConversation(history, live)
  assert.equal(items.length, 1)
  assert.equal(items[0]?.type, "agent")
  if (items[0]?.type !== "agent") assert.fail("expected an agent turn")
  assert.equal(items[0].blocks.length, 1)
  assert.equal(items[0].blocks[0]?.type, "tool")
  if (items[0].blocks[0]?.type !== "tool") assert.fail("expected a tool")
  assert.equal(items[0].blocks[0].status, "running")
  assert.equal(items[0].blocks[0].output, "file.txt")
})

test("committed messages replace progress with the same stable id", () => {
  const store = new ConversationStore()
  store.applyEvent({
    type: "message.progress",
    agentId: "agent-1",
    messageId: "message-1",
    revision: 1,
    message: assistant("message-1", 0, [{ type: "text", text: "partial" }]),
  })
  store.applyEvent({
    type: "message.committed",
    agentId: "agent-1",
    message: assistant("message-1", 1, [{ type: "text", text: "complete" }]),
  })

  const items = store.get("agent-1")
  assert.equal(items.length, 1)
  assert.equal(items[0]?.type, "agent")
  if (items[0]?.type !== "agent") assert.fail("expected an agent turn")
  assert.equal(items[0].blocks[0]?.type, "text")
  if (items[0].blocks[0]?.type !== "text") assert.fail("expected text")
  assert.equal(items[0].blocks[0].body, "complete")
})

test("ignores out-of-order progress revisions", () => {
  const store = new ConversationStore()
  store.applyEvent({
    type: "message.progress",
    agentId: "agent-1",
    messageId: "message-1",
    revision: 2,
    message: assistant("message-1", 0, [{ type: "text", text: "new" }]),
  })
  store.applyEvent({
    type: "message.progress",
    agentId: "agent-1",
    messageId: "message-1",
    revision: 1,
    message: assistant("message-1", 0, [{ type: "text", text: "old" }]),
  })

  const items = store.get("agent-1")
  assert.equal(items[0]?.type, "agent")
  if (items[0]?.type !== "agent") assert.fail("expected an agent turn")
  assert.equal(items[0].blocks[0]?.type, "text")
  if (items[0].blocks[0]?.type !== "text") assert.fail("expected text")
  assert.equal(items[0].blocks[0].body, "new")
})

test("keeps completed turns stable while the current turn streams", () => {
  const store = new ConversationStore()
  store.applySnapshot("agent-1", [
    user("user-1", 1, "first task"),
    assistant("assistant-1", 2, [{ type: "text", text: "first answer" }]),
    user("user-2", 3, "continue"),
  ])
  const before = store.get("agent-1")

  store.applyEvent({
    type: "message.progress",
    agentId: "agent-1",
    messageId: "assistant-2",
    revision: 1,
    message: assistant("assistant-2", 0, [{ type: "text", text: "partial" }]),
  })
  const firstProgress = store.get("agent-1")

  assert.equal(firstProgress[0], before[0])
  assert.equal(firstProgress[1], before[1])
  assert.equal(firstProgress[2], before[2])

  store.applyEvent({
    type: "message.progress",
    agentId: "agent-1",
    messageId: "assistant-2",
    revision: 2,
    message: assistant("assistant-2", 0, [{ type: "text", text: "updated" }]),
  })
  const secondProgress = store.get("agent-1")

  assert.equal(secondProgress[0], before[0])
  assert.notEqual(secondProgress[3], firstProgress[3])
  assert.equal(secondProgress[3]?.type, "agent")
  if (secondProgress[3]?.type !== "agent") {
    assert.fail("expected the current agent turn")
  }
  assert.equal(secondProgress[3].blocks[0]?.type, "text")
  if (secondProgress[3].blocks[0]?.type !== "text") {
    assert.fail("expected current text")
  }
  assert.equal(secondProgress[3].blocks[0].body, "updated")
})

test("closes the stream after any terminal run update is refreshed", async () => {
  const store = new ConversationStore()
  store.connect(
    "run-1",
    () => {},
    () => {},
    () => {}
  )
  const source = FakeEventSource.latest
  if (!source) assert.fail("expected an event source")
  assert.ok(source.url.includes("/stream"))

  assert.equal(
    store.closeOnTerminal("running", () => Promise.resolve()),
    false
  )
  assert.equal(source.closed, false)

  let resolveRefresh = () => {}
  const refresh = new Promise<void>((resolve) => {
    resolveRefresh = resolve
  })
  assert.equal(
    store.closeOnTerminal("stopped", () => refresh),
    true
  )
  assert.equal(source.closed, false)

  resolveRefresh()
  await refresh
  await Promise.resolve()
  assert.equal(source.closed, true)
})

test("ignores stale progress after a snapshot already committed the message", () => {
  const store = new ConversationStore()
  store.applySnapshot("agent-1", [
    assistant("message-1", 1, [{ type: "text", text: "complete" }]),
  ])
  store.applyEvent({
    type: "message.progress",
    agentId: "agent-1",
    messageId: "message-1",
    revision: 1,
    message: assistant("message-1", 0, [{ type: "text", text: "stale" }]),
  })

  const items = store.get("agent-1")
  assert.equal(items[0]?.type, "agent")
  if (items[0]?.type !== "agent") assert.fail("expected an agent turn")
  assert.equal(items[0].blocks[0]?.type, "text")
  if (items[0].blocks[0]?.type !== "text") assert.fail("expected text")
  assert.equal(items[0].blocks[0].body, "complete")
})

test("snapshot and live tool completion stay in one conversation", () => {
  const store = new ConversationStore()
  store.applySnapshot("agent-1", [
    assistant("assistant-1", 1, [
      {
        type: "toolCall",
        id: "call-1",
        name: "bash",
        arguments: { command: "ls" },
      },
    ]),
  ])
  store.applyEvent({
    type: "tool.progress",
    agentId: "agent-1",
    toolCallId: "call-1",
    revision: 1,
    toolName: "bash",
    args: { command: "ls" },
    result: "ok",
    status: "done",
  })

  const items = store.get("agent-1")
  assert.equal(items.length, 1)
  assert.equal(items[0]?.type, "agent")
})

test("stable keys for consecutive user messages", () => {
  const items = buildConversation(
    [user("message-1", 1, "first"), user("message-2", 2, "second")],
    []
  )

  assert.deepEqual(
    items.map((item) => item.key),
    ["message-1", "message-2"]
  )
})

test("renders child completion as an agent handoff", () => {
  const items = buildConversation(
    [
      {
        role: "notice",
        id: "handoff-1",
        agentId: "agent-1",
        seq: 1,
        createdAt: "1970-01-01T00:00:01.000Z",
        source: "child_result",
        text: "Background agent Recon (agent-1) completed.\n\nFinal output:\n\nFound the target file.",
        handoff: {
          agentId: "agent-1",
          agentName: "Recon",
          status: "completed",
        },
      },
    ],
    []
  )

  assert.deepEqual(items[0], {
    key: "handoff-1",
    type: "handoff",
    agentName: "Recon",
    agentId: "agent-1",
    status: "completed",
    body: "Found the target file.",
    timestamp: "1970-01-01T00:00:01.000Z",
  })
})
