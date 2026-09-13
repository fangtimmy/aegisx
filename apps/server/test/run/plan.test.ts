import { describe, expect, mock, test } from "bun:test"

import type { Plan, PlanAction } from "@aegisx/shared"
import { and, eq } from "drizzle-orm"

import type { Database } from "../../src/db"
import {
  agents,
  challenges,
  domainEvents,
  events,
  queueState,
  spawnQueue,
} from "../../src/db/schema"
import {
  agentPrincipal,
  makeAgentService,
  promptRecordingHost,
  seedAgent,
  stubHostAgentSession,
  USER,
} from "../helpers"
import { refine } from "../support"

const SCHED = agentPrincipal("a-sched", {
  challengeId: null,
  role: "orchestrator",
})

function seedScheduler(db: Database): void {
  seedAgent(db, {
    id: "a-sched",
    challengeId: null,
    role: "orchestrator",
    status: "idle",
    name: "Scheduler",
  })
}

/** Seed a second event (cross-event denial cases). */
function seedOtherEvent(db: Database): void {
  db.insert(events)
    .values({ id: "evt-2", name: "Other", createdAt: now(), updatedAt: now() })
    .run()
}

const now = () => new Date("2025-01-01T00:00:00Z").toISOString()

function eventsOf(db: Database, type: string) {
  return db
    .select()
    .from(domainEvents)
    .where(and(eq(domainEvents.eventId, "evt-1"), eq(domainEvents.type, type)))
    .all()
}

function payloadsOf(db: Database, type: string): Record<string, unknown>[] {
  return eventsOf(db, type).map((row) => JSON.parse(row.payload))
}

function planOf(...actions: PlanAction[]): Plan {
  return { rationale: "test rationale", actions }
}

const noOp = (reason: string, ref = "n1"): PlanAction => ({
  ref,
  kind: "noOp",
  reason,
})

/** Poll until `fn` holds (the deferred chain and the drainer run on real
 * timers); returns fn's final value. */
async function until(fn: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (fn()) return true
    await new Promise((r) => setTimeout(r, 10))
  }
  return fn()
}

function makeService() {
  const h = makeAgentService({
    challenge: "ch-a",
    createHost: mock(async (input: { agentId: string }) =>
      stubHostAgentSession("sess-" + input.agentId.slice(0, 6), { hang: true })
    ),
  })
  seedScheduler(h.db)
  return h
}

async function spawnRunningAgent(h: ReturnType<typeof makeService>) {
  const queue = h.service.queue()
  const item = queue.enqueue(
    {
      eventId: "evt-1",
      challengeId: "ch-a",
      source: "scheduler",
      prompt: "go",
    },
    USER
  )
  await queue.drainOnce()
  const launched = queue.list("evt-1", USER).find((i) => i.id === item.id)!
  expect(launched.status).toBe("running")
  return { item: launched, agentId: launched.agentId! }
}

describe("plan validation (whole-plan rejection, per-ref codes)", () => {
  test("empty plan → empty_plan, nothing proposed", async () => {
    const h = makeService()
    try {
      const res = await h.service.submitPlan(
        "evt-1",
        { rationale: "r", actions: [] },
        SCHED
      )
      expect(res.results).toHaveLength(1)
      expect(res.results[0].code).toBe("empty_plan")
      expect(eventsOf(h.db, "plan.proposed")).toHaveLength(0)
    } finally {
      await h.close()
    }
  })

  test("schema: empty noOp reason and missing rationale reject", async () => {
    const h = makeService()
    try {
      const res = await h.service.submitPlan(
        "evt-1",
        { rationale: "r", actions: [{ ref: "n1", kind: "noOp", reason: "" }] },
        SCHED
      )
      expect(res.results[0].code).toBe("schema")
      const noRationale = await h.service.submitPlan(
        "evt-1",
        { rationale: "", actions: [noOp("x")] },
        SCHED
      )
      expect(noRationale.results[0].code).toBe("schema")
      expect(eventsOf(h.db, "plan.proposed")).toHaveLength(0)
    } finally {
      await h.close()
    }
  })

  test("unknown_challenge / model_unresolvable / solved_blocked on enqueue", async () => {
    const h = makeService()
    try {
      const unknown = await h.service.submitPlan(
        "evt-1",
        planOf({ ref: "e1", kind: "enqueue", challengeId: "ch-nope" }),
        SCHED
      )
      expect(unknown.results[0].code).toBe("unknown_challenge")

      const model = await h.service.submitPlan(
        "evt-1",
        planOf({
          ref: "e1",
          kind: "enqueue",
          challengeId: "ch-a",
          model: "aegisx-nope/nope",
        }),
        SCHED
      )
      expect(model.results[0].code).toBe("model_unresolvable")

      h.db
        .update(challenges)
        .set({ manualSolveState: "solved" })
        .where(eq(challenges.id, "ch-a"))
        .run()
      const solved = await h.service.submitPlan(
        "evt-1",
        planOf({ ref: "e1", kind: "enqueue", challengeId: "ch-a" }),
        SCHED
      )
      expect(solved.results[0].code).toBe("solved_blocked")
      expect(eventsOf(h.db, "plan.proposed")).toHaveLength(0)
    } finally {
      await h.close()
    }
  })

  test("unknown_agent (missing / cross-event) and self_target rejection", async () => {
    const h = makeService()
    try {
      const missing = await h.service.submitPlan(
        "evt-1",
        planOf({ ref: "c1", kind: "close", agentId: "a-missing" }),
        SCHED
      )
      expect(missing.results[0].code).toBe("unknown_agent")

      seedOtherEvent(h.db)
      seedAgent(h.db, {
        id: "a-other",
        eventId: "evt-2",
        challengeId: null,
        status: "idle",
      })
      const foreign = await h.service.submitPlan(
        "evt-1",
        planOf({ ref: "c1", kind: "close", agentId: "a-other" }),
        SCHED
      )
      expect(foreign.results[0].code).toBe("unknown_agent")

      const self = await h.service.submitPlan(
        "evt-1",
        planOf({ ref: "c1", kind: "close", agentId: "a-sched" }),
        SCHED
      )
      expect(self.results[0].code).toBe("self_target")
    } finally {
      await h.close()
    }
  })

  test("wrong_state: close on a terminal agent, cancelItem on a running item", async () => {
    const h = makeService()
    try {
      seedAgent(h.db, { id: "a-done", challengeId: "ch-a", status: "aborted" })
      const closed = await h.service.submitPlan(
        "evt-1",
        planOf({ ref: "c1", kind: "close", agentId: "a-done" }),
        SCHED
      )
      expect(closed.results[0].code).toBe("wrong_state")

      const { item } = await spawnRunningAgent(h)
      const cancel = await h.service.submitPlan(
        "evt-1",
        planOf({ ref: "x1", kind: "cancelItem", itemId: item.id }),
        SCHED
      )
      expect(cancel.results[0].code).toBe("wrong_state")
    } finally {
      await h.close()
    }
  })

  test("duplicate refs (intra-plan and vs history with different content)", async () => {
    const h = makeService()
    try {
      const intra = await h.service.submitPlan(
        "evt-1",
        { rationale: "r", actions: [noOp("a", "x1"), noOp("b", "x1")] },
        SCHED
      )
      expect(intra.results.every((r) => r.code === "duplicate_ref")).toBe(true)

      await h.service.submitPlan("evt-1", planOf(noOp("first", "h1")), SCHED)
      const reuse = await h.service.submitPlan(
        "evt-1",
        planOf(noOp("different content", "h1")),
        SCHED
      )
      expect(reuse.results[0].code).toBe("duplicate_ref")
    } finally {
      await h.close()
    }
  })

  test("one failing ref rejects the WHOLE plan: valid siblings are not applied", async () => {
    const h = makeService()
    try {
      const res = await h.service.submitPlan(
        "evt-1",
        planOf(
          { ref: "ok1", kind: "enqueue", challengeId: "ch-a" },
          { ref: "bad1", kind: "enqueue", challengeId: "ch-nope" }
        ),
        SCHED
      )
      expect(res.results).toHaveLength(2)
      expect(res.results[0].ok).toBe(false)
      expect(res.results[0].code).toBeUndefined()
      expect(res.results[1].code).toBe("unknown_challenge")
      expect(h.service.queue().list("evt-1", USER)).toHaveLength(0)
      expect(eventsOf(h.db, "plan.proposed")).toHaveLength(0)
    } finally {
      await h.close()
    }
  })
})

describe("fast phase (inline application)", () => {
  test("enqueue applies inline with plan provenance; proposed + result facts land", async () => {
    const h = makeService()
    try {
      h.service.queue().pause("evt-1", "scheduler", SCHED)
      const res = await h.service.submitPlan(
        "evt-1",
        planOf(
          {
            ref: "e1",
            kind: "enqueue",
            challengeId: "ch-a",
            prompt: "plan work",
          },
          noOp("waiting on fence", "n1")
        ),
        SCHED
      )
      expect(res.results[0]).toMatchObject({ ref: "e1", ok: true })
      expect(res.results[0].itemId).toBeTruthy()
      expect(res.results[1]).toMatchObject({ ref: "n1", ok: true })
      expect(res.deferred).toHaveLength(0)
      // queueAfter shows the fresh pending item.
      expect(
        res.queueAfter.find((i) => i.id === res.results[0].itemId)?.status
      ).toBe("pending")

      // Provenance: the row keeps the actor face, the fact carries plan:<planId>.
      const row = h.db
        .select()
        .from(spawnQueue)
        .where(eq(spawnQueue.id, res.results[0].itemId!))
        .get()!
      expect(row.source).toBe("scheduler")
      const proposed = eventsOf(h.db, "plan.proposed")
      expect(proposed).toHaveLength(1)
      expect(proposed[0].actorId).toBe("a-sched")
      const proposedPayload = JSON.parse(proposed[0].payload)
      expect(proposedPayload.rationale).toBe("test rationale")
      expect(proposedPayload.schedulerAgentId).toBe("a-sched")
      expect(proposedPayload.actions).toHaveLength(2)
      const enqueued = payloadsOf(h.db, "queue.enqueued").find(
        (p) => p.itemId === row.id
      )!
      expect(enqueued.source).toBe(`plan:${proposedPayload.planId}`)

      // All-fast plan: plan.result lands synchronously, causally linked.
      const results = eventsOf(h.db, "plan.result")
      expect(results).toHaveLength(1)
      expect(results[0].causationId).toBe(proposed[0].id)
      const resultPayload = JSON.parse(results[0].payload)
      expect(resultPayload.planId).toBe(proposedPayload.planId)
      expect(resultPayload.results).toHaveLength(2)
    } finally {
      await h.close()
    }
  })

  test("setQueuePaused flips the event's queue state", async () => {
    const h = makeService()
    try {
      const pause = await h.service.submitPlan(
        "evt-1",
        planOf({ ref: "p1", kind: "setQueuePaused", paused: true }),
        SCHED
      )
      expect(pause.results[0].ok).toBe(true)
      expect(
        h.db
          .select()
          .from(queueState)
          .where(eq(queueState.eventId, "evt-1"))
          .get()!.status
      ).toBe("paused")
      // The pause carries its plan's id (§3.8 provenance labeling) — a
      // scheduler that pauses and dies leaves an auditable source.
      const pausedPayload = JSON.parse(
        h.db
          .select({ payload: domainEvents.payload })
          .from(domainEvents)
          .where(eq(domainEvents.type, "queue.paused"))
          .get()!.payload
      )
      expect(pausedPayload.source).toBe("scheduler")
      expect(pausedPayload.planId).toMatch(/^[0-9a-f-]+$/)
      await h.service.submitPlan(
        "evt-1",
        planOf({ ref: "p2", kind: "setQueuePaused", paused: false }),
        SCHED
      )
      expect(
        h.db
          .select()
          .from(queueState)
          .where(eq(queueState.eventId, "evt-1"))
          .get()!.status
      ).toBe("running")
    } finally {
      await h.close()
    }
  })

  test("cancelItem + reorder apply inline on pending items", async () => {
    const h = makeService()
    try {
      h.service.queue().pause("evt-1", "scheduler", SCHED)
      const first = h.service
        .queue()
        .enqueue(
          { eventId: "evt-1", challengeId: "ch-a", source: "scheduler" },
          USER
        )
      const second = h.service
        .queue()
        .enqueue(
          { eventId: "evt-1", challengeId: "ch-a", source: "scheduler" },
          USER
        )
      const res = await h.service.submitPlan(
        "evt-1",
        planOf(
          { ref: "x1", kind: "cancelItem", itemId: first.id },
          { ref: "r1", kind: "reorder", itemIds: [second.id] }
        ),
        SCHED
      )
      expect(res.results[0]).toMatchObject({
        ref: "x1",
        ok: true,
        itemId: first.id,
      })
      expect(
        h.db.select().from(spawnQueue).where(eq(spawnQueue.id, first.id)).get()!
          .status
      ).toBe("cancelled")
      expect(
        h.db
          .select()
          .from(spawnQueue)
          .where(eq(spawnQueue.id, second.id))
          .get()!.ord
      ).toBe(1)
    } finally {
      await h.close()
    }
  })

  test("setDeadline re-arms the agent's horizon", async () => {
    const h = makeService()
    try {
      seedAgent(h.db, { id: "a-live", challengeId: "ch-a", status: "idle" })
      const res = await h.service.submitPlan(
        "evt-1",
        planOf({
          ref: "d1",
          kind: "setDeadline",
          agentId: "a-live",
          timeoutMs: 7_200_000,
        }),
        SCHED
      )
      expect(res.results[0]).toMatchObject({
        ref: "d1",
        ok: true,
        agentId: "a-live",
      })
      const row = h.db
        .select()
        .from(agents)
        .where(eq(agents.id, "a-live"))
        .get()!
      expect(row.timeoutMs).toBe(7_200_000)
      expect(row.deadlineAt).toBeTruthy()
    } finally {
      await h.close()
    }
  })

  test("message to a LIVE agent applies inline (fast phase)", async () => {
    const promptLog = new Map<string, string[]>()
    const h = makeAgentService({
      challenge: "ch-a",
      createHost: promptRecordingHost(promptLog),
    })
    seedScheduler(h.db)
    try {
      const { agentId } = await (async () => {
        const queue = h.service.queue()
        const item = queue.enqueue(
          { eventId: "evt-1", challengeId: "ch-a", source: "scheduler" },
          USER
        )
        await queue.drainOnce()
        return {
          agentId: queue.list("evt-1", USER).find((i) => i.id === item.id)!
            .agentId!,
        }
      })()
      const res = await h.service.submitPlan(
        "evt-1",
        planOf({ ref: "m1", kind: "message", agentId, text: "steer: try z3" }),
        SCHED
      )
      expect(res.results[0]).toMatchObject({ ref: "m1", ok: true, agentId })
      expect(res.deferred).toHaveLength(0)
      expect(promptLog.get(agentId)?.join("\n")).toContain("steer: try z3")
    } finally {
      await h.close()
    }
  })
})

describe("slow phase (per-event deferred chain)", () => {
  test("close is deferred, re-validated, and reported via plan.result", async () => {
    const h = makeService()
    try {
      const { agentId } = await spawnRunningAgent(h)
      const res = await h.service.submitPlan(
        "evt-1",
        planOf({ ref: "c1", kind: "close", agentId }),
        SCHED
      )
      expect(res.deferred).toEqual([{ ref: "c1", kind: "close" }])

      expect(
        await until(() => {
          const row = h.db
            .select()
            .from(agents)
            .where(eq(agents.id, agentId))
            .get()!
          return row.status === "aborted"
        })
      ).toBe(true)
      expect(
        await until(() => eventsOf(h.db, "plan.result").length === 1)
      ).toBe(true)
      const resultPayload = JSON.parse(eventsOf(h.db, "plan.result")[0].payload)
      expect(resultPayload.results[0]).toMatchObject({
        ref: "c1",
        ok: true,
        agentId,
      })
      // Provenance: the terminal fact names the scheduler as its actor.
      const terminated = payloadsOf(h.db, "agent.terminated").at(-1)!
      const terminatedRow = eventsOf(h.db, "agent.terminated").at(-1)!
      expect(terminatedRow.agentId).toBe(agentId)
      expect(terminatedRow.actorId).toBe("a-sched")
      expect(terminated.actor).toBe("agent")
    } finally {
      await h.close()
    }
  })

  test("message to a TERMINAL agent defers (cold wake) and delivers", async () => {
    const promptLog = new Map<string, string[]>()
    const h = makeAgentService({
      challenge: "ch-a",
      createHost: promptRecordingHost(promptLog),
    })
    seedScheduler(h.db)
    try {
      const queue = h.service.queue()
      const item = queue.enqueue(
        { eventId: "evt-1", challengeId: "ch-a", source: "scheduler" },
        USER
      )
      await queue.drainOnce()
      const agentId = queue
        .list("evt-1", USER)
        .find((i) => i.id === item.id)!.agentId!
      await h.service.closeAgent(agentId, USER)
      expect(
        h.db.select().from(agents).where(eq(agents.id, agentId)).get()!.status
      ).toBe("aborted")

      const res = await h.service.submitPlan(
        "evt-1",
        planOf({
          ref: "m1",
          kind: "message",
          agentId,
          text: "wake up, resume",
        }),
        SCHED
      )
      expect(res.deferred).toEqual([{ ref: "m1", kind: "message" }])

      expect(
        await until(() =>
          (promptLog.get(agentId) ?? []).some((t) => t.includes("wake up"))
        )
      ).toBe(true)
      expect(
        await until(() => eventsOf(h.db, "plan.result").length === 1)
      ).toBe(true)
      const resultPayload = JSON.parse(eventsOf(h.db, "plan.result")[0].payload)
      expect(resultPayload.results[0]).toMatchObject({
        ref: "m1",
        ok: true,
        agentId,
      })
    } finally {
      await h.close()
    }
  })

  test("stop is bounded: an abort that outlives the grace force-disposes", async () => {
    const h = makeAgentService({
      challenge: "ch-a",
      closeAbortGraceMs: 50,
      createHost: mock(async (input: { agentId: string }) => {
        const stub = stubHostAgentSession("sess-" + input.agentId.slice(0, 6), {
          hang: true,
        })
        const raw = refine<{
          isStreaming: boolean
          abort: () => Promise<void>
        }>(stub.session)
        raw.isStreaming = true
        // Abort outlives the 50ms grace (real pi aborts can hang on an
        // in-flight tool call) but resolves so the test can wind down.
        raw.abort = () => new Promise((r) => setTimeout(r, 300))
        return stub
      }),
    })
    seedScheduler(h.db)
    try {
      const { agentId } = await spawnRunningAgent(h)
      const res = await h.service.submitPlan(
        "evt-1",
        planOf({ ref: "s1", kind: "stop", agentId }),
        SCHED
      )
      expect(res.deferred).toEqual([{ ref: "s1", kind: "stop" }])
      // Expiry force-disposes through the standard settle path → aborted.
      expect(
        await until(() => {
          const row = h.db
            .select()
            .from(agents)
            .where(eq(agents.id, agentId))
            .get()!
          return row.status === "aborted"
        })
      ).toBe(true)
      expect(
        await until(() => eventsOf(h.db, "plan.result").length === 1)
      ).toBe(true)
      const resultPayload = JSON.parse(eventsOf(h.db, "plan.result")[0].payload)
      expect(resultPayload.results[0]).toMatchObject({ ref: "s1", ok: true })
    } finally {
      await h.close()
    }
  })

  test("slow action re-validated at apply time: a sibling close makes the second close wrong_state", async () => {
    const h = makeService()
    try {
      const { agentId } = await spawnRunningAgent(h)
      const res = await h.service.submitPlan(
        "evt-1",
        planOf(
          { ref: "c1", kind: "close", agentId },
          { ref: "c2", kind: "close", agentId }
        ),
        SCHED
      )
      expect(res.deferred).toHaveLength(2)
      expect(
        await until(() => eventsOf(h.db, "plan.result").length === 1)
      ).toBe(true)
      const resultPayload = JSON.parse(eventsOf(h.db, "plan.result")[0].payload)
      expect(resultPayload.results[0]).toMatchObject({ ref: "c1", ok: true })
      expect(resultPayload.results[1]).toMatchObject({
        ref: "c2",
        ok: false,
        code: "wrong_state",
      })
    } finally {
      await h.close()
    }
  })
})

describe("idempotency (scheduler, ref) dedup", () => {
  test("identical resubmission returns the original outcome without re-applying", async () => {
    const h = makeService()
    try {
      h.service.queue().pause("evt-1", "scheduler", SCHED)
      const submit = () =>
        h.service.submitPlan(
          "evt-1",
          planOf({
            ref: "e1",
            kind: "enqueue",
            challengeId: "ch-a",
            prompt: "p1",
          }),
          SCHED
        )
      const first = await submit()
      expect(first.results[0].ok).toBe(true)
      const again = await submit()
      expect(again.results[0].ok).toBe(true)
      expect(again.results[0].itemId).toBe(first.results[0].itemId)
      // No double-enqueue, no re-proposal.
      expect(h.service.queue().list("evt-1", USER)).toHaveLength(1)
      expect(eventsOf(h.db, "plan.proposed")).toHaveLength(1)
    } finally {
      await h.close()
    }
  })

  test("a mixed plan replays the known ref and applies the fresh one", async () => {
    const h = makeService()
    try {
      h.service.queue().pause("evt-1", "scheduler", SCHED)
      await h.service.submitPlan(
        "evt-1",
        planOf({
          ref: "e1",
          kind: "enqueue",
          challengeId: "ch-a",
          prompt: "p1",
        }),
        SCHED
      )
      const res = await h.service.submitPlan(
        "evt-1",
        planOf(
          { ref: "e1", kind: "enqueue", challengeId: "ch-a", prompt: "p1" },
          { ref: "e2", kind: "enqueue", challengeId: "ch-a", prompt: "p2" }
        ),
        SCHED
      )
      expect(res.results[0].itemId).toBeTruthy()
      expect(res.results[1].itemId).toBeTruthy()
      expect(res.results[0].itemId).not.toBe(res.results[1].itemId)
      expect(h.service.queue().list("evt-1", USER)).toHaveLength(2)
      expect(eventsOf(h.db, "plan.proposed")).toHaveLength(2)
    } finally {
      await h.close()
    }
  })
})

describe("fence interplay (close frees the slot, the queue refills)", () => {
  test("plan [close(X), enqueue(A)]: A waits pending, launches after X terminalizes", async () => {
    const h = makeService()
    try {
      // Saturate the global cap (4): three seeded running agents + X.
      for (const id of ["w1", "w2", "w3"]) {
        seedAgent(h.db, { id, challengeId: "ch-a", status: "running" })
      }
      const { agentId: victim, item: victimItem } = await spawnRunningAgent(h)
      expect(
        h.db
          .select()
          .from(spawnQueue)
          .where(eq(spawnQueue.id, victimItem.id))
          .get()!.status
      ).toBe("running")

      const res = await h.service.submitPlan(
        "evt-1",
        planOf(
          { ref: "c1", kind: "close", agentId: victim },
          { ref: "e1", kind: "enqueue", challengeId: "ch-a", prompt: "refill" }
        ),
        SCHED
      )
      // Fast phase: the enqueue is already pending; the close is deferred.
      const refill = res.results.find((r) => r.ref === "e1")!
      expect(refill.ok).toBe(true)
      expect(res.queueAfter.find((i) => i.id === refill.itemId)?.status).toBe(
        "pending"
      )

      // The deferred close frees the slot; the drainer picks the pending item up.
      expect(
        await until(() => {
          const row = h.db
            .select()
            .from(agents)
            .where(eq(agents.id, victim))
            .get()!
          return row.status === "aborted"
        })
      ).toBe(true)
      expect(
        await until(() => {
          const item = h.db
            .select()
            .from(spawnQueue)
            .where(eq(spawnQueue.id, refill.itemId!))
            .get()!
          return item.status === "running" && item.agentId !== null
        })
      ).toBe(true)
      expect(
        await until(() => eventsOf(h.db, "plan.result").length === 1)
      ).toBe(true)
      const resultPayload = JSON.parse(eventsOf(h.db, "plan.result")[0].payload)
      expect(
        resultPayload.results.find((r: { ref: string }) => r.ref === "c1")
      ).toMatchObject({
        ok: true,
      })
      expect(
        resultPayload.results.find((r: { ref: string }) => r.ref === "e1")
      ).toMatchObject({
        ok: true,
      })
    } finally {
      await h.close()
    }
  })
})
