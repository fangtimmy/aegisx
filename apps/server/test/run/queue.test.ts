import { afterEach, describe, expect, test } from "bun:test"

import { eq } from "drizzle-orm"

import { queueState, spawnQueue, challengeFlags } from "../../src/db/schema"
import { RunActionError } from "../../src/run/errors"
import { createQueueService, parseSpawnQueueParams } from "../../src/run/queue"
import {
  flatSettings,
  now,
  seedAgent,
  seedChallenge,
  seedEvent,
  setupDb,
  USER,
} from "../helpers"

type Db = ReturnType<typeof setupDb>["db"]
type QueueRow = typeof spawnQueue.$inferSelect

function item(db: Db, id: string) {
  return db.select().from(spawnQueue).where(eq(spawnQueue.id, id)).get()!
}

/** Poll until cond() holds or the deadline passes (real-timer waits for the
 * drainer's debounced passes). */
async function waitFor(cond: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out")
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** QueueService with a stubbed launch (records calls, controls outcome).
 * Each launch seeds the agent row the drainer's markRunning references.
 * Created services are disposed by the file-level afterEach (mirrors the
 * production close: isDisposed → true + cancelDrain) so a leftover debounced
 * drain never fires against the test's closed DB. */
const createdQueues: Array<{ dispose: () => void }> = []

afterEach(() => {
  for (const svc of createdQueues.splice(0)) svc.dispose()
})

function makeQueue(db: Db, launch: (row: QueueRow) => Promise<string>) {
  const launches: string[] = []
  const launchedRows: QueueRow[] = []
  const emergencies: string[] = []
  const notices: string[] = []
  let n = 0
  let disposed = false
  const svc = createQueueService({
    db,
    getSettings: flatSettings,
    isDisposed: () => disposed,
    launch: async (row) => {
      launches.push(row.id)
      launchedRows.push(row)
      const agentId = await launch(row)
      n += 1
      seedAgent(db, {
        id: agentId === "run-x" ? `agent-${n}` : agentId,
        eventId: row.eventId,
        challengeId: row.challengeId,
      })
      return agentId === "run-x" ? `agent-${n}` : agentId
    },
    onQueueEmergency: (eventId, line) =>
      emergencies.push(`${eventId}: ${line}`),
    onQueueNotice: (eventId, line) => notices.push(`${eventId}: ${line}`),
  })
  createdQueues.push({
    dispose: () => {
      disposed = true
      svc.cancelDrain()
    },
  })
  return { svc, launches, launchedRows, emergencies, notices }
}

function enqueue(
  svc: ReturnType<typeof makeQueue>["svc"],
  eventId: string,
  challengeId: string,
  ord = 0,
  extra: { status?: string } = {}
) {
  return svc.enqueue(
    {
      eventId,
      challengeId,
      source: "manual",
      prompt: `prompt-${ord}`,
      ...extra,
    },
    USER
  )
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
      const list = svc.list("evt-1", USER)
      expect(list.map((i) => i.challengeId)).toEqual(["ch-a", "ch-b"])
    } finally {
      close()
    }
  })

  test("v19 append: one challenge may hold several pending items (no upsert)", async () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-a", eventId: "evt-1" })
      const { svc } = makeQueue(db, async () => "run-x")
      svc.cancelDrain()
      const first = enqueue(svc, "evt-1", "ch-a", 1)
      const second = enqueue(svc, "evt-1", "ch-a", 2)
      // Two DISTINCT pending rows on the same challenge — parallel attempts
      // are a legal plan.
      expect(second.id).not.toBe(first.id)
      expect([first.status, second.status]).toEqual(["pending", "pending"])
      expect([first.ord, second.ord]).toEqual([1, 2])
      expect(second.prompt).toBe("prompt-2")
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
      svc.remove("evt-1", pending.id, USER) // ok
      expect(item(db, pending.id)).toBeUndefined()

      const running = enqueue(svc, "evt-1", "ch-a", 2)
      db.update(spawnQueue)
        .set({ status: "running", updatedAt: now() })
        .where(eq(spawnQueue.id, running.id))
        .run()
      expect(() => svc.remove("evt-1", running.id, USER)).toThrow(
        RunActionError
      )
    } finally {
      close()
    }
  })

  test("remove is scoped to its event (cross-event / missing → not_found)", async () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedEvent(db, "evt-2")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const { svc } = makeQueue(db, async () => "run-x")
      svc.cancelDrain()
      const a = enqueue(svc, "evt-1", "ch-1", 1)

      const deny = (eventId: string): RunActionError | null => {
        try {
          svc.remove(eventId, a.id, USER)
          return null
        } catch (error) {
          if (error instanceof RunActionError) return error
          throw error
        }
      }
      expect(deny("evt-2")?.code).toBe("not_found")
      expect(item(db, a.id)).toBeDefined() // the row survives
      expect(deny("evt-missing")?.message).toBe("Queue item not found")

      svc.remove("evt-1", a.id, USER)
      expect(item(db, a.id)).toBeUndefined()
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
      const updated = svc.update(
        "evt-1",
        pending.id,
        {
          prompt: "edited",
          timeoutMs: 99,
        },
        USER
      )
      expect(updated.prompt).toBe("edited")
      expect(updated.timeoutMs).toBe(99)

      const running = enqueue(svc, "evt-1", "ch-a", 2)
      db.update(spawnQueue)
        .set({ status: "running", updatedAt: now() })
        .where(eq(spawnQueue.id, running.id))
        .run()
      expect(() =>
        svc.update("evt-1", running.id, { prompt: "x" }, USER)
      ).toThrow(RunActionError)
    } finally {
      close()
    }
  })

  // P0-7 regression: a prompt edit must reach the launch path. The prompt
  // column is the single source — the params JSON never carries a copy that
  // could shadow it.
  test("a prompt edit reaches launch; the params JSON holds no prompt", async () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-a", eventId: "evt-1" })
      const { svc, launchedRows } = makeQueue(db, async () => "run-x")
      svc.cancelDrain()
      const a = enqueue(svc, "evt-1", "ch-a", 1)
      svc.update("evt-1", a.id, { prompt: "EDITED" }, USER)
      expect(svc.list("evt-1", USER)[0].prompt).toBe("EDITED")

      await svc.drainOnce()
      expect(launchedRows.map((row) => row.prompt)).toEqual(["EDITED"])
      expect(JSON.parse(item(db, a.id).params)).toEqual({})
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
      svc.reorder("evt-1", [c.id, a.id, b.id], USER)
      const list = svc.list("evt-1", USER)
      expect(list.map((i) => i.id)).toEqual([c.id, a.id, b.id])
    } finally {
      close()
    }
  })

  test("markDone is guarded by (id, agentId, running)", async () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-a", eventId: "evt-1" })
      seedAgent(db, { id: "a-1", eventId: "evt-1", challengeId: "ch-a" })
      const { svc } = makeQueue(db, async () => "run-x")
      svc.cancelDrain()
      const it = enqueue(svc, "evt-1", "ch-a", 1)
      db.update(spawnQueue)
        .set({ status: "running", agentId: "a-1", updatedAt: now() })
        .where(eq(spawnQueue.id, it.id))
        .run()
      // Wrong agentId → no-op.
      svc.markDone(it.id, "a-other")
      expect(item(db, it.id).status).toBe("running")
      // Correct guard → done.
      svc.markDone(it.id, "a-1")
      expect(item(db, it.id).status).toBe("done")
    } finally {
      close()
    }
  })

  test("enqueue serializes the v19 spawn params; the prompt column is the only prompt home", async () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-a", eventId: "evt-1" })
      const { svc } = makeQueue(db, async () => "run-x")
      svc.cancelDrain()
      const enqueued = svc.enqueue(
        {
          eventId: "evt-1",
          challengeId: "ch-a",
          source: "scheduler",
          prompt: "spawn strategy text",
          model: "aegisx-prov-1/gpt-4o-mini",
          promptMode: "override",
          timeoutMs: 3_600_000,
        },
        USER
      )
      expect(enqueued.prompt).toBe("spawn strategy text")
      expect(enqueued.params).toEqual({
        model: "aegisx-prov-1/gpt-4o-mini",
        promptMode: "override",
      })
      expect(enqueued.timeoutMs).toBe(3_600_000)
      expect(enqueued.agentId).toBeNull()
    } finally {
      close()
    }
  })

  test("parseSpawnQueueParams reads the params back defensively", () => {
    expect(parseSpawnQueueParams("{}")).toEqual({})
    expect(parseSpawnQueueParams("not json")).toEqual({})
    expect(
      parseSpawnQueueParams(
        JSON.stringify({ model: "m", promptMode: "override" })
      )
    ).toEqual({ model: "m", promptMode: "override" })
    // Wrong shapes drop the affected key; a stale prompt key (old rows) is
    // ignored — the prompt column wins.
    expect(
      parseSpawnQueueParams(
        JSON.stringify({
          prompt: "s",
          model: "",
          promptMode: "nonsense",
        })
      )
    ).toEqual({})
  })
})

describe("queue per-event state (W2.1)", () => {
  test("stateOf defaults to running; pause/resume round-trip via upsert", async () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      const { svc } = makeQueue(db, async () => "run-x")
      expect(svc.stateOf("evt-1", USER)).toBe("running")
      svc.pause("evt-1", "manual", USER)
      expect(svc.stateOf("evt-1", USER)).toBe("paused")
      svc.resume("evt-1", "manual", USER)
      expect(svc.stateOf("evt-1", USER)).toBe("running")
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
      svc.pause("evt-1", "manual", USER) // default source: manual (the web UI sends nothing)
      expect(svc.stateOf("evt-1", USER)).toBe("paused")
      expect(notices).toEqual(["evt-1: 队列已暂停（用户手动）"])
      svc.resume("evt-1", "scheduler", USER)
      expect(svc.stateOf("evt-1", USER)).toBe("running")
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
      const a = svc.enqueue(
        {
          eventId: "evt-1",
          challengeId: "ch-a",
          source: "manual",
          prompt: "p",
        },
        USER
      )
      const b = svc.enqueue(
        {
          eventId: "evt-2",
          challengeId: "ch-b",
          source: "manual",
          prompt: "p",
        },
        USER
      )
      svc.pause("evt-1", "manual", USER)
      await svc.drainOnce()
      // Only evt-2's item launches; evt-1's stays pending (still visible).
      expect(launches).toEqual([b.id])
      expect(item(db, a.id).status).toBe("pending")
      expect(item(db, b.id).status).toBe("running")
      // Resume → the pending item now launches.
      svc.resume("evt-1", "manual", USER)
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
      const a = svc.enqueue(
        {
          eventId: "evt-1",
          challengeId: "ch-a",
          source: "manual",
          prompt: "p",
        },
        USER
      )
      await svc.drainOnce() // launches a → running
      svc.pause("evt-1", "manual", USER)
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
      svc.pause("evt-1", "manual", USER)
      const a = enqueue(svc, "evt-1", "ch-a", 1)
      const updated = svc.update("evt-1", a.id, { prompt: "edited" }, USER)
      expect(updated.prompt).toBe("edited")
      expect(svc.list("evt-1", USER).map((i) => i.id)).toEqual([a.id])
      svc.remove("evt-1", a.id, USER)
      expect(svc.list("evt-1", USER)).toHaveLength(0)
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
      expect(item(db, a.id).agentId).toBe("run-1")
      expect(item(db, b.id).status).toBe("running")
    } finally {
      close()
    }
  })

  // Regression: a `queue_state` row with status 'running' must not widen the
  // drainer's WHERE. As a raw sql fragment the OR sat at the top level of the
  // AND chain (AND binds tighter), degrading to
  // `status='pending' AND x IS NULL OR x != 'paused'` — true for every row —
  // so done/cancelled items were re-launched on every pass.
  test("drainer ignores non-pending items when the event's queue_state is 'running'", async () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-a", eventId: "evt-1" })
      seedChallenge(db, { id: "ch-b", eventId: "evt-1" })
      db.insert(queueState)
        .values({ eventId: "evt-1", status: "running", updatedAt: now() })
        .run()
      let n = 0
      const { svc, launches } = makeQueue(db, async () => `run-${++n}`)
      svc.cancelDrain()
      const live = enqueue(svc, "evt-1", "ch-a", 1)
      const done = enqueue(svc, "evt-1", "ch-b", 2)
      // Terminal history that must never re-launch.
      db.update(spawnQueue)
        .set({ status: "done" })
        .where(eq(spawnQueue.id, done.id))
        .run()
      await svc.drainOnce()
      expect(launches).toEqual([live.id])
      expect(item(db, live.id).status).toBe("running")
      expect(item(db, done.id).status).toBe("done")
    } finally {
      close()
    }
  })

  test("a pending item on a solved challenge is cancelled (not launched); later items still drain", async () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-solved", eventId: "evt-1" })
      seedChallenge(db, { id: "ch-open", eventId: "evt-1" })
      db.insert(challengeFlags)
        .values({
          id: "f-1",
          challengeId: "ch-solved",
          flag: "flag{x}",
          status: "accepted",
          source: "agent",
          agentId: null,
          remoteId: null,
          message: null,
          createdAt: now(),
          updatedAt: now(),
        })
        .run()
      let n = 0
      const { svc, launches, emergencies } = makeQueue(
        db,
        async () => `run-${++n}`
      )
      svc.cancelDrain()
      const stale = enqueue(svc, "evt-1", "ch-solved", 1)
      const open = enqueue(svc, "evt-1", "ch-open", 2)
      await svc.drainOnce()
      // Silent cancel — no launch, no failure record. The penultimate-item
      // cancel still crosses the starved edge (markCancelled feeds
      // checkStarved like every other pending-consuming path).
      expect(launches).toEqual([open.id])
      expect(item(db, stale.id).status).toBe("cancelled")
      expect(item(db, open.id).status).toBe("running")
      expect(emergencies).toEqual(["evt-1: 队列不足：仅剩 1 项排队"])
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
      expect(emergencies[0]).toContain("evt-1: 启动失败：「Test Challenge」")
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
      svc.remove("evt-1", a.id, USER) // 2 → 1: edge fires
      expect(emergencies).toHaveLength(1)
      expect(emergencies[0]).toContain("队列不足")
      svc.remove("evt-1", b.id, USER) // 1 → 0: already ≤1, no repeat
      expect(emergencies).toHaveLength(1)

      // Refill to ≥2 re-arms; another 2→1 crossing fires again.
      enqueue(svc, "evt-1", "ch-c", 3)
      const d = enqueue(svc, "evt-1", "ch-b", 4)
      expect(emergencies).toHaveLength(1)
      svc.remove("evt-1", d.id, USER)
      expect(emergencies).toHaveLength(2)
    } finally {
      close()
    }
  })

  test("markCancelled crosses the starved edge like remove/markFailed do", async () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-a", eventId: "evt-1" })
      seedChallenge(db, { id: "ch-b", eventId: "evt-1" })
      const { svc, emergencies } = makeQueue(db, async () => "run-x")
      svc.cancelDrain()
      const a = enqueue(svc, "evt-1", "ch-a", 1)
      enqueue(svc, "evt-1", "ch-b", 2) // ≥2 pending resets the starved edge
      svc.markCancelled(a.id) // 2 → 1 crossing fires exactly once
      expect(emergencies).toEqual(["evt-1: 队列不足：仅剩 1 项排队"])
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
      svc.pause("evt-1", "manual", USER)
      svc.remove("evt-1", a.id, USER) // 2→1 crossing while paused → silent
      expect(emergencies).toHaveLength(0)
      expect(notices).toEqual(["evt-1: 队列已暂停（用户手动）"])
      expect(svc.stateOf("evt-1", USER)).toBe("paused")
    } finally {
      close()
    }
  })

  test("pause/resume are idempotent (no duplicate notice lines)", async () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      const { svc, notices } = makeQueue(db, async () => "run-x")
      svc.pause("evt-1", "manual", USER)
      svc.pause("evt-1", "manual", USER)
      svc.pause("evt-1", "scheduler", USER)
      expect(notices).toEqual(["evt-1: 队列已暂停（用户手动）"])
      svc.resume("evt-1", "manual", USER)
      svc.resume("evt-1", "manual", USER)
      expect(notices).toEqual([
        "evt-1: 队列已暂停（用户手动）",
        "evt-1: 队列已恢复（用户手动）",
      ])
      expect(svc.stateOf("evt-1", USER)).toBe("running")
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

  test("a trigger arriving mid-pass opens a fresh debounced pass (trailing enqueue not lost)", async () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-a", eventId: "evt-1" })
      seedChallenge(db, { id: "ch-b", eventId: "evt-1" })
      // Stall pass 1 inside launch until released.
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      let n = 0
      const { svc, launches } = makeQueue(db, async () => {
        if (++n === 1) await gate
        return `run-${n}`
      })
      const a = enqueue(svc, "evt-1", "ch-a", 1)
      await waitFor(() => launches.length === 1) // pass 1 blocked in launch
      const b = enqueue(svc, "evt-1", "ch-b", 2) // trailing trigger mid-pass
      release()
      await waitFor(() => item(db, b.id).status === "running")
      expect(launches).toEqual([a.id, b.id])
      expect(item(db, a.id).agentId).toBe("run-1")
      expect(item(db, b.id).agentId).toBe("run-2")
    } finally {
      close()
    }
  })
})
