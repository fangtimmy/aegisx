import { describe, expect, test } from "bun:test"

import { eq } from "drizzle-orm"

import { queueState, runQueue } from "../../src/db/schema"
import { RunActionError } from "../../src/run/errors"
import { createQueueService, parseQueueLaunchSpecs } from "../../src/run/queue"
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
function makeQueue(db: Db, launch: (id: string) => Promise<string>) {
  const launches: string[] = []
  const emergencies: string[] = []
  const notices: string[] = []
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
    onQueueEmergency: (eventId, line) =>
      emergencies.push(`${eventId}: ${line}`),
    onQueueNotice: (eventId, line) => notices.push(`${eventId}: ${line}`),
  })
  return { svc, launches, emergencies, notices }
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

describe("queue CRUD", () => {
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

  test("enqueue serializes the v9 launch specs into params; prompt keeps the strategy", async () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-a", eventId: "evt-1" })
      seedChallenge(db, { id: "ch-b", eventId: "evt-1" })
      const { svc } = makeQueue(db, async () => "run-x")
      svc.cancelDrain()
      const specs = {
        strategy: "run-level strategy",
        model: "openai/gpt-4o-mini",
        solverCount: 3,
        solvers: [
          { model: "a/b:off" },
          { prompt: "angle b", promptMode: "override" as const },
        ],
      }
      const item = svc.enqueue({
        eventId: "evt-1",
        challengeId: "ch-a",
        source: "scheduler",
        ...specs,
      })
      expect(item.prompt).toBe("run-level strategy")
      expect(item.params).toEqual(specs)
      // A prompt-only (legacy HTTP field) enqueue lands in both places too.
      const legacy = enqueue(svc, "evt-1", "ch-b", 1)
      expect(legacy.prompt).toBe("prompt-1")
      expect(legacy.params).toEqual({ strategy: "prompt-1" })
    } finally {
      close()
    }
  })

  test("parseQueueLaunchSpecs reads the specs back defensively", () => {
    expect(parseQueueLaunchSpecs("{}")).toEqual({})
    expect(parseQueueLaunchSpecs("not json")).toEqual({})
    expect(
      parseQueueLaunchSpecs(
        JSON.stringify({
          strategy: "s",
          model: "m",
          solverCount: 2,
          solvers: [{ model: "a" }],
        })
      )
    ).toEqual({
      strategy: "s",
      model: "m",
      solverCount: 2,
      solvers: [{ model: "a" }],
    })
    // Wrong shapes drop the affected key; bad solver entries are filtered.
    expect(
      parseQueueLaunchSpecs(
        JSON.stringify({
          strategy: 42,
          solverCount: -1,
          solvers: [{ bogus: 1 }, { prompt: "ok" }],
        })
      )
    ).toEqual({ solvers: [{ prompt: "ok" }] })
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

  test("pause/resume push a notice line; manual flips are marked", async () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      const { svc, notices } = makeQueue(db, async () => "run-x")
      svc.pause("evt-1") // default source: manual (the web UI sends nothing)
      expect(svc.stateOf("evt-1")).toBe("paused")
      expect(notices).toEqual(["evt-1: 队列已暂停（用户手动控制）"])
      svc.resume("evt-1", "scheduler")
      expect(svc.stateOf("evt-1")).toBe("running")
      expect(notices[1]).toBe("evt-1: 队列已恢复")
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

describe("queue drainer", () => {
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

  test("a launch failure marks the item failed and raises a queue emergency", async () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-a", eventId: "evt-1" })
      const { svc, emergencies } = makeQueue(db, async () => {
        throw new Error("container exploded")
      })
      svc.cancelDrain()
      const a = enqueue(svc, "evt-1", "ch-a", 1)
      await svc.drainOnce()
      expect(item(db, a.id).status).toBe("failed")
      expect(item(db, a.id).error).toContain("container exploded")
      expect(emergencies).toHaveLength(1)
      expect(emergencies[0]).toContain("evt-1: 启动失败：Test Challenge")
      expect(emergencies[0]).toContain("container exploded")
    } finally {
      close()
    }
  })

  test("a capacity rejection leaves the item pending (no failure)", async () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-a", eventId: "evt-1" })
      const { svc, emergencies } = makeQueue(db, async () => {
        throw new RunActionError("capacity", "full")
      })
      svc.cancelDrain()
      const a = enqueue(svc, "evt-1", "ch-a", 1)
      await svc.drainOnce()
      expect(item(db, a.id).status).toBe("pending")
      expect(emergencies).toHaveLength(0)
    } finally {
      close()
    }
  })

  test("queue-starved edge: pending 2→1 fires once; refill re-arms", async () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-a", eventId: "evt-1" })
      seedChallenge(db, { id: "ch-b", eventId: "evt-1" })
      seedChallenge(db, { id: "ch-c", eventId: "evt-1" })
      const { svc, emergencies } = makeQueue(db, async () => "run-x")
      svc.cancelDrain()
      const a = enqueue(svc, "evt-1", "ch-a", 1)
      const b = enqueue(svc, "evt-1", "ch-b", 2)
      expect(emergencies).toHaveLength(0) // 2 pending — no edge yet
      svc.remove(a.id) // 2 → 1: edge fires
      expect(emergencies).toHaveLength(1)
      expect(emergencies[0]).toContain("队列不足")
      svc.remove(b.id) // 1 → 0: already ≤1, no repeat
      expect(emergencies).toHaveLength(1)

      // Refill to ≥2 re-arms; another 2→1 crossing fires again.
      enqueue(svc, "evt-1", "ch-c", 3)
      const d = enqueue(svc, "evt-1", "ch-b", 4)
      expect(emergencies).toHaveLength(1)
      svc.remove(d.id)
      expect(emergencies).toHaveLength(2)
    } finally {
      close()
    }
  })

  test("initial single-item queue never fires the starved edge", async () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-a", eventId: "evt-1" })
      const { svc, emergencies } = makeQueue(db, async () => "run-x")
      svc.cancelDrain()
      enqueue(svc, "evt-1", "ch-a", 1)
      expect(emergencies).toHaveLength(0)
    } finally {
      close()
    }
  })

  test("a paused queue fires no starved emergency (the user stopped launches)", async () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-a", eventId: "evt-1" })
      seedChallenge(db, { id: "ch-b", eventId: "evt-1" })
      const { svc, emergencies, notices } = makeQueue(db, async () => "run-x")
      svc.cancelDrain()
      const a = enqueue(svc, "evt-1", "ch-a", 1)
      enqueue(svc, "evt-1", "ch-b", 2)
      svc.pause("evt-1")
      svc.remove(a.id) // 2→1 crossing while paused → silent
      expect(emergencies).toHaveLength(0)
      expect(notices).toEqual(["evt-1: 队列已暂停（用户手动控制）"])
      expect(svc.stateOf("evt-1")).toBe("paused")
    } finally {
      close()
    }
  })

  test("pause/resume are idempotent (no duplicate notice lines)", async () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      const { svc, notices } = makeQueue(db, async () => "run-x")
      svc.pause("evt-1")
      svc.pause("evt-1")
      svc.pause("evt-1", "scheduler")
      expect(notices).toEqual(["evt-1: 队列已暂停（用户手动控制）"])
      svc.resume("evt-1")
      svc.resume("evt-1")
      expect(notices).toEqual([
        "evt-1: 队列已暂停（用户手动控制）",
        "evt-1: 队列已恢复（用户手动控制）",
      ])
      expect(svc.stateOf("evt-1")).toBe("running")
    } finally {
      close()
    }
  })

  test("cancelPendingForChallenge cancels only that challenge's pending items", async () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-a", eventId: "evt-1" })
      seedChallenge(db, { id: "ch-b", eventId: "evt-1" })
      const { svc } = makeQueue(db, async () => "run-x")
      svc.cancelDrain()
      const a = enqueue(svc, "evt-1", "ch-a", 1)
      const b = enqueue(svc, "evt-1", "ch-b", 2)
      const cancelled = svc.cancelPendingForChallenge("evt-1", "ch-a")
      expect(cancelled).toBe(1)
      expect(item(db, a.id).status).toBe("cancelled")
      expect(item(db, b.id).status).toBe("pending")
      // Nothing pending on ch-a → second cancel is a no-op.
      expect(svc.cancelPendingForChallenge("evt-1", "ch-a")).toBe(0)
    } finally {
      close()
    }
  })
})
