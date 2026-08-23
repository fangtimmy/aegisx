import { describe, expect, test } from "bun:test"

import { listActivity } from "../../src/activity/routes"
import type { Database } from "../../src/db"
import { challengeFlags, spawnQueue } from "../../src/db/schema"
import { now, seedAgent, seedChallenge, seedEvent, setupDb } from "../helpers"

function seedFlag(
  db: Database,
  overrides: Partial<typeof challengeFlags.$inferInsert> & {
    id?: string
    challengeId?: string
  } = {}
) {
  const id = overrides.id ?? "flag-1"
  db.insert(challengeFlags)
    .values({
      id,
      challengeId: overrides.challengeId ?? "ch-1",
      flag: "flag{test}",
      status: "accepted",
      source: "agent",
      agentId: null,
      createdAt: now(),
      updatedAt: now(),
      ...overrides,
    })
    .run()
  return id
}

function seedQueueItem(
  db: Database,
  overrides: Partial<typeof spawnQueue.$inferInsert> & {
    id?: string
    eventId?: string
    challengeId?: string
  } = {}
) {
  const id = overrides.id ?? "q-1"
  db.insert(spawnQueue)
    .values({
      id,
      eventId: overrides.eventId ?? "evt-1",
      ord: 1,
      challengeId: overrides.challengeId ?? "ch-1",
      params: "{}",
      timeoutMs: null,
      prompt: "",
      source: "manual",
      status: "pending",
      agentId: null,
      error: null,
      createdAt: now(),
      updatedAt: now(),
      ...overrides,
    })
    .run()
  return id
}

describe("activity feed", () => {
  test("derives spawn/end/timeout from agents, newest first", () => {
    const { db, close } = setupDb()
    seedEvent(db)
    seedChallenge(db)
    seedAgent(db, {
      id: "agent-2",
      status: "completed",
      completedAt: "2025-01-01T02:00:00.000Z",
      summary: "solved with ret2libc",
      createdAt: "2025-01-01T01:00:00.000Z",
      updatedAt: now(),
    })
    seedAgent(db, {
      id: "agent-3",
      lastTimeoutAt: "2025-01-01T03:00:00.000Z",
      createdAt: "2025-01-01T00:30:00.000Z",
      updatedAt: now(),
    })
    const feed = listActivity(db, 50)
    const kinds = feed.items.map((item) => item.kind)
    expect(kinds).toEqual(["timeout", "agentEnd", "agentSpawn", "agentSpawn"])

    const end = feed.items[1]
    expect(end.id).toBe("agent:agent-2:end")
    expect(end.agentStatus).toBe("completed")
    expect(end.summary).toBe("solved with ret2libc")
    expect(end.challengeName).toBe("Test Challenge")
    expect(end.eventName).toBe("Test Event")
    close()
  })

  test("includes accepted flags and failed queue items, skips other states", () => {
    const { db, close } = setupDb()
    seedEvent(db)
    seedChallenge(db)
    seedAgent(db, { id: "agent-1" })
    seedFlag(db, { id: "flag-ok", createdAt: "2025-01-01T04:00:00.000Z" })
    seedFlag(db, {
      id: "flag-rej",
      flag: "flag{wrong}",
      status: "rejected",
      createdAt: "2025-01-01T05:00:00.000Z",
    })
    seedQueueItem(db, {
      id: "q-failed",
      status: "failed",
      error: "capacity full",
      updatedAt: "2025-01-01T06:00:00.000Z",
    })
    const feed = listActivity(db, 50)
    const kinds = feed.items.map((item) => item.kind)
    expect(kinds).toEqual(["queueFailed", "flag", "agentSpawn"])

    const failed = feed.items[0]
    expect(failed.summary).toBe("capacity full")
    const flag = feed.items[1]
    expect(flag.flag).toBe("flag{test}")
    close()
  })

  test("limit truncates after the merge; scheduler agent carries null challenge", () => {
    const { db, close } = setupDb()
    for (let i = 0; i < 5; i++) {
      const eventId = seedEvent(db, `evt-${i}`)
      seedAgent(db, {
        id: `agent-${i}`,
        eventId,
        challengeId: null,
        role: "orchestrator",
        createdAt: `2025-01-01T0${i}:00:00.000Z`,
        updatedAt: now(),
      })
    }
    const feed = listActivity(db, 3)
    expect(feed.items).toHaveLength(3)
    expect(feed.items.every((item) => item.challengeId === null)).toBeTrue()
    expect(feed.items[0].time > feed.items[2].time).toBeTrue()
    close()
  })
})
