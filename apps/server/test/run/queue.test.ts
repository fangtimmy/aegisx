import { describe, expect, test } from "bun:test"

import { eq } from "drizzle-orm"

import { queueState, runQueue } from "../../src/db/schema"
import { RunActionError } from "../../src/run/errors"
import { createQueueService } from "../../src/run/queue"
import {
  flatSettings,
  seedChallenge,
  seedEvent,
  seedRun,
  setupDb,
  now,
} from "../helpers"

type Db = ReturnType<typeof setupDb>["db"]

function item(db: Db, id: string) {
  return db.select().from(runQueue).where(eq(runQueue.id, id)).get()!
}

/** QueueService with a stubbed launch (records calls, controls outcome). */
function makeQueue(
  db: Db,
  launch: (id: string) => Promise<string>,
  onFail?: (eventId: string, error: string) => void
) {
  const launches: string[] = []
  const failures: Array<{ eventId: string; error: string }> = []
  const svc = createQueueService({
    db,
    getSettings: flatSettings,
    isDisposed: () => false,
    launch: async (row) => {
      launches.push(row.id)
      const runId = await launch(row.id)
      // Satisfy the run_queue.runId → runs FK for the markRunning UPDATE.
      seedRun(db, {
        id: runId,
        eventId: row.eventId,
        challengeId: row.challengeId,
      })
      return runId
    },
    onLaunchFailed: (eventId, _row, error) => {
      failures.push({ eventId, error })
      onFail?.(eventId, error)
    },
  })
  return { svc, launches, failures }
}

function enqueue(
  svc: ReturnType<typeof makeQueue>["svc"],
  eventId: string,
  challengeId: string,
  ord = 0,
  extra: { status?: string } = {}
) {
  return svc.enqueue({
    eventId,
    challengeId,
    source: "manual",
    prompt: `prompt-${ord}`,
    ...extra,
  })
}

describe("queue CRUD (spec §8.1)", () => {
  test("enqueue assigns increasing ord; list returns pending+running+failed FIFO", async () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-a", eventId: "evt-1" })
      seedChallenge(db, { id: "ch-b", eventId: "evt-1" })
      const { svc } = makeQueue(db, async () => "run-x")
      // Cancel the debounced drain so list() is stable.
      svc.cancelDrain()
      const a = enqueue(svc, "evt-1", "ch-a", 1)
      const b = enqueue(svc, "evt-1", "ch-b", 2)
      expect([a.ord, b.ord]).toEqual([1, 2])
      const list = svc.list("evt-1")
      expect(list.map((i) => i.challengeId)).toEqual(["ch-a", "ch-b"])
    } finally {
      close()
    }
  })

  test("enqueue upserts by challenge: resets done/failed to pending", async () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-a", eventId: "evt-1" })
      seedChallenge(db, { id: "ch-b", eventId: "evt-1" })
      const { svc } = makeQueue(db, async () => "run-x")
      svc.cancelDrain()
      const first = enqueue(svc, "evt-1", "ch-a", 1)
      // Force it to done, then re-enqueue → same row, status pending, new ord.
      seedRun(db, { id: "r-old", eventId: "evt-1", challengeId: "ch-a" })
      db.update(runQueue)
        .set({ status: "done", runId: "r-old", updatedAt: now() })
        .where(eq(runQueue.id, first.id))
        .run()
      enqueue(svc, "evt-1", "ch-b", 2) // bump max ord
      const re = svc.enqueue({
        eventId: "evt-1",
        challengeId: "ch-a",
        source: "manual",
        prompt: "new-strategy",
      })
      expect(re.id).toBe(first.id)
      expect(re.status).toBe("pending")
      expect(re.runId).toBeNull()
      expect(re.prompt).toBe("new-strategy")
    } finally {
      close()
    }
  })

  test("remove rejects a running item; allows pending/done/failed", async () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-a", eventId: "evt-1" })
      const { svc } = makeQueue(db, async () => "run-x")
      svc.cancelDrain()
      const pending = enqueue(svc, "evt-1", "ch-a", 1)
      svc.remove(pending.id) // ok
      expect(item(db, pending.id)).toBeUndefined()

      const running = enqueue(svc, "evt-1", "ch-a", 2)
      seedRun(db, { id: "r1", eventId: "evt-1", challengeId: "ch-a" })
      db.update(runQueue)
        .set({ status: "running", runId: "r1", updatedAt: now() })
        .where(eq(runQueue.id, running.id))
        .run()
      expect(() => svc.remove(running.id)).toThrow(RunActionError)
    } finally {
      close()
    }
  })

  test("update edits only pending items", async () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-a", eventId: "evt-1" })
      const { svc } = makeQueue(db, async () => "run-x")
      svc.cancelDrain()
      const pending = enqueue(svc, "evt-1", "ch-a", 1)
      const updated = svc.update(pending.id, {
        prompt: "edited",
        timeoutMs: 99,
      })
      expect(updated.prompt).toBe("edited")
      expect(updated.timeoutMs).toBe(99)

      const running = enqueue(svc, "evt-1", "ch-a", 2)
      db.update(runQueue)
        .set({ status: "running", updatedAt: now() })
        .where(eq(runQueue.id, running.id))
        .run()
      expect(() => svc.update(running.id, { prompt: "x" })).toThrow(
        RunActionError
      )
    } finally {
      close()
    }
  })

  test("reorder reassigns ord by position (pending only)", async () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-a", eventId: "evt-1" })
      seedChallenge(db, { id: "ch-b", eventId: "evt-1" })
      seedChallenge(db, { id: "ch-c", eventId: "evt-1" })
      const { svc } = makeQueue(db, async () => "run-x")
      svc.cancelDrain()
      const a = enqueue(svc, "evt-1", "ch-a", 1)
      const b = enqueue(svc, "evt-1", "ch-b", 2)
      const c = enqueue(svc, "evt-1", "ch-c", 3)
      svc.reorder("evt-1", [c.id, a.id, b.id])
      const list = svc.list("evt-1")
      expect(list.map((i) => i.id)).toEqual([c.id, a.id, b.id])
    } finally {
      close()
    }
  })

  test("markDone is guarded by (id, runId, running)", async () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-a", eventId: "evt-1" })
      const { svc } = makeQueue(db, async () => "run-x")
      svc.cancelDrain()
      const it = enqueue(svc, "evt-1", "ch-a", 1)
      seedRun(db, { id: "r1", eventId: "evt-1", challengeId: "ch-a" })
      db.update(runQueue)
        .set({ status: "running", runId: "r1", updatedAt: now() })
        .where(eq(runQueue.id, it.id))
        .run()
      // Wrong runId → no-op.
      svc.markDone(it.id, "other-run")
      expect(item(db, it.id).status).toBe("running")
      // Correct guard → done.
      svc.markDone(it.id, "r1")
      expect(item(db, it.id).status).toBe("done")
    } finally {
      close()
    }
  })
})

describe("queue per-event state (W2.1)", () => {
  test("stateOf defaults to running; pause/resume round-trip via upsert", async () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      const { svc } = makeQueue(db, async () => "run-x")
      expect(svc.stateOf("evt-1")).toBe("running")
      svc.pause("evt-1")
      expect(svc.stateOf("evt-1")).toBe("paused")
      svc.resume("evt-1")
      expect(svc.stateOf("evt-1")).toBe("running")
      // No row = running; resume after pause leaves an explicit running row.
      const row = db
        .select()
        .from(queueState)
        .where(eq(queueState.eventId, "evt-1"))
        .get()
      expect(row?.status).toBe("running")
    } finally {
      close()
    }
  })

  test("drain skips a paused event's pending items; resume drains them", async () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedEvent(db, "evt-2")
      seedChallenge(db, { id: "ch-a", eventId: "evt-1" })
      seedChallenge(db, { id: "ch-b", eventId: "evt-2" })
      let n = 0
      const { svc, launches } = makeQueue(db, async () => `run-${++n}`)
      svc.cancelDrain()
      const a = svc.enqueue({
        eventId: "evt-1",
        challengeId: "ch-a",
        source: "manual",
        prompt: "p",
      })
      const b = svc.enqueue({
        eventId: "evt-2",
        challengeId: "ch-b",
        source: "manual",
        prompt: "p",
      })
      svc.pause("evt-1")
      await svc.drainOnce()
      // Only evt-2's item launches; evt-1's stays pending (still visible).
      expect(launches).toEqual([b.id])
      expect(item(db, a.id).status).toBe("pending")
      expect(item(db, b.id).status).toBe("running")
      // Resume → the pending item now launches.
      svc.resume("evt-1")
      await svc.drainOnce()
      expect(launches).toEqual([b.id, a.id])
      expect(item(db, a.id).status).toBe("running")
    } finally {
      close()
    }
  })

  test("pause does not touch an already-running item (pause ≠ kill)", async () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-a", eventId: "evt-1" })
      let n = 0
      const { svc, launches } = makeQueue(db, async () => `run-${++n}`)
      svc.cancelDrain()
      const a = svc.enqueue({
        eventId: "evt-1",
        challengeId: "ch-a",
        source: "manual",
        prompt: "p",
      })
      await svc.drainOnce() // launches a → running
      svc.pause("evt-1")
      await svc.drainOnce()
      expect(launches).toHaveLength(1) // no re-launch
      expect(item(db, a.id).status).toBe("running")
    } finally {
      close()
    }
  })

  test("enqueue/edit/reorder/remove still work on a paused event", async () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-a", eventId: "evt-1" })
      const { svc } = makeQueue(db, async () => "run-x")
      svc.cancelDrain()
      svc.pause("evt-1")
      const a = enqueue(svc, "evt-1", "ch-a", 1)
      const updated = svc.update(a.id, { prompt: "edited" })
      expect(updated.prompt).toBe("edited")
      expect(svc.list("evt-1").map((i) => i.id)).toEqual([a.id])
      svc.remove(a.id)
      expect(svc.list("evt-1")).toHaveLength(0)
    } finally {
      close()
    }
  })
})

describe("queue drainer (spec §8.2)", () => {
  test("drainOnce launches pending items FIFO and marks them running", async () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-a", eventId: "evt-1" })
      seedChallenge(db, { id: "ch-b", eventId: "evt-1" })
      let n = 0
      const { svc, launches } = makeQueue(db, async () => `run-${++n}`)
      svc.cancelDrain()
      const a = enqueue(svc, "evt-1", "ch-a", 1)
      const b = enqueue(svc, "evt-1", "ch-b", 2)
      await svc.drainOnce()
      expect(launches).toEqual([a.id, b.id])
      expect(item(db, a.id).status).toBe("running")
      expect(item(db, a.id).runId).toBe("run-1")
      expect(item(db, b.id).status).toBe("running")
    } finally {
      close()
    }
  })

  test("a launch failure marks the item failed and notifies the scheduler", async () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-a", eventId: "evt-1" })
      const { svc, failures } = makeQueue(
        db,
        async () => {
          throw new Error("container exploded")
        },
        (eventId) => expect(eventId).toBe("evt-1")
      )
      svc.cancelDrain()
      const a = enqueue(svc, "evt-1", "ch-a", 1)
      await svc.drainOnce()
      expect(item(db, a.id).status).toBe("failed")
      expect(item(db, a.id).error).toContain("container exploded")
      expect(failures).toHaveLength(1)
    } finally {
      close()
    }
  })

  test("a capacity rejection leaves the item pending (no failure)", async () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-a", eventId: "evt-1" })
      const { svc, failures } = makeQueue(db, async () => {
        throw new RunActionError("capacity", "full")
      })
      svc.cancelDrain()
      const a = enqueue(svc, "evt-1", "ch-a", 1)
      await svc.drainOnce()
      expect(item(db, a.id).status).toBe("pending")
      expect(failures).toHaveLength(0)
    } finally {
      close()
    }
  })
})
