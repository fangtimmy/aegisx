import { describe, expect, test } from "bun:test"

import { eq } from "drizzle-orm"

import { createDatabase } from "../../src/db"
import { agents, domainEvents, queueState } from "../../src/db/schema"
import { createFakeClock } from "../../src/run/clock"
import {
  createDecisionPointEngine,
  type DecisionTimings,
} from "../../src/run/decision-points/engine"
import { now, seedAgent, seedChallenge, seedEvent } from "../helpers"

const TIMINGS: DecisionTimings = {
  coalesceMs: 1_000,
  errorRetryMs: 5_000,
  periodicMs: 60_000,
  violationsToEscalate: 3,
  maxErrorRetries: 2,
}

function setupDbLite() {
  const dir = `/tmp/aegisx-dp-${crypto.randomUUID()}`
  const { db, releaseLock } = createDatabase(dir)
  return { db, close: () => releaseLock() }
}

function seedWorld(db: ReturnType<typeof createDatabase>["db"]) {
  seedEvent(db)
  seedChallenge(db, { id: "ch-1" })
  seedAgent(db, {
    id: "sched",
    role: "orchestrator",
    challengeId: null,
    status: "idle",
  })
}

type Db = ReturnType<typeof createDatabase>["db"]

/** Recorded send + a settle() the test calls to emulate the scheduler's turn
 * ending (the runtime would call onTurnSettled via the status core). */
async function makeEngine(
  db: Db,
  opts: {
    schedulerPaused?: boolean
    schedulerStatus?: (typeof agents.$inferSelect)["status"]
    timings?: Partial<DecisionTimings>
  } = {}
) {
  const clock = createFakeClock()
  const sends: string[] = []
  const escalations: Array<{
    eventId: string
    id: string
    consecutive: number
  }> = []
  const schedulerStatus = opts.schedulerStatus
  if (schedulerStatus && schedulerStatus !== "idle") {
    db.update(agents)
      .set({ status: schedulerStatus })
      .where(eq(agents.id, "sched"))
      .run()
  }
  const engine = createDecisionPointEngine({
    db,
    clock,
    now: () => new Date(clock.now()).toISOString(),
    send: async (_agentId, text) => {
      sends.push(text)
      return { delivered: true, via: "fresh" as const, chars: text.length }
    },
    digestOf: () => ({
      digest: "[调度快照] mock",
      fingerprint: `fp-${db.select().from(agents).all().length}`,
    }),
    isSchedulerPaused: () => opts.schedulerPaused ?? false,
    escalateNotice: (eventId, id, consecutive) =>
      escalations.push({ eventId, id, consecutive }),
    timings: { ...TIMINGS, ...opts.timings },
  })
  return { engine, clock, sends, escalations }
}

function events(db: Db, type: string) {
  return db
    .select({ payload: domainEvents.payload })
    .from(domainEvents)
    .where(eq(domainEvents.type, type))
    .all()
    .map((row) => JSON.parse(row.payload))
}

/** Flush the engine's microtasks (chain + send) after a clock advance. */
const settle = () => new Promise((r) => setTimeout(r, 5))

/** Emulate a scheduler turn that submitted the given actions at `atMs`. */
function submitPlanEvent(db: Db, actions: unknown[], atMs: number): void {
  db.insert(domainEvents)
    .values({
      type: "plan.proposed",
      eventId: "evt-1",
      agentId: "sched",
      actorKind: "agent",
      actorId: "sched",
      payload: JSON.stringify({
        planId: crypto.randomUUID(),
        rationale: "r",
        actions,
        schedulerAgentId: "sched",
        at: new Date(atMs).toISOString(),
      }),
      createdAt: new Date(atMs).toISOString(),
    })
    .run()
}

describe("decision-point engine (§3.6)", () => {
  test("non-urgent triggers coalesce into ONE decision point; the turn protocol is in the payload", async () => {
    const { db, close } = setupDbLite()
    try {
      seedWorld(db)
      const { engine, clock, sends } = await makeEngine(db)

      // Two non-urgent triggers inside the window → one point, two triggers.
      engine.trigger("evt-1", {
        kind: "agent.settled",
        agentId: "a1",
        status: "idle",
      })
      engine.trigger("evt-1", {
        kind: "queue.changed",
        reason: "low_water",
        pending: 1,
      })
      await settle()
      expect(sends).toHaveLength(0) // window pending
      clock.advance(TIMINGS.coalesceMs)
      await settle()
      expect(sends).toHaveLength(1)
      expect(sends[0]).toContain("[决策点")
      expect(sends[0]).toContain("agent.settled：agent-a1（idle）")
      expect(sends[0]).toContain("queue.changed：队列低水位（待发 1）")
      expect(sends[0]).toContain("[调度快照] mock")
      expect(sends[0]).toContain("submit_plan")
      const opened = events(db, "decision_point.opened")
      expect(opened).toHaveLength(1)
      expect(opened[0].triggers).toHaveLength(2)

      // A trigger arriving while the point is open stays pending until close.
      engine.trigger("evt-1", { kind: "periodic" })
      clock.advance(TIMINGS.coalesceMs)
      await settle()
      expect(sends).toHaveLength(1)
      // Settle the turn with no plan → ONE strict re-prompt → violation →
      // the pending trigger opens the next point.
      engine.onTurnSettled("sched", null)
      await settle()
      expect(sends).toHaveLength(2) // strict re-prompt
      expect(sends[1]).toContain("违约提醒")
      engine.onTurnSettled("sched", null)
      await settle()
      const closed = events(db, "decision_point.closed")
      expect(closed[0].outcome).toBe("violation")
      clock.advance(TIMINGS.coalesceMs)
      await settle()
      expect(sends).toHaveLength(3) // pending periodic opened a fresh point
      engine.close()
    } finally {
      close()
    }
  })

  test("urgent triggers (first flag, launch failure) skip the window", async () => {
    const { db, close } = setupDbLite()
    try {
      seedWorld(db)
      const { engine, sends } = await makeEngine(db)
      engine.trigger("evt-1", {
        kind: "flag.accepted",
        challengeName: "web1",
        tier: "first",
      })
      await settle()
      expect(sends).toHaveLength(1)
      expect(sends[0]).toContain("flag.accepted：「web1」首次解出")
      engine.close()
    } finally {
      close()
    }
  })

  test("a submit_plan inside the turn window closes the point as plan (noOp included)", async () => {
    const { db, close } = setupDbLite()
    try {
      seedWorld(db)
      const { engine, clock } = await makeEngine(db)
      engine.trigger("evt-1", {
        kind: "agent.settled",
        agentId: "a1",
        status: "idle",
      })
      clock.advance(TIMINGS.coalesceMs)
      await settle()

      // The endpoint call arrives mid-turn: payload.at inside the window.
      submitPlanEvent(
        db,
        [{ ref: "r1", kind: "noOp", reason: "quiet" }],
        clock.now()
      )
      engine.onTurnSettled("sched", null)
      await settle()
      const closed = events(db, "decision_point.closed")
      expect(closed).toHaveLength(1)
      expect(closed[0].outcome).toBe("plan")
      engine.close()
    } finally {
      close()
    }
  })

  test("a plan submitted BEFORE the window does not correlate → violation path", async () => {
    const { db, close } = setupDbLite()
    try {
      seedWorld(db)
      const { engine, clock } = await makeEngine(db)
      // A stale plan from an earlier turn.
      submitPlanEvent(
        db,
        [{ ref: "old", kind: "noOp", reason: "old" }],
        clock.now() - 10_000
      )
      engine.trigger("evt-1", {
        kind: "agent.settled",
        agentId: "a1",
        status: "idle",
      })
      clock.advance(TIMINGS.coalesceMs)
      await settle()
      engine.onTurnSettled("sched", null)
      await settle() // re-prompt
      engine.onTurnSettled("sched", null)
      await settle()
      const closed = events(db, "decision_point.closed")
      expect(closed[0].outcome).toBe("violation")
      engine.close()
    } finally {
      close()
    }
  })

  test("violation ladder: re-prompt once, then violation; three consecutive escalate", async () => {
    const { db, close } = setupDbLite()
    try {
      seedWorld(db)
      const { engine, clock, sends, escalations } = await makeEngine(db)

      for (let round = 0; round < 3; round += 1) {
        engine.trigger("evt-1", {
          kind: "agent.settled",
          agentId: "a1",
          status: "idle",
        })
        clock.advance(TIMINGS.coalesceMs)
        await settle()
        const base = round * 2 // each round = payload + strict re-prompt
        expect(sends[base]).toContain("[决策点")
        engine.onTurnSettled("sched", null)
        await settle()
        expect(sends[base + 1]).toContain("违约提醒")
        engine.onTurnSettled("sched", null)
        await settle()
      }
      expect(sends).toHaveLength(6)
      const closed = events(db, "decision_point.closed")
      expect(closed).toHaveLength(3)
      expect(closed.every((c) => c!.outcome === "violation")).toBe(true)
      // The bound tripped: watchdog.escalated + the urgent notice.
      expect(escalations).toHaveLength(1)
      expect(escalations[0].consecutive).toBe(3)
      const escalated = events(db, "watchdog.escalated")
      expect(escalated).toHaveLength(1)
      expect(escalated[0].reason).toBe("scheduler_violation")
      // The counter reset after escalation — the next violation is silent.
      engine.trigger("evt-1", {
        kind: "agent.settled",
        agentId: "a2",
        status: "idle",
      })
      clock.advance(TIMINGS.coalesceMs)
      await settle()
      engine.onTurnSettled("sched", null)
      await settle()
      engine.onTurnSettled("sched", null)
      await settle()
      expect(escalations).toHaveLength(1)
      engine.close()
    } finally {
      close()
    }
  })

  test("an errored turn is NOT a violation: the same point re-issues, gives up as error", async () => {
    const { db, close } = setupDbLite()
    try {
      seedWorld(db)
      const { engine, clock, sends } = await makeEngine(db)
      engine.trigger("evt-1", {
        kind: "flag.accepted",
        challengeName: "web1",
        tier: "first",
      })
      await settle()
      const openedBefore = events(db, "decision_point.opened")

      // First failure → retry scheduled.
      engine.onTurnSettled("sched", "provider exploded")
      await settle()
      expect(events(db, "decision_point.closed")).toHaveLength(0)
      clock.advance(TIMINGS.errorRetryMs)
      await settle()
      // Same decision point re-issued (one opened event, second send).
      expect(events(db, "decision_point.opened")).toHaveLength(
        openedBefore.length
      )
      expect(sends).toHaveLength(2)
      expect(sends[1]).toContain("[决策点")

      // Second failure exhausts the bound → outcome=error, no escalation.
      engine.onTurnSettled("sched", "provider exploded again")
      clock.advance(TIMINGS.errorRetryMs)
      await settle()
      expect(events(db, "decision_point.opened")).toHaveLength(
        openedBefore.length
      )
      expect(sends).toHaveLength(3)
      engine.onTurnSettled("sched", "boom")
      await settle()
      const closed = events(db, "decision_point.closed")
      expect(closed[0].outcome).toBe("error")
      expect(events(db, "watchdog.escalated")).toHaveLength(0)
      engine.close()
    } finally {
      close()
    }
  })

  test("gates: a paused queue or a disabled scheduler produces no decision points", async () => {
    const { db, close } = setupDbLite()
    try {
      seedWorld(db)

      // W3: scheduler disabled — nothing drives, nothing escalates.
      const paused = await makeEngine(db, { schedulerPaused: true })
      paused.engine.trigger("evt-1", {
        kind: "flag.accepted",
        challengeName: "web1",
        tier: "first",
      })
      await settle()
      expect(paused.sends).toHaveLength(0)
      paused.engine.close()

      // W2: queue paused — triggers are dropped (a later resume tells the
      // scheduler via its own queue.changed trigger).
      const { engine, clock, sends } = await makeEngine(db)
      db.insert(queueState)
        .values({ eventId: "evt-1", status: "paused", updatedAt: now() })
        .run()
      engine.trigger("evt-1", {
        kind: "flag.accepted",
        challengeName: "web1",
        tier: "first",
      })
      await settle()
      expect(sends).toHaveLength(0)
      db.delete(queueState).run()
      engine.trigger("evt-1", {
        kind: "queue.changed",
        reason: "resumed",
      })
      clock.advance(TIMINGS.coalesceMs)
      await settle()
      expect(sends).toHaveLength(1)
      expect(sends[0]).toContain("队列已恢复")
      engine.close()
    } finally {
      close()
    }
  })

  test("a terminal scheduler is not driven by natural triggers; user.directive revives", async () => {
    const { db, close } = setupDbLite()
    try {
      seedWorld(db)
      const { engine, clock, sends } = await makeEngine(db, {
        schedulerStatus: "aborted",
      })
      engine.trigger("evt-1", {
        kind: "agent.settled",
        agentId: "a1",
        status: "idle",
      })
      clock.advance(TIMINGS.coalesceMs)
      await settle()
      expect(sends).toHaveLength(0)
      // The reopen path (startScheduler) rides a reviving user directive —
      // the runtime send cold-resumes the terminal agent.
      engine.trigger("evt-1", {
        kind: "user.directive",
        source: "resume",
        revive: true,
      })
      await settle()
      expect(sends).toHaveLength(1)
      expect(sends[0]).toContain("调度已恢复")
      engine.close()
    } finally {
      close()
    }
  })

  test("periodic skips while the fleet is unchanged since the last explicit no-decision", async () => {
    const { db, close } = setupDbLite()
    try {
      seedWorld(db)
      const { engine, clock, sends } = await makeEngine(db)
      // First periodic tick: fires (no baseline fingerprint yet).
      clock.advance(TIMINGS.periodicMs + TIMINGS.coalesceMs)
      await settle()
      expect(sends).toHaveLength(1)
      // Close it with an explicit noOp — records the quiet fingerprint.
      submitPlanEvent(
        db,
        [{ ref: "r1", kind: "noOp", reason: "all quiet" }],
        clock.now()
      )
      engine.onTurnSettled("sched", null)
      await settle()
      expect(events(db, "decision_point.closed")[0].outcome).toBe("plan")

      // Same fleet → the next periodic tick is skipped (no heartbeat burn).
      clock.advance(TIMINGS.periodicMs + TIMINGS.coalesceMs)
      await settle()
      expect(sends).toHaveLength(1)

      // The fleet changed (a new agent row → new fingerprint) → fires.
      seedAgent(db, { id: "a-new", status: "idle" })
      clock.advance(TIMINGS.periodicMs + TIMINGS.coalesceMs)
      await settle()
      expect(sends).toHaveLength(2)
      engine.close()
    } finally {
      close()
    }
  })

  test("boot.resync opens one re-sync decision point", async () => {
    const { db, close } = setupDbLite()
    try {
      seedWorld(db)
      const { engine, sends } = await makeEngine(db)
      engine.bootResync()
      await settle()
      expect(sends).toHaveLength(1)
      expect(sends[0]).toContain("boot.resync：服务已重启")
      expect(sends[0]).toContain("重新同步")
      engine.close()
    } finally {
      close()
    }
  })

  test("a scheduler closed mid-decision-point closes it as error without a retry", async () => {
    const { db, close } = setupDbLite()
    try {
      seedWorld(db)
      const { engine, sends } = await makeEngine(db)
      engine.trigger("evt-1", {
        kind: "flag.accepted",
        challengeName: "web1",
        tier: "first",
      })
      await settle()
      expect(sends).toHaveLength(1)
      // The user closes the scheduler while the point is open.
      engine.onAgentTerminal("sched")
      await settle()
      const closed = events(db, "decision_point.closed")
      expect(closed[0].outcome).toBe("error")
      expect(sends).toHaveLength(1) // no re-prompt, no retry
      engine.close()
    } finally {
      close()
    }
  })

  test("solver turn settles feed agent.settled triggers", async () => {
    const { db, close } = setupDbLite()
    try {
      seedWorld(db)
      seedAgent(db, { id: "solver-1", status: "idle" })
      const { engine, clock, sends } = await makeEngine(db)
      engine.onTurnSettled("solver-1", null)
      await settle()
      expect(sends).toHaveLength(0)
      clock.advance(TIMINGS.coalesceMs)
      await settle()
      expect(sends).toHaveLength(1)
      const opened = events(db, "decision_point.opened")
      expect(opened[0].triggers).toEqual([
        "agent.settled：agent-solver-1（idle）",
      ])
      engine.close()
    } finally {
      close()
    }
  })

  test("opened carries readable trigger lines; closed carries the outcome id-correlated", async () => {
    const { db, close } = setupDbLite()
    try {
      seedWorld(db)
      const { engine, clock } = await makeEngine(db)
      engine.trigger("evt-1", { kind: "boot.resync" })
      await settle()
      submitPlanEvent(
        db,
        [{ ref: "r1", kind: "enqueue", challengeId: "ch-1" }],
        clock.now()
      )
      engine.onTurnSettled("sched", null)
      await settle()
      const opened = events(db, "decision_point.opened")[0]!
      expect(opened.triggers[0]).toContain("boot.resync")
      expect(typeof opened.id).toBe("string")
      const closed = events(db, "decision_point.closed")[0]!
      expect(closed.outcome).toBe("plan")
      expect(closed.id).toBe(opened.id)
      engine.close()
    } finally {
      close()
    }
  })
})
