import { describe, expect, test } from "bun:test"
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type {
  AgentSessionEvent,
  SessionEntry,
} from "@earendil-works/pi-coding-agent"
import type { LiveEvent } from "../../../shared/live-event"
import { createRunEventPipeline } from "../../src/run/events"
import type { LiveBus } from "../../src/run/live"

type Committed = Extract<LiveEvent, { type: "message.committed" }>

/** A pipeline wired to a recording bus with a controllable session entry
 * source. 2A: persistence is owned by the SessionManager, so the pipeline only
 * translates events → SSE; committed messages come from diffing the session
 * tree (getSessionEntries) against already-emitted entry ids. */
function setup() {
  let entries: SessionEntry[] = []
  const emitted: LiveEvent[] = []
  const bus = {
    emit: (_runId: string, event: LiveEvent) => emitted.push(event),
  } as unknown as LiveBus
  const pipeline = createRunEventPipeline({
    runId: "run-1",
    agentId: "agent-1",
    bus,
    getSessionEntries: () => entries,
  })
  return {
    pipeline,
    emitted,
    setEntries: (next: SessionEntry[]) => {
      entries = next
    },
  }
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

describe("createRunEventPipeline committed emission", () => {
  test("message_end emits committed for new entries with positional seq", () => {
    const { pipeline, emitted, setEntries } = setup()
    setEntries([messageEntry("user", 1000, "e1")])

    pipeline.handle({
      type: "message_end",
      message: {} as AgentMessage,
    } as AgentSessionEvent)

    const committed = committedOf(emitted)
    expect(committed.length).toBe(1)
    expect(committed[0].message.seq).toBe(1)
    expect(committed[0].message.role).toBe("user")
  })

  test("re-handling does not re-emit already-emitted entries (dedup)", () => {
    const { pipeline, emitted, setEntries } = setup()
    setEntries([messageEntry("user", 1000, "e1")])

    pipeline.handle({
      type: "message_end",
      message: {} as AgentMessage,
    } as AgentSessionEvent)
    pipeline.handle({
      type: "agent_end",
      messages: [],
      willRetry: false,
    } as AgentSessionEvent)

    expect(committedOf(emitted).length).toBe(1)
  })

  test("multiple entries get monotonic seq matching their append order", () => {
    const { pipeline, emitted, setEntries } = setup()
    setEntries([
      messageEntry("user", 1000, "e1"),
      messageEntry("assistant", 2000, "e2"),
      messageEntry("toolResult", 3000, "e3"),
    ])

    pipeline.handle({
      type: "agent_end",
      messages: [],
      willRetry: false,
    } as AgentSessionEvent)

    const committed = committedOf(emitted)
    expect(committed.map((e) => e.message.seq)).toEqual([1, 2, 3])
    expect(committed.map((e) => e.message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
    ])
  })

  test("compaction entry is emitted as a system notice", () => {
    const { pipeline, emitted, setEntries } = setup()
    setEntries([
      messageEntry("assistant", 1000, "e1"),
      {
        type: "compaction",
        id: "c1",
        parentId: "e1",
        timestamp: new Date(2000).toISOString(),
        summary: "summary",
        firstKeptEntryId: "e1",
        tokensBefore: 180000,
      } as SessionEntry,
    ])

    pipeline.handle({
      type: "agent_end",
      messages: [],
      willRetry: false,
    } as AgentSessionEvent)

    const committed = committedOf(emitted)
    expect(committed.length).toBe(2)
    const notice = committed[1].message
    expect(notice.role).toBe("notice")
    expect(notice.seq).toBe(2)
  })

  test("non-message entries (model_change) are skipped but still count toward seq", () => {
    const { pipeline, emitted, setEntries } = setup()
    setEntries([
      {
        type: "model_change",
        id: "m1",
        parentId: null,
        timestamp: new Date(1000).toISOString(),
        provider: "p",
        modelId: "m",
      } as SessionEntry,
      messageEntry("user", 2000, "e1"),
    ])

    pipeline.handle({
      type: "message_end",
      message: {} as AgentMessage,
    } as AgentSessionEvent)

    const committed = committedOf(emitted)
    expect(committed.length).toBe(1)
    expect(committed[0].message.seq).toBe(2)
    expect(committed[0].message.role).toBe("user")
  })
})
