import { describe, expect, test } from "bun:test"

import type { LiveEvent } from "@aegisx/shared/live-event"
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent"
import type { SessionEntry } from "@earendil-works/pi-coding-agent"

import { createAgentEventPipeline } from "../../src/agents/event-pipeline"
import type { LiveBus } from "../../src/agents/live"

type Committed = Extract<LiveEvent, { type: "message.committed" }>
type ToolProgress = Extract<LiveEvent, { type: "tool.progress" }>
type MessageProgress = Extract<LiveEvent, { type: "message.progress" }>
type Activity = Extract<LiveEvent, { type: "agent.activity" }>

/** A pipeline wired to a recording bus. Persistence is owned by the
 * SessionManager; the pipeline's `commitEntry` is driven by
 * DbSessionManager.onAppend (the authoritative "entry just persisted" signal,
 * since pi emits no equivalent event for regular messages). */
function setup() {
  const emitted: LiveEvent[] = []
  const bus = {
    emit: (_channel: string, event: LiveEvent) => emitted.push(event),
  } as unknown as LiveBus
  const pipeline = createAgentEventPipeline({
    channel: "run-1",
    agentId: "agent-1",
    bus,
  })
  return { pipeline, emitted }
}

const committedOf = (emitted: LiveEvent[]) =>
  emitted.filter((e): e is Committed => e.type === "message.committed")

function messageEntry(role: string, ts: number, id: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: new Date(ts).toISOString(),
    message: { role, content: [], timestamp: ts } as unknown as AgentMessage,
  } as SessionEntry
}

describe("createAgentEventPipeline commitEntry", () => {
  test("emits committed for a message with its real seq", () => {
    const { pipeline, emitted } = setup()
    pipeline.commitEntry(messageEntry("user", 1000, "e1"), 1)

    const committed = committedOf(emitted)
    expect(committed.length).toBe(1)
    expect(committed[0].item.seq).toBe(1)
    const entry = committed[0].item.entry
    expect(entry.type).toBe("message")
    if (entry.type !== "message") throw new Error("expected message entry")
    expect(entry.message.role).toBe("user")
  })

  test("skips non-renderable entries (model_change) but their seq gaps through", () => {
    const { pipeline, emitted } = setup()
    pipeline.commitEntry(
      {
        type: "model_change",
        id: "m1",
        parentId: null,
        timestamp: new Date(1000).toISOString(),
        provider: "p",
        modelId: "m",
      } as SessionEntry,
      1
    )
    pipeline.commitEntry(messageEntry("user", 2000, "e1"), 2)

    const committed = committedOf(emitted)
    expect(committed.length).toBe(1)
    expect(committed[0].item.seq).toBe(2) // gap at 1 (the model_change)
  })

  test("compaction entry is emitted as its native compaction entry", () => {
    const { pipeline, emitted } = setup()
    pipeline.commitEntry(messageEntry("assistant", 1000, "e1"), 1)
    pipeline.commitEntry(
      {
        type: "compaction",
        id: "c1",
        parentId: "e1",
        timestamp: new Date(2000).toISOString(),
        summary: "summary",
        firstKeptEntryId: "e1",
        tokensBefore: 180000,
      } as SessionEntry,
      2
    )

    const committed = committedOf(emitted)
    expect(committed.length).toBe(2)
    expect(committed[1].item.seq).toBe(2)
    expect(committed[1].item.entry.type).toBe("compaction")
    expect(
      (committed[1].item.entry as { tokensBefore: number }).tokensBefore
    ).toBe(180000)
  })

  test("branch_summary entry is emitted (renderable marker)", () => {
    const { pipeline, emitted } = setup()
    pipeline.commitEntry(
      {
        type: "branch_summary",
        id: "b1",
        parentId: null,
        timestamp: new Date(1000).toISOString(),
        fromId: "root",
        summary: "abandoned branch",
      } as SessionEntry,
      1
    )
    const committed = committedOf(emitted)
    expect(committed.length).toBe(1)
    expect(committed[0].item.entry.type).toBe("branch_summary")
  })

  test("message_end / agent_end never emit committed (storage layer owns it)", () => {
    const { pipeline, emitted } = setup()
    pipeline.handle({
      type: "message_end",
      message: {} as AgentMessage,
    } as never)
    pipeline.handle({
      type: "agent_end",
      messages: [],
      willRetry: false,
    } as never)
    expect(committedOf(emitted).length).toBe(0)
  })
})

describe("createAgentEventPipeline tool progress", () => {
  test("tool_execution_start emits a running tool.progress with args", () => {
    const { pipeline, emitted } = setup()
    pipeline.handle({
      type: "tool_execution_start",
      toolCallId: "t1",
      toolName: "bash",
      args: { command: "echo hi" },
    } as AgentSessionEvent)
    const tp = emitted.filter(
      (e): e is ToolProgress => e.type === "tool.progress"
    )
    expect(tp.length).toBe(1)
    expect(tp[0].status).toBe("running")
    expect(tp[0].args).toEqual({ command: "echo hi" })
  })

  test("tool_execution_update carries the partial result (intermediate output)", () => {
    const { pipeline, emitted } = setup()
    pipeline.handle({
      type: "tool_execution_update",
      toolCallId: "t1",
      toolName: "bash",
      args: { command: "seq 100" },
      partialResult: {
        content: [{ type: "text", text: "1\n2\n3" }],
        details: { streaming: true },
      },
    } as AgentSessionEvent)
    const tp = emitted.filter(
      (e): e is ToolProgress => e.type === "tool.progress"
    )
    expect(tp.length).toBe(1)
    expect(tp[0].status).toBe("running")
    expect(tp[0].result).toEqual({
      content: [{ type: "text", text: "1\n2\n3" }],
      details: { streaming: true },
    })
  })

  test("tool_execution_end omits args (keeps store's start args) and is done", () => {
    const { pipeline, emitted } = setup()
    pipeline.handle({
      type: "tool_execution_end",
      toolCallId: "t1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "ok" }], details: {} },
      isError: false,
    } as AgentSessionEvent)
    const tp = emitted.filter(
      (e): e is ToolProgress => e.type === "tool.progress"
    )
    expect(tp.length).toBe(1)
    expect(tp[0].status).toBe("done")
    expect(tp[0].isError).toBeUndefined()
    expect("args" in tp[0]).toBe(false)
    expect("terminal" in tp[0]).toBe(false)
  })

  test("tool_execution_end classifies terminal from result.details.terminal (bash no longer throws)", () => {
    const cases: Array<{
      terminal: "timed_out" | "cancelled" | "failed"
    }> = [
      { terminal: "cancelled" },
      { terminal: "timed_out" },
      { terminal: "failed" },
    ]
    for (const { terminal } of cases) {
      const { pipeline, emitted } = setup()
      // The bash tool now returns a result (isError:false) with the terminal
      // reason in details — the pipeline derives the error state from it.
      pipeline.handle({
        type: "tool_execution_end",
        toolCallId: "t1",
        toolName: "bash",
        result: {
          content: [{ type: "text", text: "out" }],
          details: { exitCode: 1, terminal },
        },
        isError: false,
      } as unknown as AgentSessionEvent)
      const tp = emitted.find(
        (e): e is ToolProgress => e.type === "tool.progress"
      )
      expect(tp).toBeDefined()
      expect(tp?.status).toBe("error")
      expect(tp?.isError).toBe(true)
      expect(tp?.terminal).toBe(terminal)
    }
  })

  test("tool_execution_end falls back to 'failed' when the SDK reports an error without structured details", () => {
    // An untyped tool that still throws → SDK isError:true, details:{}.
    const { pipeline, emitted } = setup()
    pipeline.handle({
      type: "tool_execution_end",
      toolCallId: "t1",
      toolName: "something",
      result: { content: [{ type: "text", text: "boom" }], details: {} },
      isError: true,
    } as unknown as AgentSessionEvent)
    const tp = emitted.find(
      (e): e is ToolProgress => e.type === "tool.progress"
    )
    expect(tp?.status).toBe("error")
    expect(tp?.terminal).toBe("failed")
  })
})

describe("createAgentEventPipeline message / activity", () => {
  test("message_start for a toolResult is NOT streamed (tool block owns it)", () => {
    const { pipeline, emitted } = setup()
    pipeline.handle({
      type: "message_start",
      message: {
        role: "toolResult",
        toolCallId: "t1",
        toolName: "bash",
        content: [],
        details: {},
        isError: false,
        timestamp: 1,
      } as AgentMessage,
    } as AgentSessionEvent)
    expect(emitted.some((e) => e.type === "message.progress")).toBe(false)
  })

  test("message_update toolcall_delta forwards the partial assistant message", () => {
    const { pipeline, emitted } = setup()
    pipeline.handle({
      type: "message_update",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "t1", name: "bash", arguments: '{"comm' },
        ],
        timestamp: 1,
      } as unknown as AgentMessage,
      assistantMessageEvent: {
        type: "toolcall_delta",
        contentIndex: 0,
        delta: '{"comm',
      },
    } as AgentSessionEvent)
    const mp = emitted.filter(
      (e): e is MessageProgress => e.type === "message.progress"
    )
    expect(mp.length).toBe(1)
  })

  test("compaction_end emits a clean activity:null (no token enrichment)", () => {
    const { pipeline, emitted } = setup()
    pipeline.handle({
      type: "compaction_end",
      reason: "threshold",
      result: { tokensBefore: 180000, estimatedTokensAfter: 30000 } as never,
      aborted: false,
      willRetry: false,
    } as AgentSessionEvent)
    const act = emitted.filter(
      (e): e is Activity => e.type === "agent.activity"
    )
    expect(act.length).toBe(1)
    expect(act[0].activity).toBeNull()
    expect("tokensBefore" in act[0]).toBe(false)
    expect("tokensAfter" in act[0]).toBe(false)
    expect("aborted" in act[0]).toBe(false)
  })
})
