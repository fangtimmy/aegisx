import { describe, expect, test } from "bun:test"

import { eq } from "drizzle-orm"

import type { Database } from "../../src/db"
import { challengeRemote, eventPlatforms } from "../../src/db/schema"
import type { CtfPlatformAdapter } from "../../src/platforms/core"
import { createPlatformTargets } from "../../src/platforms/targets"
import { createFakeClock } from "../../src/run/clock"
import { seedChallenge, seedEvent, setupDb } from "../helpers"
import { refine } from "../support"

const SOURCE_KEY = JSON.stringify(["stub", "https://ctf.example", "37"])

function seedTargetCapable(db: Database) {
  db.insert(eventPlatforms)
    .values({
      eventId: "evt-1",
      type: "ret2shell",
      baseUrl: "https://ctf.example",
      credential: "tok",
      remoteEventId: "37",
      sourceKey: SOURCE_KEY,
      lastSyncedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .run()
  db.insert(challengeRemote)
    .values({
      challengeId: "ch-1",
      eventId: "evt-1",
      sourceKey: SOURCE_KEY,
      remoteId: "1365",
      available: true,
      solved: false,
      targetSupported: true,
      targetIgnored: false,
      targetCount: 1,
      targetInfo: "[]",
      syncedAt: new Date().toISOString(),
    })
    .run()
}

/** Drain all pending microtasks (a macrotask boundary flushes the whole
 * microtask queue), letting targetAction run up to its poll timer. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

describe("platform targets → target-ready polling (fake clock)", () => {
  test("start polls at the interval until running, no real wait", async () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedTargetCapable(db)
      const clock = createFakeClock()
      let polls = 0
      const targets = createPlatformTargets(
        db,
        () =>
          db
            .select()
            .from(eventPlatforms)
            .where(eq(eventPlatforms.eventId, "evt-1"))
            .get(),
        () =>
          refine<CtfPlatformAdapter>({
            startTarget: async () => ({
              status: "starting",
              endpoints: [],
              expiresAt: null,
            }),
            getTarget: async () => {
              polls += 1
              return { status: "running", endpoints: [], expiresAt: null }
            },
          }),
        { clock }
      )

      const pending = targets.targetAction("ch-1", "start")
      await flushMicrotasks()
      // Nothing polled until the 1s cadence elapses.
      expect(polls).toBe(0)
      expect(clock.pendingCount()).toBe(1)
      clock.advance(999)
      expect(polls).toBe(0)
      clock.advance(1)
      const state = await pending
      expect(state.status).toBe("running")
      expect(polls).toBe(1)
    } finally {
      close()
    }
  })
})
