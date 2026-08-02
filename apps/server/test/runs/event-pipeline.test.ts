import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent"
import type { LiveEvent } from "../../../shared/live-event"
import { createDatabase } from "../../src/db"
import {
  agents,
  challenges,
  events,
  runEvents,
  runs,
} from "../../src/db/schema"
import { createRunEventPipeline } from "../../src/run/events"
import type { LiveBus } from "../../src/run/live"

const tempDirs: string[] = []
const releaseFns: Array<() => void> = []

afterEach(() => {
  for (const release of releaseFns.splice(0)) release()
  for (const dir of tempDirs.splice(0)) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  }
})

type Committed = Extract<LiveEvent, { type: "message.committed" }>

/** Minimal FK chain (event -> challenge -> run -> agent) so run_events insert
 * satisfies its foreign keys, then a pipeline wired to a recording bus. */
function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), "aegisx-run-pipeline-"))
  tempDirs.push(dataDir)
  const { db, releaseLock } = createDatabase(dataDir)
  releaseFns.push(releaseLock)

  const now = new Date().toISOString()
  db.insert(events)
    .values({ id: "evt", name: "E", createdAt: now, updatedAt: now })
    .run()
  db.insert(challenges)
    .values({
      id: "ch",
      eventId: "evt",
      name: "C",
      description: "D",
      createdAt: now,
      updatedAt: now,
    })
    .run()
  db.insert(runs)
    .values({
      id: "run-1",
      challengeId: "ch",
      status: "running",
      provider: "p",
      modelId: "m",
      thinkingLevel: "off",
      image: "i",
      cpus: 1,
      memoryMb: 512,
      pidsLimit: 100,
      containerName: "c",
      workspacePath: "w",
      sessionDir: "s",
      createdAt: now,
      updatedAt: now,
    })
    .run()
  db.insert(agents)
    .values({
      id: "agent-1",
      runId: "run-1",
      role: "main",
      status: "running",
      createdAt: now,
      updatedAt: now,
    })
    .run()

  const emitted: LiveEvent[] = []
  const bus = {
    emit: (_runId: string, event: LiveEvent) => {
      emitted.push(event)
    },
  } as unknown as LiveBus

  const pipeline = createRunEventPipeline({
    runId: "run-1",
    agentId: "agent-1",
    db,
    bus,
  })
  return { db, emitted, pipeline }
}

const committedOf = (emitted: LiveEvent[]) =>
  emitted.filter((e): e is Committed => e.type === "message.committed")

describe("createRunEventPipeline commit dedup", () => {
  test("re-committing the same message emits once with the real seq", () => {
    const { db, emitted, pipeline } = setup()

    // normalizeMessage assigns seq: 0; commit() must overwrite it with the DB seq
    // on first insert and NOT re-emit (with seq still 0) on the duplicate calls
    // that turn_end / agent_end make.
    const assistant = {
      role: "assistant" as const,
      id: "agent-1:assistant:1000",
      seq: 0,
      agentId: "agent-1",
      createdAt: new Date(1000).toISOString(),
      content: [{ type: "text" as const, text: "hi" }],
      timestamp: 1000,
    }
    pipeline.commit(assistant)
    pipeline.commit(assistant)
    pipeline.commit(assistant)

    const committed = committedOf(emitted)
    expect(committed.length).toBe(1)
    expect(committed[0].message.seq).toBe(1)

    const rows = db.select().from(runEvents).all()
    expect(rows.length).toBe(1)
    expect(rows[0].seq).toBe(1)
  })

  test("distinct messages each emit once with monotonic seq", () => {
    const { emitted, pipeline } = setup()

    const mk = (ts: number) => ({
      role: "assistant" as const,
      id: `agent-1:assistant:${ts}`,
      seq: 0,
      agentId: "agent-1",
      createdAt: new Date(ts).toISOString(),
      content: [{ type: "text" as const, text: `m${ts}` }],
      timestamp: ts,
    })
    pipeline.commit(mk(1000))
    pipeline.commit(mk(2000))
    pipeline.commit(mk(3000))

    const committed = committedOf(emitted)
    expect(committed.length).toBe(3)
    expect(committed.map((e) => e.message.seq)).toEqual([1, 2, 3])
  })

  test("message_end + turn_end + agent_end reconcile without duplicate emits", () => {
    const { db, emitted, pipeline } = setup()

    const assistantMsg = {
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      timestamp: 1100,
      stopReason: "stop",
    } as unknown as AgentMessage

    pipeline.handle({
      type: "message_end",
      message: assistantMsg,
    } as AgentSessionEvent)
    pipeline.handle({
      type: "turn_end",
      message: assistantMsg,
      toolResults: [],
    } as AgentSessionEvent)
    pipeline.handle({
      type: "agent_end",
      messages: [assistantMsg],
      willRetry: false,
    } as AgentSessionEvent)

    const committed = committedOf(emitted)
    expect(committed.length).toBe(1)
    expect(committed[0].message.seq).toBe(1)
    expect(committed[0].message.id).toBe("agent-1:assistant:1100")

    const rows = db.select().from(runEvents).all()
    expect(rows.length).toBe(1)
  })
})
