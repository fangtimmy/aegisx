import assert from "node:assert/strict"
import test from "node:test"
import { RunStreamStore } from "@/features/runs/run-stream-store"
import {
  buildConversation,
  type LiveEntry,
} from "@/features/runs/timeline-model"
import type { ConversationMessage } from "@/lib/api"

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

function message(
  id: string,
  sequence: number,
  value: Record<string, unknown>
): ConversationMessage {
  return {
    id,
    agentId: "agent-1",
    sequence,
    message: value,
    createdAt: new Date(sequence * 1000).toISOString(),
  }
}

test("pairs live tool progress with the persisted assistant message", () => {
  const history = [
    message("assistant-1", 1, {
      role: "assistant",
      timestamp: 1,
      content: [
        {
          type: "toolCall",
          id: "call-1",
          name: "bash",
          arguments: { command: "ls" },
        },
      ],
    }),
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
  const store = new RunStreamStore()
  store.applyEvent({
    type: "message.progress",
    agentId: "agent-1",
    messageId: "message-1",
    revision: 1,
    message: {
      role: "assistant",
      timestamp: 1,
      content: [{ type: "text", text: "partial" }],
    },
  })
  store.applyEvent({
    type: "message.committed",
    agentId: "agent-1",
    cursor: 2,
    message: message("message-1", 1, {
      role: "assistant",
      timestamp: 1,
      content: [{ type: "text", text: "complete" }],
    }),
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
  const store = new RunStreamStore()
  store.applyEvent({
    type: "message.progress",
    agentId: "agent-1",
    messageId: "message-1",
    revision: 2,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "new" }],
    },
  })
  store.applyEvent({
    type: "message.progress",
    agentId: "agent-1",
    messageId: "message-1",
    revision: 1,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "old" }],
    },
  })

  const items = store.get("agent-1")
  assert.equal(items[0]?.type, "agent")
  if (items[0]?.type !== "agent") assert.fail("expected an agent turn")
  assert.equal(items[0].blocks[0]?.type, "text")
  if (items[0].blocks[0]?.type !== "text") assert.fail("expected text")
  assert.equal(items[0].blocks[0].body, "new")
})

test("keeps completed turns stable while the current turn streams", () => {
  const store = new RunStreamStore()
  store.applySnapshot("agent-1", [
    message("user-1", 1, {
      role: "user",
      content: [{ type: "text", text: "first task" }],
    }),
    message("assistant-1", 2, {
      role: "assistant",
      content: [{ type: "text", text: "first answer" }],
    }),
    message("user-2", 3, {
      role: "user",
      content: [{ type: "text", text: "continue" }],
    }),
  ])
  const before = store.get("agent-1")

  store.applyEvent({
    type: "message.progress",
    agentId: "agent-1",
    messageId: "assistant-2",
    revision: 1,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "partial" }],
    },
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
    message: {
      role: "assistant",
      content: [{ type: "text", text: "updated" }],
    },
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
  const store = new RunStreamStore()
  store.connect(
    "run-1",
    0,
    () => {},
    () => {},
    () => {}
  )
  const source = FakeEventSource.latest
  if (!source) assert.fail("expected an event source")

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
  const store = new RunStreamStore()
  store.applySnapshot("agent-1", [
    message("message-1", 1, {
      role: "assistant",
      content: [{ type: "text", text: "complete" }],
    }),
  ])
  store.applyEvent({
    type: "message.progress",
    agentId: "agent-1",
    messageId: "message-1",
    revision: 1,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "stale" }],
    },
  })

  const items = store.get("agent-1")
  assert.equal(items[0]?.type, "agent")
  if (items[0]?.type !== "agent") assert.fail("expected an agent turn")
  assert.equal(items[0].blocks[0]?.type, "text")
  if (items[0].blocks[0]?.type !== "text") assert.fail("expected text")
  assert.equal(items[0].blocks[0].body, "complete")
})

test("snapshot and live tool completion stay in one conversation", () => {
  const store = new RunStreamStore()
  store.applySnapshot("agent-1", [
    message("assistant-1", 1, {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call-1",
          name: "bash",
          arguments: { command: "cat flag" },
        },
      ],
    }),
  ])
  store.applyEvent({
    type: "tool.progress",
    agentId: "agent-1",
    toolCallId: "call-1",
    revision: 1,
    toolName: "bash",
    args: { command: "cat flag" },
    result: "flag{ok}",
    status: "done",
  })
  store.applyEvent({
    type: "message.committed",
    agentId: "agent-1",
    cursor: 11,
    message: message("tool:call-1", 2, {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "bash",
      content: [{ type: "text", text: "flag{ok}" }],
      isError: false,
    }),
  })

  const items = store.get("agent-1")
  assert.equal(items.length, 1)
  assert.equal(items[0]?.type, "agent")
  if (items[0]?.type !== "agent") assert.fail("expected an agent turn")
  assert.deepEqual(
    items[0].blocks.map((block) => block.type),
    ["tool"]
  )
  if (items[0].blocks[0]?.type !== "tool") assert.fail("expected a tool")
  assert.equal(items[0].blocks[0].status, "done")
  assert.equal(items[0].blocks[0].output, "flag{ok}")
})

test("stable message ids keep same-timestamp history distinct", () => {
  const items = buildConversation(
    [
      message("message-1", 1, {
        role: "user",
        timestamp: 100,
        content: [{ type: "text", text: "first" }],
      }),
      message("message-2", 2, {
        role: "user",
        timestamp: 100,
        content: [{ type: "text", text: "second" }],
      }),
    ],
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
      message("handoff-1", 1, {
        role: "user",
        content: [
          {
            type: "text",
            text: "Background agent Recon (agent-1) completed.\n\nFinal output:\n\nFound the target file.",
          },
        ],
        aegisx: {
          metadata: {
            handoff: {
              agentId: "agent-1",
              agentName: "Recon",
              status: "completed",
            },
          },
        },
      }),
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
