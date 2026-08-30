import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { EventStats } from "@aegisx/shared"
import { drizzle } from "drizzle-orm/bun-sqlite"

import { createApp } from "../../src/app"
import {
  agents,
  challengeFlags,
  challengeRemote,
  challenges,
  channelMessages,
  sessionEntries,
  spawnQueue,
} from "../../src/db/schema"
import { responseJson } from "../../src/lib/guards"
import { json } from "../support"

const tempDirs: string[] = []
const closeDatabases: Array<() => void | Promise<void>> = []

afterEach(async () => {
  for (const close of closeDatabases.splice(0)) await close()
  for (const path of tempDirs.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

function createTestApp() {
  const path = mkdtempSync(join(tmpdir(), "aegisx-stats-"))
  tempDirs.push(path)
  const instance = createApp({ dataDir: path })
  closeDatabases.push(instance.close)
  return { app: instance.app, dataDir: path }
}

/** Raw write connection to the same sqlite file (WAL). FKs off — the stats
 * module is a read-side view; the seeded graphs bypass API validation. */
function seedDb(dataDir: string) {
  const raw = new Database(join(dataDir, "aegisx.sqlite"))
  raw.run("PRAGMA foreign_keys = OFF")
  return drizzle(raw)
}

function seedChallenge(
  db: ReturnType<typeof seedDb>,
  eventId: string,
  overrides: Partial<typeof challenges.$inferInsert> & { id: string }
) {
  db.insert(challenges)
    .values({
      eventId,
      name: overrides.id,
      description: "desc",
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
      ...overrides,
    })
    .run()
}

function seedAgent(
  db: ReturnType<typeof seedDb>,
  overrides: Partial<typeof agents.$inferInsert> & { id: string }
) {
  db.insert(agents)
    .values({
      eventId: "evt-x",
      challengeId: null,
      role: "solver",
      name: `agent-${overrides.id.slice(0, 8)}`,
      model: "aegisx-prov-1/model-a:off",
      systemPrompt: "sp",
      tools: "[]",
      status: "completed",
      sessionFile: null,
      prompt: null,
      source: "manual",
      timeoutMs: 3_600_000,
      deadlineAt: null,
      createdAt: "2025-01-01T00:00:00Z",
      startedAt: "2025-01-01T00:10:00Z",
      updatedAt: "2025-01-01T00:10:00Z",
      ...overrides,
    })
    .run()
}

function seedUsage(
  db: ReturnType<typeof seedDb>,
  agentId: string,
  seq: number,
  input: number,
  output: number,
  cost: number
) {
  db.insert(sessionEntries)
    .values({
      id: `entry-${agentId}-${seq}`,
      sessionId: `sess-${agentId}`,
      agentId,
      seq,
      type: "message",
      data: JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          usage: {
            input,
            output,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: input + output,
            cost: { total: cost },
          },
        },
      }),
      createdAt: "2025-01-01T00:00:00Z",
    })
    .run()
}

function seedToolResult(
  db: ReturnType<typeof seedDb>,
  agentId: string,
  seq: number,
  toolName: string
) {
  db.insert(sessionEntries)
    .values({
      id: `entry-tool-${agentId}-${seq}`,
      sessionId: `sess-${agentId}`,
      agentId,
      seq,
      type: "message",
      data: JSON.stringify({
        type: "message",
        message: { role: "toolResult", toolCallId: `t${seq}`, toolName },
      }),
      createdAt: "2025-01-01T00:00:00Z",
    })
    .run()
}

describe("event stats (GET /api/events/:eventId/stats)", () => {
  test("an event without data returns zeroed stats and null window", async () => {
    const { app } = createTestApp()
    const event = await responseJson<{ id: string }>(
      await app.request("/api/events", json("POST", { name: "Stats Event" }))
    )
    const response = await app.request(`/api/events/${event.id}/stats`)
    expect(response.status).toBe(200)
    const { stats } = await responseJson<{ stats: EventStats }>(response)
    expect(stats.window).toEqual({ start: null, end: null })
    expect(stats.overview).toMatchObject({
      challengesTotal: 0,
      challengesSolved: 0,
      pointsEarned: 0,
      attempts: 0,
      turns: 0,
      cost: 0,
    })
    expect(stats.scoreTimeline).toEqual([])
    expect(stats.modelBilling).toEqual([])
    expect(stats.concurrency).toEqual([])
    expect(stats.agentTimeline).toEqual([])
    expect(stats.messageActivity).toEqual([])
    expect(stats.toolUsage).toEqual([])
  })

  test("aggregates score, billing, concurrency, queue, messages, tools", async () => {
    const { app, dataDir } = createTestApp()
    const event = await responseJson<{ id: string }>(
      await app.request("/api/events", json("POST", { name: "Stats Event" }))
    )
    const db = seedDb(dataDir)

    seedChallenge(db, event.id, {
      id: "ch-1",
      points: 300,
      updatedAt: "2025-01-01T00:30:00Z",
    })
    seedChallenge(db, event.id, {
      id: "ch-2",
      points: 200,
      updatedAt: "2025-01-01T00:40:00Z",
    })
    // ch-2 solved by remote sync only (no local flag).
    db.insert(challengeRemote)
      .values({
        challengeId: "ch-2",
        eventId: event.id,
        sourceKey: "ctfd:test",
        remoteId: "2",
        solved: true,
        syncedAt: "2025-01-01T00:40:00Z",
      })
      .run()

    seedAgent(db, {
      id: "agent-a",
      eventId: event.id,
      challengeId: "ch-1",
      startedAt: "2025-01-01T00:10:00Z",
      completedAt: "2025-01-01T00:20:00Z",
      updatedAt: "2025-01-01T00:20:00Z",
    })
    seedAgent(db, {
      id: "agent-b",
      eventId: event.id,
      challengeId: "ch-1",
      source: "scheduler",
      lastTimeoutAt: "2025-01-01T00:18:00Z",
      startedAt: "2025-01-01T00:15:00Z",
      completedAt: "2025-01-01T00:25:00Z",
      updatedAt: "2025-01-01T00:25:00Z",
    })
    seedAgent(db, {
      id: "sched-1",
      eventId: event.id,
      role: "orchestrator",
      model: "aegisx-prov-1/model-b:off",
      startedAt: "2025-01-01T00:05:00Z",
      updatedAt: "2025-01-01T00:35:00Z",
    })

    // agent-a: model-a; agent-b: model-a; scheduler: model-b.
    seedUsage(db, "agent-a", 1, 100, 50, 1)
    seedUsage(db, "agent-b", 1, 200, 75, 2)
    seedUsage(db, "sched-1", 1, 300, 25, 0.5)
    seedToolResult(db, "agent-a", 2, "bash")
    seedToolResult(db, "agent-a", 3, "bash")
    seedToolResult(db, "agent-a", 4, "read")

    db.insert(challengeFlags)
      .values({
        id: "flag-1",
        challengeId: "ch-1",
        flag: "flag{a}",
        status: "accepted",
        source: "agent",
        agentId: "agent-a",
        createdAt: "2025-01-01T00:28:00Z",
        updatedAt: "2025-01-01T00:30:00Z",
      })
      .run()
    db.insert(challengeFlags)
      .values({
        id: "flag-2",
        challengeId: "ch-1",
        flag: "flag{bad}",
        status: "rejected",
        source: "agent",
        agentId: "agent-b",
        createdAt: "2025-01-01T00:12:00Z",
        updatedAt: "2025-01-01T00:12:00Z",
      })
      .run()

    db.insert(spawnQueue)
      .values({
        id: "q-1",
        eventId: event.id,
        ord: 0,
        challengeId: "ch-1",
        params: "{}",
        prompt: "p",
        source: "scheduler",
        status: "done",
        agentId: "agent-a",
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:10:00Z",
      })
      .run()
    db.insert(spawnQueue)
      .values({
        id: "q-2",
        eventId: event.id,
        ord: 1,
        challengeId: "ch-1",
        params: "{}",
        prompt: "p",
        source: "scheduler",
        status: "failed",
        createdAt: "2025-01-01T00:01:00Z",
        updatedAt: "2025-01-01T00:02:00Z",
      })
      .run()

    for (const createdAt of [
      "2025-01-01T01:05:00Z",
      "2025-01-01T01:20:00Z",
      "2025-01-01T02:10:00Z",
    ]) {
      db.insert(channelMessages)
        .values({
          channelKey: "team:ch-1",
          authorType: "agent",
          authorAgentId: "agent-a",
          authorName: "agent-a",
          body: "intel",
          meta: "{}",
          createdAt,
        })
        .run()
    }

    const response = await app.request(`/api/events/${event.id}/stats`)
    expect(response.status).toBe(200)
    const { stats } = await responseJson<{ stats: EventStats }>(response)

    // Window: first agent start → last activity (ch-2 remote sync update).
    expect(stats.window).toEqual({
      start: "2025-01-01T00:05:00Z",
      end: "2025-01-01T00:40:00Z",
    })

    expect(stats.overview).toMatchObject({
      challengesTotal: 2,
      challengesSolved: 2,
      pointsEarned: 500,
      pointsAvailable: 500,
      attempts: 2,
      attemptsActive: 0,
      inputTokens: 600,
      outputTokens: 150,
      turns: 3,
    })
    expect(stats.overview.cost).toBeCloseTo(3.5)

    // Cumulative score: flag on ch-1 first, remote-synced ch-2 second.
    expect(stats.scoreTimeline).toEqual([
      {
        time: "2025-01-01T00:30:00Z",
        challengeId: "ch-1",
        challengeName: "ch-1",
        points: 300,
        cumulative: 300,
        source: "agent",
      },
      {
        time: "2025-01-01T00:40:00Z",
        challengeId: "ch-2",
        challengeName: "ch-2",
        points: 200,
        cumulative: 500,
        source: "remote",
      },
    ])

    // Billing grouped by model, sorted by cost desc.
    expect(stats.modelBilling).toEqual([
      {
        model: "aegisx-prov-1/model-a:off",
        requests: 2,
        input: 300,
        output: 125,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 3,
      },
      {
        model: "aegisx-prov-1/model-b:off",
        requests: 1,
        input: 300,
        output: 25,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0.5,
      },
    ])

    // Concurrency step series from the two overlapping solver intervals.
    expect(stats.concurrency).toEqual([
      { time: "2025-01-01T00:10:00Z", running: 1 },
      { time: "2025-01-01T00:15:00Z", running: 2 },
      { time: "2025-01-01T00:20:00Z", running: 1 },
      { time: "2025-01-01T00:25:00Z", running: 0 },
    ])

    const ch1 = stats.challengeEfficiency.find((c) => c.challengeId === "ch-1")
    expect(ch1).toMatchObject({
      points: 300,
      solved: true,
      attempts: 2,
      tokens: 425,
      submissions: 2,
      rejectedSubmissions: 1,
      messages: 3,
      durationMs: 1_200_000,
    })
    const ch2 = stats.challengeEfficiency.find((c) => c.challengeId === "ch-2")
    expect(ch2).toMatchObject({ solved: true, attempts: 0, cost: 0 })

    expect(stats.spawnSource).toEqual({ scheduler: 1, manual: 1 })
    expect(stats.queue).toEqual({
      done: 1,
      failed: 1,
      cancelled: 0,
      avgWaitMs: 600_000,
    })

    expect(stats.messageActivity).toEqual([
      { bucket: "2025-01-01T01:00", count: 2 },
      { bucket: "2025-01-01T02:00", count: 1 },
    ])

    expect(stats.toolUsage).toEqual([
      { tool: "bash", calls: 2 },
      { tool: "read", calls: 1 },
    ])

    expect(stats.failures).toEqual({ timeouts: 1, aborted: 0, failed: 0 })

    // Timeline: scheduler first by start, solver spans with terminal ends.
    expect(stats.agentTimeline.map((a) => [a.id, a.start, a.end])).toEqual([
      ["sched-1", "2025-01-01T00:05:00Z", "2025-01-01T00:35:00Z"],
      ["agent-a", "2025-01-01T00:10:00Z", "2025-01-01T00:20:00Z"],
      ["agent-b", "2025-01-01T00:15:00Z", "2025-01-01T00:25:00Z"],
    ])
    expect(stats.agentTimeline[0].challengeId).toBeNull()
  })

  test("running holds its concurrency slot; idle ends at its last activity", async () => {
    const { app, dataDir } = createTestApp()
    const event = await responseJson<{ id: string }>(
      await app.request("/api/events", json("POST", { name: "Stats Event" }))
    )
    const db = seedDb(dataDir)

    seedChallenge(db, event.id, { id: "ch-1" })
    seedAgent(db, {
      id: "agent-run",
      eventId: event.id,
      challengeId: "ch-1",
      status: "running",
      completedAt: null,
      startedAt: "2025-01-01T00:10:00Z",
      updatedAt: "2025-01-01T00:10:00Z",
    })
    seedAgent(db, {
      id: "agent-idle",
      eventId: event.id,
      challengeId: "ch-1",
      status: "idle",
      completedAt: null,
      startedAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:05:00Z",
    })

    const response = await app.request(`/api/events/${event.id}/stats`)
    const { stats } = await responseJson<{ stats: EventStats }>(response)
    expect(stats.overview.attemptsActive).toBe(2)
    // running: only the opening step (slot held through the right edge);
    // idle: closed at updatedAt so a stale wait doesn't stretch the chart.
    expect(stats.concurrency).toEqual([
      { time: "2025-01-01T00:00:00Z", running: 1 },
      { time: "2025-01-01T00:05:00Z", running: 0 },
      { time: "2025-01-01T00:10:00Z", running: 1 },
    ])
    const idle = stats.agentTimeline.find((a) => a.id === "agent-idle")
    const run = stats.agentTimeline.find((a) => a.id === "agent-run")
    expect(idle?.end).toBe("2025-01-01T00:05:00Z")
    expect(run != null && run.end > run.start).toBe(true)
  })
})
