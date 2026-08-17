import { describe, expect, test } from "bun:test"

import type { EntryItem } from "@/api"
import { buildConversation, type LiveEntry } from "@/domain/conversation"

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
  args: unknown,
  seq = 3,
  key = `a${seq}`
): EntryItem {
  return item(seq, key, {
    type: "message",
    id: key,
    timestamp: "2025-01-01T00:00:02Z",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id, name, arguments: args }],
      stopReason: "toolCall",
    },
  })
}

function toolResultItem(
  id: string,
  toolName: string,
  output: string,
  seq = 4,
  key = `t${seq}`
): EntryItem {
  return item(seq, key, {
    type: "message",
    id: key,
    timestamp: "2025-01-01T00:00:03Z",
    message: {
      role: "toolResult",
      toolCallId: id,
      toolName,
      content: [{ type: "text", text: output }],
    },
  })
}

function compactionItem(
  summary: string,
  tokensBefore: number,
  seq = 5
): EntryItem {
  return item(seq, `c${seq}`, {
    type: "compaction",
    id: `c${seq}`,
    timestamp: "2025-01-01T00:00:04Z",
    tokensBefore,
    summary,
  })
}

function modelChangeItem(
  provider: string,
  modelId: string,
  seq = 6
): EntryItem {
  return item(seq, `m${seq}`, {
    type: "model_change",
    id: `m${seq}`,
    timestamp: "2025-01-01T00:00:05Z",
    provider,
    modelId,
  })
}

function thinkingChangeItem(level: string, seq = 7): EntryItem {
  return item(seq, `t${seq}`, {
    type: "thinking_level_change",
    id: `t${seq}`,
    timestamp: "2025-01-01T00:00:06Z",
    thinkingLevel: level,
  })
}

describe("buildConversation", () => {
  test("renders a user message then the assistant text in one agent block", () => {
    const items = buildConversation(
      [userItem("hello"), assistantText("let me look")],
      []
    )
    expect(items[0]).toMatchObject({ type: "user", body: "hello" })
    expect(items[1]).toMatchObject({ type: "agent" })
    expect(items[1]!.type === "agent" && items[1].blocks).toEqual([
      { key: "a2:0", type: "text", body: "let me look" },
    ])
  })

  test("merges a toolCall with its toolResult into one tool block", () => {
    const items = buildConversation(
      [
        assistantToolCall("tc-1", "bash", { command: "ls" }),
        toolResultItem("tc-1", "bash", "exploit.py"),
      ],
      []
    )
    const agent = items[0]!
    expect(agent.type).toBe("agent")
    if (agent.type !== "agent") return
    expect(agent.blocks).toHaveLength(1)
    const block = agent.blocks[0]!
    expect(block).toMatchObject({
      type: "tool",
      name: "bash",
      args: { command: "ls" },
      output: "exploit.py",
      status: "done",
    })
  })

  test("compaction renders a system marker with a token label", () => {
    const items = buildConversation(
      [userItem("long"), compactionItem("summarized", 1500)],
      []
    )
    expect(items[1]).toMatchObject({
      type: "system",
      variant: "compaction",
      title: "已压缩 2k token",
      body: "summarized",
    })
  })

  test("model / thinking changes render system markers", () => {
    const items = buildConversation(
      [modelChangeItem("anthropic", "claude-3.5"), thinkingChangeItem("high")],
      []
    )
    expect(items[0]).toMatchObject({
      type: "system",
      variant: "model",
      title: "已切换模型 → anthropic / claude-3.5",
    })
    expect(items[1]).toMatchObject({
      type: "system",
      variant: "thinking",
      title: "推理 → high",
    })
  })

  test("a live tool update flows into the committed tool block (running → done)", () => {
    const live: LiveEntry[] = [
      {
        key: "tool:tc-1",
        type: "tool",
        toolCallId: "tc-1",
        toolName: "bash",
        args: { command: "ls" },
        status: "running",
        isError: false,
      },
      {
        key: "tool:tc-1",
        type: "tool",
        toolCallId: "tc-1",
        toolName: "bash",
        args: { command: "ls" },
        result: "exploit.py",
        status: "done",
        isError: false,
      },
    ]
    const items = buildConversation(
      [assistantToolCall("tc-1", "bash", { command: "ls" })],
      live
    )
    const agent = items[0]!
    if (agent.type !== "agent") return
    expect(agent.blocks).toHaveLength(1)
    expect(agent.blocks[0]).toMatchObject({
      status: "done",
      output: "exploit.py",
    })
  })

  test("live error entries render as an error block", () => {
    const items = buildConversation(
      [],
      [{ key: "err:1", type: "error", body: "boom" }]
    )
    expect(items[0]).toMatchObject({ type: "agent" })
    const agent = items[0]!
    if (agent.type !== "agent") return
    expect(agent.blocks).toEqual([
      { key: "err:1", type: "error", body: "boom" },
    ])
  })

  test("an assistant message with no renderable content is filtered out", () => {
    const items = buildConversation(
      [
        item(2, "a2", {
          type: "message",
          id: "a2",
          timestamp: "2025-01-01T00:00:01Z",
          message: { role: "assistant", content: [], stopReason: "done" },
        }),
      ],
      []
    )
    expect(items).toHaveLength(0)
  })

  test("a live assistant draft appends to the current agent block", () => {
    const items = buildConversation(
      [userItem("go")],
      [
        {
          key: "message:draft",
          type: "message",
          entry: {
            type: "message",
            id: "draft",
            timestamp: "2025-01-01T00:00:02Z",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "working…" }],
            },
          } as EntryItem["entry"],
        },
      ]
    )
    expect(items).toHaveLength(2)
    expect(items[1]!.type).toBe("agent")
  })
})
