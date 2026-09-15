import { describe, expect, setSystemTime, test } from "bun:test"

import type { SessionEntryView, SessionMessageView } from "@aegisx/shared"
import type { LiveEvent } from "@aegisx/shared/live-event"
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent"
import type {
  AgentSession,
  SessionEntry,
} from "@earendil-works/pi-coding-agent"

import { accumulateEntryUsage } from "../../../src/run/host/entry-usage"
import {
  computeContextSample,
  createAgentEventPipeline,
} from "../../../src/run/host/event-pipeline"
import type { LiveBus } from "../../../src/run/host/live"
import { refine } from "../../support"

type Committed = Extract<LiveEvent, { type: "message.committed" }>
type ToolProgress = Extract<LiveEvent, { type: "tool.progress" }>
type MessageProgress = Extract<LiveEvent, { type: "message.progress" }>
type Activity = Extract<LiveEvent, { type: "agent.activity" }>

/** A pipeline wired to a recording bus. Persistence is owned by the
 * SessionManager; the pipeline's `commitEntry` is driven by the session
 * adapter's onAppend (the authoritative "entry just persisted" signal,
 * since pi emits no equivalent event for regular messages). */
function setup() {
  const emitted: LiveEvent[] = []
  const bus = refine<LiveBus>({
    emit: (_channel: string, event: LiveEvent) => emitted.push(event),
  })
  const pipeline = createAgentEventPipeline({
    channel: "run-1",
    agentId: "agent-1",
    sessionId: "sess-1",
    bus,
  })
  return { pipeline, emitted }
}

const committedOf = (emitted: LiveEvent[]) =>
  emitted.filter((e): e is Committed => e.type === "message.committed")

function messageEntry(role: string, ts: number, id: string): SessionEntry {
  return refine<SessionEntry>({
    type: "message",
    id,
    parentId: null,
    timestamp: new Date(ts).toISOString(),
    message: refine<AgentMessage>({ role, content: [], timestamp: ts }),
  })
}

/** The pipeline consumes the owned wire view; fixtures build pi entries and
 * cross the boundary the same way the adapter does (same object, re-typed). */
function viewEntry(entry: SessionEntry): SessionEntryView {
  return refine<SessionEntryView>(entry)
}

describe("createAgentEventPipeline commitEntry", () => {
  test("emits committed for a message with its real seq", () => {
    const { pipeline, emitted } = setup()
    pipeline.commitEntry(viewEntry(messageEntry("user", 1000, "e1")), 1)

    const committed = committedOf(emitted)
    expect(committed.length).toBe(1)
    expect(committed[0].item.seq).toBe(1)
    // The replay cursor's key: clients track lastSeq per session.
    expect(committed[0].sessionId).toBe("sess-1")
    expect(committed[0].agentId).toBe("agent-1")
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
      },
      1
    )
    pipeline.commitEntry(viewEntry(messageEntry("user", 2000, "e1")), 2)

    const committed = committedOf(emitted)
    expect(committed.length).toBe(1)
    expect(committed[0].item.seq).toBe(2) // gap at 1 (the model_change)
  })

  test("compaction entry is emitted as its native compaction entry", () => {
    const { pipeline, emitted } = setup()
    pipeline.commitEntry(viewEntry(messageEntry("assistant", 1000, "e1")), 1)
    pipeline.commitEntry(
      {
        type: "compaction",
        id: "c1",
        parentId: "e1",
        timestamp: new Date(2000).toISOString(),
        summary: "summary",
        firstKeptEntryId: "e1",
        tokensBefore: 180000,
      },
      2
    )

    const committed = committedOf(emitted)
    expect(committed.length).toBe(2)
    expect(committed[1].item.seq).toBe(2)
    expect(committed[1].item.entry.type).toBe("compaction")
    expect(
      refine<{ tokensBefore: number }>(committed[1].item.entry).tokensBefore
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
      },
      1
    )
    const committed = committedOf(emitted)
    expect(committed.length).toBe(1)
    expect(committed[0].item.entry.type).toBe("branch_summary")
  })

  test("message_end / agent_end never emit committed (storage layer owns it)", () => {
    const { pipeline, emitted } = setup()
    pipeline.handle(
      refine({
        type: "message_end",
        message: refine<AgentMessage>({}),
      })
    )
    pipeline.handle(
      refine({
        type: "agent_end",
        messages: [],
        willRetry: false,
      })
    )
    expect(committedOf(emitted).length).toBe(0)
  })
})

describe("createAgentEventPipeline tool progress", () => {
  test("tool_execution_start emits a running tool.progress with args + server startedAt (W6)", () => {
    const { pipeline, emitted } = setup()
    pipeline.handle(
      refine<AgentSessionEvent>({
        type: "tool_execution_start",
        toolCallId: "t1",
        toolName: "bash",
        args: { command: "echo hi" },
      })
    )
    const tp = emitted.filter(
      (e): e is ToolProgress => e.type === "tool.progress"
    )
    expect(tp.length).toBe(1)
    expect(tp[0].status).toBe("running")
    expect(tp[0].args).toEqual({ command: "echo hi" })
    // W6: the event carries the server-side execution start (epoch ms), so a
    // dialog opened mid-execution shows the true elapsed time.
    expect(typeof tp[0].startedAt).toBe("number")
    expect(tp[0].startedAt).toBeGreaterThan(0)
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
    })
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
    })
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
      pipeline.handle(
        refine<AgentSessionEvent>({
          type: "tool_execution_end",
          toolCallId: "t1",
          toolName: "bash",
          result: {
            content: [{ type: "text", text: "out" }],
            details: { exitCode: 1, terminal },
          },
          isError: false,
        })
      )
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
    pipeline.handle(
      refine<AgentSessionEvent>({
        type: "tool_execution_end",
        toolCallId: "t1",
        toolName: "something",
        result: { content: [{ type: "text", text: "boom" }], details: {} },
        isError: true,
      })
    )
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
    })
    expect(emitted.some((e) => e.type === "message.progress")).toBe(false)
  })

  test("message_update toolcall_delta forwards the partial assistant message", () => {
    const { pipeline, emitted } = setup()
    pipeline.handle(
      refine<AgentSessionEvent>({
        type: "message_update",
        message: refine<AgentMessage>({
          role: "assistant",
          content: [
            { type: "toolCall", id: "t1", name: "bash", arguments: '{"comm' },
          ],
          timestamp: 1,
        }),
        assistantMessageEvent: {
          type: "toolcall_delta",
          contentIndex: 0,
          delta: '{"comm',
        },
      })
    )
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
      result: refine({ tokensBefore: 180000, estimatedTokensAfter: 30000 }),
      aborted: false,
      willRetry: false,
    })
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

// --- v10 timing state machine ---------------------------------------------
// Two paths: assistant (message_start → deltas → message_end) and toolResult
// (tool_execution_start → tool_execution_end). setSystemTime makes the
// Date.now()-based offsets deterministic.

function assistantMessage(timestamp: number): AgentMessage {
  return refine<AgentMessage>({
    role: "assistant",
    content: [],
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp,
  })
}

function assistantEntry(msg: AgentMessage): SessionEntryView {
  return refine<SessionEntryView>({
    type: "message",
    id: "e",
    parentId: null,
    timestamp: "t",
    message: msg,
  })
}

function toolResultEntry(toolCallId: string): SessionEntryView {
  return refine<SessionEntryView>({
    type: "message",
    id: "e",
    parentId: null,
    timestamp: "t",
    message: refine<SessionMessageView>({
      role: "toolResult",
      toolCallId,
      content: [],
      isError: false,
    }),
  })
}

function assistantEvents(message: AgentMessage): {
  start: () => AgentSessionEvent
  end: () => AgentSessionEvent
  update: (ae: unknown) => AgentSessionEvent
} {
  return {
    start: () => ({ type: "message_start", message }),
    end: () => ({ type: "message_end", message }),
    update: (ae: unknown) =>
      refine<AgentSessionEvent>({
        type: "message_update",
        message,
        assistantMessageEvent: ae,
      }),
  }
}

describe("createAgentEventPipeline timing state machine", () => {
  test("assistant message: durationMs + per-block timing (thinking/text/toolCall)", () => {
    setSystemTime(0)
    const { pipeline } = setup()
    const msg = assistantMessage(1000)
    const e = assistantEvents(msg)

    setSystemTime(10_000)
    pipeline.handle(e.start())
    // thinking @ index 0: 500..700
    setSystemTime(10_500)
    pipeline.handle(e.update({ type: "thinking_start", contentIndex: 0 }))
    setSystemTime(10_600)
    pipeline.handle(e.update({ type: "thinking_delta", contentIndex: 0 }))
    setSystemTime(10_700)
    pipeline.handle(e.update({ type: "thinking_end", contentIndex: 0 }))
    // text @ index 1: 800..900
    setSystemTime(10_800)
    pipeline.handle(e.update({ type: "text_start", contentIndex: 1 }))
    setSystemTime(10_900)
    pipeline.handle(e.update({ type: "text_end", contentIndex: 1 }))
    // toolCall @ index 2: 1000..1100
    setSystemTime(11_000)
    pipeline.handle(e.update({ type: "toolcall_start", contentIndex: 2 }))
    setSystemTime(11_100)
    pipeline.handle(e.update({ type: "toolcall_end", contentIndex: 2 }))
    setSystemTime(11_100)
    pipeline.handle(e.end())

    const meta = pipeline.metaFor(assistantEntry(msg))
    expect(meta).not.toBeNull()
    expect(meta?.durationMs).toBe(1100)
    expect(meta?.blocks).toEqual([
      { type: "thinking", index: 0, startMs: 500, endMs: 700 },
      { type: "text", index: 1, startMs: 800, endMs: 900 },
      { type: "toolCall", index: 2, startMs: 1000, endMs: 1100 },
    ])
    setSystemTime()
  })

  test("parallel tool executions: callIds don't cross", () => {
    setSystemTime(0)
    const { pipeline } = setup()
    setSystemTime(50_000)
    pipeline.handle({
      type: "tool_execution_start",
      toolCallId: "tc-a",
      toolName: "bash",
      args: {},
    })
    setSystemTime(51_000)
    pipeline.handle({
      type: "tool_execution_start",
      toolCallId: "tc-b",
      toolName: "read",
      args: {},
    })
    setSystemTime(52_000)
    pipeline.handle({
      type: "tool_execution_end",
      toolCallId: "tc-a",
      toolName: "bash",
      result: {},
      isError: false,
    })
    setSystemTime(53_000)
    pipeline.handle({
      type: "tool_execution_end",
      toolCallId: "tc-b",
      toolName: "read",
      result: {},
      isError: false,
    })

    expect(pipeline.metaFor(toolResultEntry("tc-a"))).toEqual({
      durationMs: 2000,
    })
    expect(pipeline.metaFor(toolResultEntry("tc-b"))).toEqual({
      durationMs: 2000,
    })
    setSystemTime()
  })

  test("toolResult duration uses tool execution only (skipped message_start sets no assistant t0)", () => {
    setSystemTime(0)
    const { pipeline } = setup()
    // A toolResult message_start is skipped by the pipeline (no streaming
    // draft). It must NOT seed the assistant t0 — otherwise a later assistant
    // message would inherit a bogus start.
    setSystemTime(100_000)
    pipeline.handle({
      type: "message_start",
      message: refine<AgentMessage>({
        role: "toolResult",
        toolCallId: "tc-x",
        content: [],
        isError: false,
        timestamp: 999,
      }),
    })
    // No assistant message has started → assistant meta is null (no pollution).
    expect(pipeline.metaFor(assistantEntry(assistantMessage(999)))).toBeNull()

    setSystemTime(101_000)
    pipeline.handle({
      type: "tool_execution_start",
      toolCallId: "tc-x",
      toolName: "bash",
      args: {},
    })
    setSystemTime(102_000)
    pipeline.handle({
      type: "tool_execution_end",
      toolCallId: "tc-x",
      toolName: "bash",
      result: {},
      isError: false,
    })

    expect(pipeline.metaFor(toolResultEntry("tc-x"))).toEqual({
      durationMs: 1000,
    })
    setSystemTime()
  })
})

// --- incremental context sampling (computeContextSample) --------------------
// The sampler seeds a per-session accumulator from getEntries() once, then
// advances from the tail as entries append (leaf id moves on every append).
// Every sample must stay equal to a fresh full walk of the same entries.

type FixtureUsage = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cost: { total: number }
}

function fixtureUsage(over: Partial<FixtureUsage> = {}): FixtureUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: { total: 0 },
    ...over,
  }
}

function assistantUsageEntry(u: FixtureUsage, entryId: string): SessionEntry {
  return refine<SessionEntry>({
    type: "message",
    id: entryId,
    parentId: null,
    timestamp: "t",
    message: refine<AgentMessage>({ role: "assistant", content: [], usage: u }),
  })
}

function toolResultUsageEntry(
  u: FixtureUsage,
  toolCallId: string,
  entryId: string
): SessionEntry {
  return refine<SessionEntry>({
    type: "message",
    id: entryId,
    parentId: null,
    timestamp: "t",
    message: refine<AgentMessage>({
      role: "toolResult",
      toolCallId,
      content: [],
      isError: false,
      usage: u,
    }),
  })
}

function compactionUsageEntry(u: FixtureUsage, entryId: string): SessionEntry {
  return refine<SessionEntry>({
    type: "compaction",
    id: entryId,
    parentId: null,
    timestamp: "t",
    summary: "s",
    firstKeptEntryId: "k",
    tokensBefore: 1000,
    usage: u,
  })
}

/** A fake session: getEntries() copies (both managers are defensive) and the
 * leaf id is mutable — an append moves it, a backtrack moves it to an
 * ancestor. */
function fakeSession(
  entries: SessionEntry[],
  leaf: { id: string | null }
): AgentSession {
  return refine<AgentSession>({
    sessionManager: refine({
      getEntries: () => [...entries],
      getLeafId: () => leaf.id,
    }),
    getContextUsage: () => ({
      tokens: 123,
      contextWindow: 1000,
      percent: 12.3,
    }),
  })
}

function leafOf(entries: SessionEntry[]): { id: string | null } {
  return { id: entries.length > 0 ? entries[entries.length - 1].id : null }
}

/** The wire carries totals + cacheHitRate from the accumulator; a sample is
 * correct iff they equal the full-walk reference. */
function expectParity(session: AgentSession, entries: SessionEntry[]): void {
  const sample = computeContextSample(session)
  const ref = accumulateEntryUsage(entries)
  expect(sample.totals).toEqual({
    input: ref.input,
    output: ref.output,
    cacheRead: ref.cacheRead,
    cacheWrite: ref.cacheWrite,
    cost: ref.cost,
  })
  expect(sample.cacheHitRate).toBe(ref.cacheHitRate)
}

describe("computeContextSample incremental accumulator", () => {
  test("live context part passes through from getContextUsage()", () => {
    const entries = [messageEntry("user", 1000, "u1")]
    const sample = computeContextSample(fakeSession(entries, leafOf(entries)))
    expect(sample.tokens).toBe(123)
    expect(sample.contextWindow).toBe(1000)
    expect(sample.percent).toBe(12.3)
  })

  test("seed equals a full walk of the pre-existing entries", () => {
    const entries = [
      messageEntry("user", 1000, "u1"),
      assistantUsageEntry(
        fixtureUsage({
          input: 100,
          output: 50,
          cacheRead: 200,
          cost: { total: 0.01 },
        }),
        "a1"
      ),
      toolResultUsageEntry(fixtureUsage({ input: 10 }), "c1", "t1"),
      compactionUsageEntry(
        fixtureUsage({ input: 500, cost: { total: 0.05 } }),
        "cp1"
      ),
    ]
    expectParity(fakeSession(entries, leafOf(entries)), entries)
  })

  test("totals stay equal to a full walk after a series of appends", () => {
    const entries = [messageEntry("user", 1000, "u1")]
    const leaf = leafOf(entries)
    const session = fakeSession(entries, leaf)
    expectParity(session, entries)

    const appends: SessionEntry[] = [
      assistantUsageEntry(
        fixtureUsage({
          input: 100,
          cacheRead: 30,
          output: 20,
          cost: { total: 0.01 },
        }),
        "a1"
      ),
      toolResultUsageEntry(fixtureUsage({ input: 5 }), "c1", "t1"),
      assistantUsageEntry(
        fixtureUsage({
          input: 200,
          cacheRead: 150,
          output: 80,
          cost: { total: 0.02 },
        }),
        "a2"
      ),
      compactionUsageEntry(
        fixtureUsage({ input: 900, cost: { total: 0.1 } }),
        "cp1"
      ),
      toolResultUsageEntry(fixtureUsage({ input: 1 }), "c2", "t2"),
    ]
    for (const entry of appends) {
      entries.push(entry)
      leaf.id = entry.id
      expectParity(session, entries)
    }
  })

  test("appends must move the leaf: an unchanged leaf keeps the cached totals", () => {
    const entries = [
      assistantUsageEntry(fixtureUsage({ input: 10 }), "a1"),
      toolResultUsageEntry(fixtureUsage({ input: 1 }), "c1", "t1"),
    ]
    const leaf = leafOf(entries)
    const session = fakeSession(entries, leaf)
    const before = computeContextSample(session)
    entries.push(assistantUsageEntry(fixtureUsage({ input: 999 }), "a2"))
    const after = computeContextSample(session)
    expect(after.totals).toEqual(before.totals)

    // Moving the leaf (what a real append does) releases the advance.
    leaf.id = "a2"
    expectParity(session, entries)
  })

  test("a shrink (backtrack) rebuilds from the shorter history", () => {
    const entries = [
      messageEntry("user", 1000, "u1"),
      assistantUsageEntry(fixtureUsage({ input: 100 }), "a1"),
      assistantUsageEntry(fixtureUsage({ input: 200 }), "a2"),
      toolResultUsageEntry(fixtureUsage({ input: 3 }), "c1", "t1"),
    ]
    const leaf = leafOf(entries)
    const session = fakeSession(entries, leaf)
    expectParity(session, entries)

    // Backtrack to u1, then continue appending below the old leaf.
    entries.splice(1)
    leaf.id = "u1"
    expectParity(session, entries)

    entries.push(assistantUsageEntry(fixtureUsage({ input: 42 }), "a3"))
    leaf.id = "a3"
    expectParity(session, entries)
  })

  test("accumulator state is per session", () => {
    const a = [assistantUsageEntry(fixtureUsage({ input: 100 }), "a1")]
    const b = [assistantUsageEntry(fixtureUsage({ input: 700 }), "b1")]
    const sessionA = fakeSession(a, leafOf(a))
    const sessionB = fakeSession(b, leafOf(b))
    expectParity(sessionA, a)
    expectParity(sessionB, b)
    expectParity(sessionA, a)
  })
})
