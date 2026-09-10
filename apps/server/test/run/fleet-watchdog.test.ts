import { describe, expect, test } from "bun:test"

import { eq } from "drizzle-orm"

import { agents, queueState, spawnQueue } from "../../src/db/schema"
import { createFakeClock } from "../../src/run/clock"
import {
  FLEET_STALL_MS,
  FLEET_WATCHDOG_INTERVAL_MS,
  createFleetWatchdog,
  type FleetStall,
} from "../../src/run/fleet-watchdog"
import { now, seedAgent, seedChallenge, seedEvent, setupDb } from "../helpers"

type Db = ReturnType<typeof setupDb>["db"]

let ord = 0

function seedPending(db: Db, eventId = "evt-1", updatedAt = now()): void {
  ord += 1
  db.insert(spawnQueue)
    .values({
      id: `q-${ord}`,
      eventId,
      ord,
      challengeId: "ch-1",
      params: "{}",
      timeoutMs: null,
      prompt: "",
      source: "scheduler",
      status: "pending",
      agentId: null,
      error: null,
      createdAt: updatedAt,
      updatedAt,
    })
    .run()
}

function makeWatchdog(
  db: Db,
  opts: { schedulerPaused?: boolean; tickMs?: number; stallMs?: number } = {}
) {
  const clock = createFakeClock()
  const stalls: FleetStall[] = []
  const watchdog = createFleetWatchdog({
    db,
    clock,
    stallMs: opts.stallMs ?? 1_000,
    intervalMs: opts.tickMs ?? 500,
    isSchedulerPaused: () => opts.schedulerPaused ?? false,
    onStalled: (stall) => stalls.push(stall),
  })
  return { clock, stalls, watchdog }
}

describe("fleet watchdog (event-level vital signs)", () => {
  test("fires once per stall episode and resets when pending clears", () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedPending(db)
      seedPending(db)
      const { clock, stalls, watchdog } = makeWatchdog(db)
      watchdog.start()

      clock.advance(500) // observe: condition starts
      expect(stalls).toHaveLength(0)
      clock.advance(500) // 500ms stalled < 1000ms
      expect(stalls).toHaveLength(0)
      clock.advance(500) // 1000ms → fire
      expect(stalls).toEqual([
        { eventId: "evt-1", pending: 2, stalledMs: 1_000 },
      ])

      clock.advance(2_000) // fired: stays silent
      expect(stalls).toHaveLength(1)

      // Pending clears → state resets; a later backlog is a NEW episode.
      db.delete(spawnQueue).run()
      clock.advance(500)
      seedPending(db)
      clock.advance(500) // observe again
      clock.advance(1_000) // 1000ms → fire again
      expect(stalls).toHaveLength(2)
      watchdog.close()
    } finally {
      close()
    }
  })

  test("a paused queue never fires; resuming re-arms", () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedPending(db)
      db.insert(queueState)
        .values({ eventId: "evt-1", status: "paused", updatedAt: now() })
        .run()
      const { clock, stalls, watchdog } = makeWatchdog(db)
      watchdog.start()
      clock.advance(10_000)
      expect(stalls).toHaveLength(0)

      db.update(queueState)
        .set({ status: "running", updatedAt: now() })
        .where(eq(queueState.eventId, "evt-1"))
        .run()
      clock.advance(500) // observe
      clock.advance(1_000) // stall window reached
      expect(stalls).toHaveLength(1)
      watchdog.close()
    } finally {
      close()
    }
  })

  test("a live solver suppresses the alarm; its terminal state re-arms", () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedAgent(db, { id: "solver", status: "idle" })
      seedPending(db)
      const { clock, stalls, watchdog } = makeWatchdog(db)
      watchdog.start()
      clock.advance(10_000)
      expect(stalls).toHaveLength(0)

      db.update(agents)
        .set({ status: "completed", updatedAt: now() })
        .where(eq(agents.id, "solver"))
        .run()
      clock.advance(500)
      clock.advance(1_000)
      expect(stalls).toHaveLength(1)
      watchdog.close()
    } finally {
      close()
    }
  })

  test("drain progress (a queue change) resets the stall window", () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedPending(db)
      const { clock, stalls, watchdog } = makeWatchdog(db)
      watchdog.start()

      clock.advance(500) // observe
      // A change to the pending row is progress: the window restarts.
      db.update(spawnQueue)
        .set({ updatedAt: new Date(clock.now()).toISOString() })
        .run()
      clock.advance(1_000) // 1000ms since progress (not since observe)
      expect(stalls).toHaveLength(0)
      clock.advance(500) // now 1500ms since progress
      expect(stalls).toHaveLength(1)
      watchdog.close()
    } finally {
      close()
    }
  })

  test("a disabled scheduler is skipped silently", () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedPending(db)
      const { clock, stalls, watchdog } = makeWatchdog(db, {
        schedulerPaused: true,
      })
      watchdog.start()
      clock.advance(10_000)
      expect(stalls).toHaveLength(0)
      watchdog.close()
    } finally {
      close()
    }
  })

  test("cadence constants stay put", () => {
    expect(FLEET_WATCHDOG_INTERVAL_MS).toBe(2 * 60_000)
    expect(FLEET_STALL_MS).toBe(10 * 60_000)
  })
})
