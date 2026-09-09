import { afterEach, describe, expect, test } from "bun:test"

import { defaultSettings } from "@aegisx/shared"

import type { spawnQueue } from "../../src/db/schema"
import { planDrainStep, createQueueDrainer } from "../../src/run/drainer"
import {
  flatSettings,
  seedChallenge,
  seedEvent,
  setupDb,
  now,
} from "../helpers"

type Db = ReturnType<typeof setupDb>["db"]
type QueueRow = typeof spawnQueue.$inferSelect

function row(overrides: Partial<QueueRow> = {}): QueueRow {
  return {
    id: "q-1",
    eventId: "evt-1",
    ord: 1,
    challengeId: "ch-1",
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
  }
}

/** Poll until cond() holds or the deadline passes (real-timer waits for the
 * drainer's capacity retry). */
async function waitFor(cond: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out")
    await new Promise((r) => setTimeout(r, 5))
  }
}

/** Created drainers are disposed by the file-level afterEach (mirrors the
 * production close: isDisposed → true + cancelDrain) so a leftover capacity
 * retry never fires against the test's closed DB. */
const createdDrainers: Array<{ dispose: () => void }> = []

afterEach(() => {
  for (const svc of createdDrainers.splice(0)) svc.dispose()
})

/** Drainer over a mutable in-memory store; `maxConcurrentAgents` is mutable
 * so a test can flip the fence from saturated to open. */
function makeDrainer(
  db: Db,
  launch: (item: QueueRow) => Promise<string>,
  opts: {
    cap?: () => number
    retryMs?: number
    rows?: QueueRow[]
    /** Outcome of the guarded markRunning; the default wins and flips the
     * row to running. Returning false models a cancel landing mid-launch. */
    markRunning?: (itemId: string, agentId: string) => boolean
    onSupersededLaunch?: (agentId: string) => void | Promise<void>
  } = {}
) {
  const launches: string[] = []
  const emergencies: string[] = []
  const rows = opts.rows ?? []
  let cap =
    opts.cap ?? (() => defaultSettings()["scheduler.maxConcurrentAgents"])
  let disposed = false
  const drainer = createQueueDrainer({
    db,
    getSettings: () => ({
      ...flatSettings(),
      "scheduler.maxConcurrentAgents": cap(),
    }),
    isDisposed: () => disposed,
    launch: async (item) => {
      launches.push(item.id)
      return launch(item)
    },
    onEmergency: (eventId, line) => emergencies.push(`${eventId}: ${line}`),
    ...(opts.onSupersededLaunch
      ? { onSupersededLaunch: opts.onSupersededLaunch }
      : {}),
    store: {
      pendingItems: () => rows.filter((r) => r.status === "pending"),
      markRunning: (itemId, agentId) => {
        if (opts.markRunning) return opts.markRunning(itemId, agentId)
        const r = rows.find((x) => x.id === itemId)
        if (!r) return false
        r.status = "running"
        r.agentId = agentId
        return true
      },
      markFailed: (itemId, error) => {
        const r = rows.find((x) => x.id === itemId)
        if (r) {
          r.status = "failed"
          r.error = error
        }
      },
      markCancelled: (itemId) => {
        const r = rows.find((x) => x.id === itemId)
        if (r) r.status = "cancelled"
      },
    },
    ...(opts.retryMs !== undefined ? { retryMs: opts.retryMs } : {}),
  })
  createdDrainers.push({
    dispose: () => {
      disposed = true
      drainer.cancelDrain()
    },
  })
  return {
    drainer,
    launches,
    emergencies,
    setCap: (n: number) => (cap = () => n),
  }
}

describe("planDrainStep", () => {
  test("maps fence decisions to drain actions", () => {
    expect(planDrainStep({ ok: true })).toEqual({ kind: "launch" })
    expect(
      planDrainStep({
        ok: false,
        code: "global_capacity",
        message: "cap",
      })
    ).toEqual({ kind: "stop" })
    expect(
      planDrainStep({
        ok: false,
        code: "challenge_solved",
        message: "solved",
      })
    ).toEqual({ kind: "cancel" })
    expect(
      planDrainStep({ ok: false, code: "target_slots", message: "slots" })
    ).toEqual({ kind: "skip" })
  })
})

describe("queue drainer capacity retry", () => {
  test("a global_capacity stop re-arms a bounded retry that launches when a slot frees", async () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const r = row()
      let n = 0
      const { drainer, launches, setCap } = makeDrainer(
        db,
        async () => `run-${++n}`,
        { rows: [r], retryMs: 20, cap: () => 0 }
      )
      // Cap 0: the fence rejects with global_capacity — the pass stops, the
      // item stays pending, and the retry is armed.
      await drainer.drainOnce()
      expect(launches).toEqual([])
      expect(r.status).toBe("pending")
      // Cap frees → the retry pass launches without any external trigger.
      setCap(defaultSettings()["scheduler.maxConcurrentAgents"])
      await waitFor(() => launches.length === 1)
      expect(r.status).toBe("running")
    } finally {
      close()
    }
  })

  test("cancelDrain clears a pending capacity retry (no pass against a disposed owner)", async () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const r = row()
      const { drainer, launches } = makeDrainer(db, async () => "run-x", {
        rows: [r],
        retryMs: 20,
        cap: () => 0,
      })
      await drainer.drainOnce() // stop → retry armed
      drainer.cancelDrain()
      await new Promise((r2) => setTimeout(r2, 80))
      expect(launches).toEqual([])
      expect(r.status).toBe("pending")
    } finally {
      close()
    }
  })

  test("a completing pass never arms a retry (retry is exclusive to global_capacity stops)", async () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const r = row()
      let n = 0
      const { drainer, launches } = makeDrainer(db, async () => `run-${++n}`, {
        rows: [r],
        retryMs: 20,
      })
      await drainer.drainOnce() // launch succeeds; the pass completes, no stop
      expect(launches).toEqual(["q-1"])
      expect(r.status).toBe("running")
      await new Promise((r2) => setTimeout(r2, 60))
      expect(launches).toEqual(["q-1"]) // no repeat pass
    } finally {
      close()
    }
  })
})

describe("queue drainer superseded launches", () => {
  test("markRunning losing the race settles the launched agent; drainOnce still resolves", async () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const r = row()
      const superseded: string[] = []
      const { drainer, launches } = makeDrainer(db, async () => "run-x", {
        rows: [r],
        markRunning: () => {
          // cancelPendingForChallenge landed while the launch was in flight.
          r.status = "cancelled"
          return false
        },
        onSupersededLaunch: (agentId) => {
          superseded.push(agentId)
        },
      })
      await drainer.drainOnce()
      expect(launches).toEqual(["q-1"])
      expect(r.status).toBe("cancelled")
      expect(superseded).toEqual(["run-x"])
    } finally {
      close()
    }
  })

  test("a superseded-launch settle failure never rejects out of drainOnce", async () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const r = row()
      let settled = false
      const { drainer } = makeDrainer(db, async () => "run-x", {
        rows: [r],
        markRunning: () => {
          r.status = "cancelled"
          return false
        },
        onSupersededLaunch: async () => {
          await new Promise((r2) => setTimeout(r2, 5))
          settled = true
          throw new Error("settle blew up")
        },
      })
      await drainer.drainOnce() // resolved despite the pending settle rejection
      await waitFor(() => settled)
    } finally {
      close()
    }
  })

  test("markRunning winning the race never invokes the supersede path", async () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const r = row()
      const superseded: string[] = []
      const { drainer, launches } = makeDrainer(db, async () => "run-x", {
        rows: [r],
        onSupersededLaunch: (agentId) => {
          superseded.push(agentId)
        },
      })
      await drainer.drainOnce()
      expect(launches).toEqual(["q-1"])
      expect(r.status).toBe("running")
      expect(r.agentId).toBe("run-x")
      expect(superseded).toEqual([])
    } finally {
      close()
    }
  })
})
