import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { drizzle } from "drizzle-orm/bun-sqlite"

import { createApp } from "../../src/app"
import { runs, sessionEntries } from "../../src/db/schema"
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
 * graph isn't under test, only the runId-scoped usage aggregation. */
function seedDb(dataDir: string) {
  const raw = new Database(join(dataDir, "aegisx.sqlite"))
  raw.run("PRAGMA foreign_keys = OFF")
  return drizzle(raw)
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

function seedRun(
  db: ReturnType<typeof seedDb>,
  eventId: string,
  id: string,
  scopeType: "challenge" | "event" = "challenge"
) {
  db.insert(runs)
    .values({
      id,
      scopeType,
      eventId,
      status: "closed",
      model: "openai/gpt-4o-mini:off",
      image: "img",
      cpus: 1,
      memoryMb: 512,
      pidsLimit: 64,
      containerName: "c",
      workspacePath: "w",
      sessionDir: "s",
      source: "manual",
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    })
    .run()
}

function seedEntry(
  db: ReturnType<typeof seedDb>,
  runId: string,
  seq: number,
  usage: ReturnType<typeof assistantUsage>
) {
  db.insert(sessionEntries)
    .values({
      id: `entry-${seq}`,
      sessionId: "sess-1",
      agentId: "agent-1",
      runId,
      seq,
      type: "message",
      data: JSON.stringify({
        type: "message",
        message: { role: "assistant", usage, timestamp: 0 },
      }),
      createdAt: "2025-01-01T00:00:00Z",
    })
    .run()
}

describe("event usage API (spec §10, session_entries.runId aggregation)", () => {
  test("GET aggregates usage across every run of the event (scheduler included)", async () => {
    const { app, dataDir } = createTestApp()
    const event = (await (
      await app.request("/api/events", json("POST", { name: "Event" }))
    ).json()) as { id: string }
    const db = seedDb(dataDir)
    // Two challenge runs + the event-scope scheduler run.
    seedRun(db, event.id, "run-a")
    seedRun(db, event.id, "run-b")
    seedRun(db, event.id, "sched-run", "event")
    seedEntry(db, "run-a", 1, assistantUsage(100, 50, 1))
    seedEntry(db, "run-b", 2, assistantUsage(200, 75, 2))
    seedEntry(db, "sched-run", 3, assistantUsage(300, 25, 0.5))

    const response = await app.request(`/api/events/${event.id}/usage`)
    expect(response.status).toBe(200)
    const { usage } = (await response.json()) as {
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
    }
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
    const event = (await (
      await app.request("/api/events", json("POST", { name: "Event" }))
    ).json()) as { id: string }
    const other = (await (
      await app.request("/api/events", json("POST", { name: "Other" }))
    ).json()) as { id: string }
    const db = seedDb(dataDir)
    seedRun(db, event.id, "run-a")
    seedRun(db, other.id, "other-run")
    seedEntry(db, "run-a", 1, assistantUsage(10, 10, 1))
    seedEntry(db, "other-run", 2, assistantUsage(1000, 1000, 100))

    const response = await app.request(`/api/events/${event.id}/usage`)
    const { usage } = (await response.json()) as { usage?: { input: number } }
    expect(usage?.input).toBe(10)
  })

  test("GET returns no usage key for an event without runs", async () => {
    const { app } = createTestApp()
    const event = (await (
      await app.request("/api/events", json("POST", { name: "Empty" }))
    ).json()) as { id: string }
    const response = await app.request(`/api/events/${event.id}/usage`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body.usage).toBeUndefined()
  })

  test("GET 404s for an unknown event", async () => {
    const { app } = createTestApp()
    const response = await app.request("/api/events/nope/usage")
    expect(response.status).toBe(404)
  })
})
