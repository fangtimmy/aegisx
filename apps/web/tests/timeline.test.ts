import assert from "node:assert/strict"
import test from "node:test"
import {
  buildConversation,
  type LiveEntry,
  liveEntries,
} from "@/features/runs/timeline-model"
import type { SessionEntry } from "@/lib/api"

test("builds an agent turn and pairs tool results", () => {
  const startedAt = Date.parse("2026-07-16T00:00:01.000Z")
  const assistant = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "" },
      { type: "thinking", thinking: "Planning the inspection." },
      { type: "text", text: "Checking the workspace." },
      {
        type: "toolCall",
        id: "call-1",
        name: "bash",
        arguments: { command: "ls -la" },
      },
    ],
    timestamp: startedAt,
  }
  const history: SessionEntry[] = [
    {
      type: "message",
      id: "user-1",
      parentId: null,
      timestamp: "2026-07-16T00:00:00.000Z",
      message: {
        role: "user",
        content: [{ type: "text", text: "Inspect the files." }],
        timestamp: 1,
      },
    },
    {
      type: "message",
      id: "assistant-1",
      parentId: "user-1",
      timestamp: "2026-07-16T00:00:02.500Z",
      message: assistant,
    },
    {
      type: "message",
      id: "result-1",
      parentId: "assistant-1",
      timestamp: "2026-07-16T00:00:02.000Z",
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "bash",
        content: [{ type: "text", text: "file.txt" }],
        isError: false,
        timestamp: 3,
      },
    },
  ]
  const live: LiveEntry[] = [
    {
      key: `message:assistant:${startedAt}`,
      type: "message",
      message: assistant,
    },
    {
      key: "tool:call-1",
      type: "tool",
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "ls -la" },
      result: { content: [{ type: "text", text: "duplicate" }] },
      isError: false,
      status: "done",
    },
  ]

  const items = buildConversation(history, live)
  assert.deepEqual(
    items.map((item) => item.type),
    ["user", "agent"]
  )
  const agent = items[1]
  if (agent.type !== "agent") assert.fail("expected an agent turn")
  assert.deepEqual(
    agent.blocks.map((block) => block.type),
    ["reasoning", "text", "tool"]
  )
  const reasoning = agent.blocks[0]
  if (reasoning.type !== "reasoning") assert.fail("expected reasoning")
  assert.equal(reasoning.durationMs, 1500)
  const tool = agent.blocks[2]
  if (tool.type !== "tool") assert.fail("expected a tool block")
  assert.equal(tool.status, "done")
  assert.equal(tool.output, "file.txt")
})

test("renders child completion as an agent handoff", () => {
  const items = buildConversation(
    [
      {
        type: "message",
        id: "handoff-1",
        parentId: null,
        timestamp: "2026-07-16T00:00:00.000Z",
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text: "Background agent Recon (agent-1) completed.\n\nFinal output:\n\nFound the target file.",
            },
          ],
          timestamp: 1,
        },
      },
    ],
    []
  )

  assert.equal(items.length, 1)
  assert.deepEqual(items[0], {
    key: "message:user:1",
    type: "handoff",
    agentName: "Recon",
    agentId: "agent-1",
    status: "completed",
    body: "Found the target file.",
    timestamp: 1,
  })
})

test("keeps streaming message updates on one live entry", () => {
  const started = liveEntries({
    type: "message_start",
    message: { role: "assistant", timestamp: 42, content: [] },
  })
  const updated = liveEntries({
    type: "message_update",
    message: {
      role: "assistant",
      timestamp: 42,
      content: [{ type: "text", text: "Streaming" }],
    },
  })

  assert.equal(started[0]?.key, updated[0]?.key)
  assert.equal(updated[0]?.type, "message")
  if (updated[0]?.type !== "message") assert.fail("expected a message")
  assert.equal(
    (updated[0].message.content as Array<{ text: string }>)[0]?.text,
    "Streaming"
  )
})
