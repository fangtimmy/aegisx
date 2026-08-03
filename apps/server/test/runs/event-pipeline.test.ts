import { describe, expect, test } from "bun:test"
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type { SessionEntry } from "@earendil-works/pi-coding-agent"
import type { LiveEvent } from "../../../shared/live-event"
import { createRunEventPipeline } from "../../src/run/events"
import type { LiveBus } from "../../src/run/live"

type Committed = Extract<LiveEvent, { type: "message.committed" }>

/** A pipeline wired to a recording bus. Persistence is owned by the
 * SessionManager; the pipeline's `commitEntry` is driven by
 * DbSessionManager.onAppend (the authoritative "entry just persisted" signal,
 * since pi emits no equivalent event for regular messages). */
function setup() {
  const emitted: LiveEvent[] = []
  const bus = {
    emit: (_runId: string, event: LiveEvent) => emitted.push(event),
  } as unknown as LiveBus
  const pipeline = createRunEventPipeline({
    runId: "run-1",
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

describe("createRunEventPipeline commitEntry", () => {
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
