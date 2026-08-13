import { describe, expect, test } from "bun:test"

import { eq } from "drizzle-orm"

import { runQueue } from "../../src/db/schema"
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
  extra: { orchestration?: string; status?: string } = {}
) {
  return svc.enqueue({
    eventId,
    challengeId,
    orchestration: extra.orchestration ?? "classic",
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

  test("enqueue upserts by (challenge, orchestration): resets done/failed to pending", async () => {
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
        orchestration: "classic",
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

      const running = enqueue(svc, "evt-1", "ch-a", 2, {
        orchestration: "trio",
      })
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
