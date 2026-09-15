import { describe, expect, test } from "bun:test"

import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { eq } from "drizzle-orm"

import { createDatabase } from "../../src/db"
import { agents, domainEvents, queueState } from "../../src/db/schema"
import { FLUSH_INTERVAL_MS } from "../../src/run/channels-context"
import { createFakeClock } from "../../src/run/clock"
import {
  createDecisionPointEngine,
  DEFAULT_TIMINGS,
  type DecisionTimings,
} from "../../src/run/decision-points/engine"
import { createSubmitPlanTool } from "../../src/run/plan/tool"
import { now, seedAgent, seedChallenge, seedEvent } from "../helpers"
import { refine } from "../support"

const TIMINGS: DecisionTimings = {
  coalesceMs: 1_000,
  errorRetryMs: 5_000,
  periodicMs: 60_000,
  stallMs: 120_000,
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
    reason: string
    decisionPointId: string
    consecutive?: number
    stalledMs?: number
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
    escalateNotice: (eventId, escalation) =>
      escalations.push({ eventId, ...escalation }),
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

/** Register the plan the submit_plan tool would have registered mid-turn
 * (B 批): the tool handler stamps the in-flight turn's generation at call
 * time; the engine consumes it only at a clean settle of THAT generation. */
function registerPlan(
  engine: ReturnType<typeof createDecisionPointEngine>,
  turnGeneration: number,
  allNoOp: boolean
): void {
  engine.registerPlan({
    schedulerAgentId: "sched",
    turnGeneration,
    allNoOp,
  })
}

describe("decision-point engine (§3.6)", () => {
  test("production timings: the per-agent stall threshold landed as the engine's stallMs default", () => {
    expect(DEFAULT_TIMINGS.stallMs).toBe(2 * 60_000)
    expect(DEFAULT_TIMINGS.periodicMs).toBe(FLUSH_INTERVAL_MS)
  })

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
      engine.onTurnSettled("sched", null, 1)
      await settle()
      expect(sends).toHaveLength(2) // strict re-prompt
      expect(sends[1]).toContain("违约提醒")
      engine.onTurnSettled("sched", null, 2)
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

  test("an accepted submit_plan registered mid-turn closes the point as plan (noOp included)", async () => {
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

      // The tool call happened inside the payload turn (generation 1); the
      // settle reports the SAME generation → consumption.
      registerPlan(engine, 1, true)
      engine.onTurnSettled("sched", null, 1)
      await settle()
      const closed = events(db, "decision_point.closed")
      expect(closed).toHaveLength(1)
      expect(closed[0].outcome).toBe("plan")
      engine.close()
    } finally {
      close()
    }
  })

  test("an APPLY-phase fast failure still closes the point as plan; a VALIDATION rejection does not", async () => {
    const { db, close } = setupDbLite()
    try {
      seedWorld(db)
      const { engine, clock, sends } = await makeEngine(db)
      engine.trigger("evt-1", {
        kind: "agent.settled",
        agentId: "a1",
        status: "idle",
      })
      clock.advance(TIMINGS.coalesceMs)
      await settle()

      // The real submit_plan tool wired to the real engine; the applier dep
      // returns the exact result shape an apply-phase fast failure produces
      // (plan.proposed HAS landed — planId present — while the message ref
      // burned mid-apply, e.g. its target closed between validation and
      // application).
      const noCtx = refine<ExtensionContext>({})
      const tool = createSubmitPlanTool(
        {
          submitPlan: async () => ({
            planId: crypto.randomUUID(),
            results: [
              {
                ref: "m1",
                kind: "message",
                ok: false,
                code: "wrong_state",
                message: "agent closed mid-turn",
              },
            ],
            queueAfter: [],
            deferred: [],
          }),
          turnGenerationOf: () => 1,
          registerPlan: (registration) => engine.registerPlan(registration),
        },
        { agentId: "sched", eventId: "evt-1" }
      )
      await tool.execute(
        "call-1",
        {
          rationale: "steer a1",
          actions: [
            { ref: "m1", kind: "message", agentId: "a1", text: "steer" },
          ],
        },
        undefined,
        undefined,
        noCtx
      )
      // The failed ref did NOT un-answer the point: the proposal landed, so
      // the same-generation settle closes it as plan.
      engine.onTurnSettled("sched", null, 1)
      await settle()
      expect(sends).toHaveLength(1) // no re-prompt
      expect(events(db, "decision_point.closed")[0].outcome).toBe("plan")

      // A VALIDATION-phase rejection (no planId — nothing proposed) still
      // does not register: the next point takes the violation ladder.
      engine.trigger("evt-1", { kind: "queue.changed", reason: "enqueued" })
      clock.advance(TIMINGS.coalesceMs)
      await settle()
      const rejecting = createSubmitPlanTool(
        {
          submitPlan: async () => ({
            results: [
              {
                ref: "e1",
                kind: "enqueue",
                ok: false,
                code: "unknown_challenge",
                message: "nope",
              },
            ],
            queueAfter: [],
            deferred: [],
          }),
          turnGenerationOf: () => 2,
          registerPlan: (registration) => engine.registerPlan(registration),
        },
        { agentId: "sched", eventId: "evt-1" }
      )
      await rejecting.execute(
        "call-2",
        {
          rationale: "spawn",
          actions: [{ ref: "e1", kind: "enqueue", challengeId: "ch-1" }],
        },
        undefined,
        undefined,
        noCtx
      )
      engine.onTurnSettled("sched", null, 2)
      await settle()
      expect(sends).toHaveLength(3) // payload + strict re-prompt
      expect(sends[2]).toContain("违约提醒")
      engine.onTurnSettled("sched", null, 3)
      await settle()
      const closed = events(db, "decision_point.closed")
      expect(closed.map((c) => c.outcome)).toEqual(["plan", "violation"])
      engine.close()
    } finally {
      close()
    }
  })

  test("a registration from ANOTHER turn does not correlate → violation path", async () => {
    const { db, close } = setupDbLite()
    try {
      seedWorld(db)
      const { engine, clock } = await makeEngine(db)
      // A stale registration (an earlier turn's plan must not satisfy a
      // later point — the generation replaced the time window).
      registerPlan(engine, 99, true)
      engine.trigger("evt-1", {
        kind: "agent.settled",
        agentId: "a1",
        status: "idle",
      })
      clock.advance(TIMINGS.coalesceMs)
      await settle()
      engine.onTurnSettled("sched", null, 1)
      await settle() // re-prompt
      engine.onTurnSettled("sched", null, 2)
      await settle()
      const closed = events(db, "decision_point.closed")
      expect(closed[0].outcome).toBe("violation")
      engine.close()
    } finally {
      close()
    }
  })

  test("a plan inside an ERRORED turn never satisfies the re-issue (error path byte-identical)", async () => {
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
      // The plan landed (applied!) mid-turn, then the turn errored.
      registerPlan(engine, 1, true)
      engine.onTurnSettled("sched", "provider exploded", 1)
      await settle()
      expect(events(db, "decision_point.closed")).toHaveLength(0)
      clock.advance(TIMINGS.errorRetryMs)
      await settle()
      expect(sends).toHaveLength(2) // same point re-issued
      // The re-issued turn settles clean but the registration still carries
      // the dead turn's generation → mismatch → the violation ladder.
      engine.onTurnSettled("sched", null, 2)
      await settle()
      expect(sends).toHaveLength(3) // re-prompt first (phase was still turn)
      engine.onTurnSettled("sched", null, 3)
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
        engine.onTurnSettled("sched", null, base + 1)
        await settle()
        expect(sends[base + 1]).toContain("违约提醒")
        engine.onTurnSettled("sched", null, base + 2)
        await settle()
      }
      expect(sends).toHaveLength(6)
      const closed = events(db, "decision_point.closed")
      expect(closed).toHaveLength(3)
      expect(closed.every((c) => c!.outcome === "violation")).toBe(true)
      // The bound tripped: watchdog.escalated + the urgent notice.
      expect(escalations).toHaveLength(1)
      expect(escalations[0].reason).toBe("scheduler_violation")
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
      engine.onTurnSettled("sched", null, 7)
      await settle()
      engine.onTurnSettled("sched", null, 8)
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
      engine.onTurnSettled("sched", "provider exploded", 1)
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
      engine.onTurnSettled("sched", "provider exploded again", 2)
      clock.advance(TIMINGS.errorRetryMs)
      await settle()
      expect(events(db, "decision_point.opened")).toHaveLength(
        openedBefore.length
      )
      expect(sends).toHaveLength(3)
      engine.onTurnSettled("sched", "boom", 3)
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
      registerPlan(engine, 1, true)
      engine.onTurnSettled("sched", null, 1)
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

  test("stall contraction: a noOp'd situation persisting ≥ stallMs escalates once per episode (§3.7 r1)", async () => {
    const { db, close } = setupDbLite()
    try {
      seedWorld(db)
      const { engine, clock, sends, escalations } = await makeEngine(db)
      // A decision point closes with an explicit noOp → the stall episode
      // arms. The periodic skip means NO further points fire while quiet.
      engine.trigger("evt-1", {
        kind: "agent.settled",
        agentId: "a1",
        status: "idle",
      })
      clock.advance(TIMINGS.coalesceMs)
      await settle()
      registerPlan(engine, 1, true)
      engine.onTurnSettled("sched", null, 1)
      await settle()
      expect(events(db, "decision_point.closed")[0].outcome).toBe("plan")

      // Inside the stall window: silent.
      clock.advance(TIMINGS.stallMs / 2)
      await settle()
      expect(escalations).toHaveLength(0)

      // The unchanged situation crosses stallMs at the next periodic tick →
      // ONE escalation (alarm only — the quiet event still burns no turn).
      clock.advance(TIMINGS.periodicMs + TIMINGS.stallMs + TIMINGS.coalesceMs)
      await settle()
      expect(escalations).toHaveLength(1)
      expect(escalations[0].reason).toBe("scheduler_stalled")
      expect(escalations[0].stalledMs).toBeGreaterThanOrEqual(TIMINGS.stallMs)
      expect(sends).toHaveLength(1)
      expect(events(db, "watchdog.escalated")[0].reason).toBe(
        "scheduler_stalled"
      )
      // No re-escalation while the situation stays unchanged.
      clock.advance(TIMINGS.periodicMs * 3)
      await settle()
      expect(escalations).toHaveLength(1)

      // The situation moves → the episode cancels; the fresh point re-judges.
      seedAgent(db, { id: "a-new", status: "idle" })
      clock.advance(TIMINGS.periodicMs + TIMINGS.coalesceMs)
      await settle()
      expect(sends).toHaveLength(2)
      expect(escalations).toHaveLength(1)
      // A second noOp on the new situation re-arms; it escalates again only
      // after another full stall window.
      registerPlan(engine, 2, true)
      engine.onTurnSettled("sched", null, 2)
      await settle()
      clock.advance(TIMINGS.periodicMs + TIMINGS.stallMs + TIMINGS.coalesceMs)
      await settle()
      expect(escalations).toHaveLength(2)
      engine.close()
    } finally {
      close()
    }
  })

  test("a real plan clears the stall episode — no alarm while actions land", async () => {
    const { db, close } = setupDbLite()
    try {
      seedWorld(db)
      const { engine, clock, escalations } = await makeEngine(db)
      engine.trigger("evt-1", {
        kind: "agent.settled",
        agentId: "a1",
        status: "idle",
      })
      clock.advance(TIMINGS.coalesceMs)
      await settle()
      // A plan WITH actions closes the point: nothing arms.
      registerPlan(engine, 1, false)
      engine.onTurnSettled("sched", null, 1)
      await settle()
      expect(events(db, "decision_point.closed")[0].outcome).toBe("plan")
      clock.advance(TIMINGS.periodicMs + TIMINGS.stallMs + TIMINGS.coalesceMs)
      await settle()
      expect(escalations).toHaveLength(0)
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
      engine.onTurnSettled("solver-1", null, 1)
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
      const { engine } = await makeEngine(db)
      engine.trigger("evt-1", { kind: "boot.resync" })
      await settle()
      registerPlan(engine, 1, false)
      engine.onTurnSettled("sched", null, 1)
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
