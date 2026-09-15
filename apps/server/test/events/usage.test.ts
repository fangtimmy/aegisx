import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { drizzle } from "drizzle-orm/bun-sqlite"

import { createApp } from "../../src/app"
import * as schema from "../../src/db/schema"
import { agents } from "../../src/db/schema"
import { responseJson } from "../../src/lib/guards"
import { seedSessionEntry } from "../helpers"
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
  const path = mkdtempSync(join(tmpdir(), "aegisx-usage-"))
  tempDirs.push(path)
  const instance = createApp({ dataDir: path })
  closeDatabases.push(instance.close)
  return { app: instance.app, dataDir: path }
}

/** Raw write connection to the same sqlite file (WAL). FKs off — the session
 * graph isn't under test, only the agentId-scoped usage aggregation. */
function seedDb(dataDir: string) {
  const raw = new Database(join(dataDir, "aegisx.sqlite"))
  raw.run("PRAGMA foreign_keys = OFF")
  return drizzle(raw, { schema })
}

/** Assistant-message usage payload (entry-usage.ts accumulator shape). */
function assistantUsage(input: number, output: number, cost: number) {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  }
}

function seedAgent(
  db: ReturnType<typeof seedDb>,
  eventId: string,
  id: string,
  role: "solver" | "orchestrator" = "solver"
) {
  db.insert(agents)
    .values({
      id,
      eventId,
      challengeId: role === "solver" ? "ch-1" : null,
      role,
      name: `agent-${id.slice(0, 8)}`,
      model: "aegisx-prov-1/gpt-4o-mini:off",
      systemPrompt: "sp",
      tools: "[]",
      status: "idle",
      sessionFile: null,
      prompt: null,
      source: "manual",
      timeoutMs: 3_600_000,
      deadlineAt: null,
      createdAt: "2025-01-01T00:00:00Z",
      startedAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    })
    .run()
}

function seedEntry(
  db: ReturnType<typeof seedDb>,
  agentId: string,
  seq: number,
  usage: ReturnType<typeof assistantUsage>
) {
  seedSessionEntry(db, {
    sessionId: `sess-${agentId}`,
    agentId,
    seq,
    id: `entry-${agentId}-${seq}`,
    createdAt: "2025-01-01T00:00:00Z",
    message: { role: "assistant", usage, timestamp: 0 },
    usage: {
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      cost: usage.cost.total,
    },
  })
}

describe("event usage API (session_entries.agentId aggregation)", () => {
  test("GET aggregates usage across every agent of the event (scheduler included)", async () => {
    const { app, dataDir } = createTestApp()
    const event = await responseJson<{ id: string }>(
      await app.request("/api/events", json("POST", { name: "Event" }))
    )
    const db = seedDb(dataDir)
    // Two solver agents + the scheduler agent.
    seedAgent(db, event.id, "agent-a")
    seedAgent(db, event.id, "agent-b")
    seedAgent(db, event.id, "sched-agent", "orchestrator")
    seedEntry(db, "agent-a", 1, assistantUsage(100, 50, 1))
    seedEntry(db, "agent-b", 2, assistantUsage(200, 75, 2))
    seedEntry(db, "sched-agent", 3, assistantUsage(300, 25, 0.5))

    const response = await app.request(`/api/events/${event.id}/usage`)
    expect(response.status).toBe(200)
    const { usage } = await responseJson<{
      usage: {
        input: number
        output: number
        cacheRead: number
        cacheWrite: number
        reasoning: number
        totalTokens: number
        cost: number
        turns: number
      }
    }>(response)
    expect(usage).toEqual({
      input: 600,
      output: 150,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      totalTokens: 750,
      cost: 3.5,
      turns: 3,
    })
  })

  test("GET scopes to the event (other events' usage does not leak)", async () => {
    const { app, dataDir } = createTestApp()
    const event = await responseJson<{ id: string }>(
      await app.request("/api/events", json("POST", { name: "Event" }))
    )
    const other = await responseJson<{ id: string }>(
      await app.request("/api/events", json("POST", { name: "Other" }))
    )
    const db = seedDb(dataDir)
    seedAgent(db, event.id, "agent-a")
    seedAgent(db, other.id, "other-agent")
    seedEntry(db, "agent-a", 1, assistantUsage(10, 10, 1))
    seedEntry(db, "other-agent", 2, assistantUsage(1000, 1000, 100))

    const response = await app.request(`/api/events/${event.id}/usage`)
    const { usage } = await responseJson<{ usage?: { input: number } }>(
      response
    )
    expect(usage?.input).toBe(10)
  })

  test("GET returns no usage key for an event without agents", async () => {
    const { app } = createTestApp()
    const event = await responseJson<{ id: string }>(
      await app.request("/api/events", json("POST", { name: "Empty" }))
    )
    const response = await app.request(`/api/events/${event.id}/usage`)
    expect(response.status).toBe(200)
    const body = await responseJson<Record<string, unknown>>(response)
    expect(body.usage).toBeUndefined()
  })

  test("GET 404s for an unknown event", async () => {
    const { app } = createTestApp()
    const response = await app.request("/api/events/nope/usage")
    expect(response.status).toBe(404)
  })
})
