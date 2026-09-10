import { describe, expect, test } from "bun:test"

import { eq } from "drizzle-orm"

import type { Database } from "../../src/db"
import { queueState, spawnQueue } from "../../src/db/schema"
import { createFakeClock } from "../../src/run/clock"
import {
  createFleetWatchdog,
  type FleetStall,
} from "../../src/run/fleet-watchdog"
import {
  makeAgentService,
  now,
  seedAgent,
  seedChallenge,
  seedEvent,
  setupDb,
} from "../helpers"

/** One pending spawn item on the canonical event/challenge. */
function seedQueueItem(db: Database, id = "q-1") {
  db.insert(spawnQueue)
    .values({
      id,
      eventId: "evt-1",
      ord: 1,
      challengeId: "ch-1",
      params: "{}",
      timeoutMs: null,
      prompt: "go",
      source: "scheduler",
      status: "pending",
      agentId: null,
      error: null,
      createdAt: now(),
      updatedAt: now(),
    })
    .run()
}

function queueStatus(db: Database, eventId = "evt-1"): string | undefined {
  return db
    .select({ status: queueState.status })
    .from(queueState)
    .where(eq(queueState.eventId, eventId))
    .get()?.status
}

/** The watchdog reads only the DB, so the canonical event/challenge rows must
 * exist for agent/queue FK inserts. */
function seedWorld() {
  const store = setupDb()
  seedEvent(store.db)
  seedChallenge(store.db)
  return store
}

function watchdog(
  db: Database,
  clock: ReturnType<typeof createFakeClock>,
  unattended: boolean
) {
  const fired: FleetStall[] = []
  const wd = createFleetWatchdog({
    db,
    clock,
    unattended,
    stallMs: 1_000,
    isSchedulerPaused: () => false,
    onStalled: (stall) => fired.push(stall),
  })
  return { wd, fired }
}

describe("boot recovery: attended vs unattended", () => {
  test("attended boot pauses an event with visible queue items (default)", async () => {
    const h = makeAgentService({})
    try {
      seedQueueItem(h.db)
      await h.service.recoverOnBoot()
      expect(queueStatus(h.db)).toBe("paused")
    } finally {
      await h.close()
    }
  })

  test("unattended boot leaves the queue running and resumes draining", async () => {
    const clock = createFakeClock()
    const h = makeAgentService({ unattended: true, clock })
    try {
      seedQueueItem(h.db)
      await h.service.recoverOnBoot()
      // The forced pause is gone: no queue_state row means `running`.
      expect(queueStatus(h.db)).toBeUndefined()
      // And a drain was scheduled — advance past the 200ms debounce and let
      // the async launch settle: the pending item must be picked up.
      clock.advance(300)
      for (let i = 0; i < 50; i += 1) {
        const row = h.db
          .select({ status: spawnQueue.status })
          .from(spawnQueue)
          .where(eq(spawnQueue.id, "q-1"))
          .get()
        if (row?.status !== "pending") break
        await new Promise((r) => setTimeout(r, 10))
      }
      expect(
        h.db
          .select({ status: spawnQueue.status })
          .from(spawnQueue)
          .where(eq(spawnQueue.id, "q-1"))
          .get()?.status
      ).not.toBe("pending")
    } finally {
      await h.close()
    }
  })

  test("unattended boot preserves a pause the scheduler set on purpose", async () => {
    const clock = createFakeClock()
    const h = makeAgentService({ unattended: true, clock })
    try {
      seedQueueItem(h.db)
      h.db
        .insert(queueState)
        .values({ eventId: "evt-1", status: "paused", updatedAt: now() })
        .run()
      await h.service.recoverOnBoot()
      expect(queueStatus(h.db)).toBe("paused")
      clock.advance(300)
      await new Promise((r) => setTimeout(r, 20))
      // Still pending: a deliberately paused queue is not drained by boot.
      expect(
        h.db
          .select({ status: spawnQueue.status })
          .from(spawnQueue)
          .where(eq(spawnQueue.id, "q-1"))
          .get()?.status
      ).toBe("pending")
    } finally {
      await h.close()
    }
  })
})

describe("fleet watchdog: unattended parked-solver detection", () => {
  test("attended: an idle solver suppresses the alarm (unchanged)", () => {
    const store = seedWorld()
    try {
      seedAgent(store.db, { id: "a-idle", status: "idle" })
      seedQueueItem(store.db)
      const clock = createFakeClock()
      const { wd, fired } = watchdog(store.db, clock, false)
      wd.checkOnce()
      clock.advance(2_000)
      wd.checkOnce()
      expect(fired).toHaveLength(0)
      wd.close()
    } finally {
      store.close()
    }
  })

  test("unattended: pending work with only parked (idle) solvers fires", () => {
    const store = seedWorld()
    try {
      seedAgent(store.db, { id: "a-idle", status: "idle" })
      seedQueueItem(store.db)
      const clock = createFakeClock()
      const { wd, fired } = watchdog(store.db, clock, true)
      wd.checkOnce()
      clock.advance(2_000)
      wd.checkOnce()
      expect(fired).toHaveLength(1)
      expect(fired[0]?.pending).toBe(1)
      wd.close()
    } finally {
      store.close()
    }
  })

  test("unattended: a running solver is progress — no alarm", () => {
    const store = seedWorld()
    try {
      seedAgent(store.db, { id: "a-run", status: "running" })
      seedQueueItem(store.db)
      const clock = createFakeClock()
      const { wd, fired } = watchdog(store.db, clock, true)
      wd.checkOnce()
      clock.advance(2_000)
      wd.checkOnce()
      expect(fired).toHaveLength(0)
      wd.close()
    } finally {
      store.close()
    }
  })

  test("unattended: a planning (running) scheduler is activity — no alarm", () => {
    const store = seedWorld()
    try {
      seedAgent(store.db, {
        id: "sched",
        role: "orchestrator",
        challengeId: null,
        status: "running",
      })
      seedAgent(store.db, { id: "a-idle", status: "idle" })
      seedQueueItem(store.db)
      const clock = createFakeClock()
      const { wd, fired } = watchdog(store.db, clock, true)
      wd.checkOnce()
      clock.advance(2_000)
      wd.checkOnce()
      expect(fired).toHaveLength(0)
      wd.close()
    } finally {
      store.close()
    }
  })
})
