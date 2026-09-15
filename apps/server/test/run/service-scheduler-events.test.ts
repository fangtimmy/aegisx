import { describe, expect, mock, test } from "bun:test"

import { eq } from "drizzle-orm"

import { agents, channelMessages, domainEvents } from "../../src/db/schema"
import { orchKey } from "../../src/run/channels"
import {
  makeAgentService,
  seedChallenge,
  stubHostAgentSession,
  USER,
} from "../helpers"
import { refine } from "../support"

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

/** Poll until cond() holds or the deadline passes (the engine drives turns
 * through async chains; tests need the settled end-state). */
async function waitUntil(cond: () => boolean, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitUntil timed out")
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** The event's orchestrator agent row. */
function orchestratorOf(
  db: ReturnType<typeof makeService>["db"],
  eventId = "evt-1"
) {
  return db
    .select()
    .from(agents)
    .where(eq(agents.eventId, eventId))
    .all()
    .filter((a) => a.role === "orchestrator")
    .at(-1)!
}

/** orch channel message rows (id order) for an event — the LEDGER. */
function orchRows(db: ReturnType<typeof makeService>["db"], eventId = "evt-1") {
  return db
    .select()
    .from(channelMessages)
    .where(eq(channelMessages.channelKey, orchKey(eventId)))
    .all()
}

function metaOf(row: { meta: string }): Record<string, unknown> {
  return JSON.parse(row.meta)
}

function decisionPoints(db: ReturnType<typeof makeService>["db"]) {
  return db
    .select({ type: domainEvents.type, payload: domainEvents.payload })
    .from(domainEvents)
    .all()
    .filter(
      (r) =>
        r.type === "decision_point.opened" || r.type === "decision_point.closed"
    )
    .map((r) => ({ type: r.type, ...JSON.parse(r.payload) }))
}

/** Service whose scheduler createHost records prompt texts per agent. The
 * decision-point engine's timings are shrunk so coalesced triggers fire
 * within test waits; the periodic tick is pushed far away. */
function makeService(promptLog: Map<string, string[]>, failSolver = false) {
  const h = makeAgentService({
    decisionTimings: { coalesceMs: 5, errorRetryMs: 20, periodicMs: 3_600_000 },
    createHost: mock(async (input: { agentId: string }) => {
      const stub = stubHostAgentSession("sess-" + input.agentId.slice(0, 6))
      const list: string[] = []
      promptLog.set(input.agentId, list)
      const sdk = refine<{
        prompt: (text: string) => Promise<void>
      }>(stub.session)
      sdk.prompt = async (text: string) => {
        if (failSolver) {
          const row = h.db
            .select()
            .from(agents)
            .where(eq(agents.id, input.agentId))
            .get()
          if (row?.role === "solver") throw new Error("boom")
        }
        list.push(text)
      }
      return stub
    }),
  })
  return { h, db: h.db, service: h.service }
}

const tagOf = (agentId: string) =>
  `「Test Challenge」agent-${agentId.slice(0, 8)}`

describe("decision points drive the scheduler (§3.6)", () => {
  test("lifecycle lines stay in the orch ledger; a solver settle opens a decision point whose payload is injected (not delivered)", async () => {
    const promptLog = new Map<string, string[]>()
    let made: ReturnType<typeof makeService> | undefined
    try {
      made = makeService(promptLog)
      const { db, service } = made

      await service.startScheduler("evt-1")
      await settle()
      const orch = orchestratorOf(db)
      const primed = promptLog.get(orch.id)?.length ?? 0

      const solver = await service.spawn(
        {
          eventId: "evt-1",
          challengeId: "ch-1",
        },
        USER
      )
      await settle()

      // Events ARE ledger rows: started (manual marker) + idle, non-urgent,
      // stored for the scheduler's SDK reads.
      const rows = orchRows(db)
      const tag = tagOf(solver.id)
      expect(
        rows.some(
          (r) =>
            r.body === `${tag}已启动（手动）` &&
            metaOf(r).eventType === "agent.started"
        )
      ).toBe(true)
      expect(
        rows.some(
          (r) =>
            r.body === `${tag}已空闲` && metaOf(r).eventType === "agent.idle"
        )
      ).toBe(true)
      expect(rows.every((r) => metaOf(r).urgent !== true)).toBe(true)

      // The settle opened ONE decision point (agent.settled) whose payload
      // — not a [频道消息] delivery — reached the scheduler's session.
      await waitUntil(() => (promptLog.get(orch.id)?.length ?? 0) >= primed + 2)
      const texts = promptLog.get(orch.id) ?? []
      const payload = texts[primed]
      expect(payload).toContain("[决策点")
      expect(payload).toContain("agent.settled：")
      expect(payload).toContain("submit_plan")
      expect(payload).not.toContain("[频道消息]")
      // The turn produced no plan → ONE strict re-prompt, then a violation.
      expect(texts[primed + 1]).toContain("违约提醒")
      await waitUntil(() =>
        decisionPoints(db).some((d) => d.type === "decision_point.closed")
      )
      const closed = decisionPoints(db).find(
        (d) => d.type === "decision_point.closed"
      )
      expect(closed?.outcome).toBe("violation")
    } finally {
      await made?.h.close().catch(() => undefined)
    }
  })

  test("the scheduler's plan closes the point via the native submit_plan tool (registered mid-turn)", async () => {
    const promptLog = new Map<string, string[]>()
    /** extraTools each session was built with (role-injection probe). */
    const extraTools = new Map<string, Array<{ name: string }>>()
    let made: ReturnType<typeof makeAgentService> | undefined
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    try {
      const h = makeAgentService({
        decisionTimings: {
          coalesceMs: 5,
          errorRetryMs: 20,
          periodicMs: 3_600_000,
        },
        createHost: mock(
          async (input: {
            agentId: string
            extraTools?: Array<{ name: string }>
          }) => {
            const stub = stubHostAgentSession(
              "sess-" + input.agentId.slice(0, 6)
            )
            extraTools.set(input.agentId, input.extraTools ?? [])
            const list: string[] = []
            promptLog.set(input.agentId, list)
            const sdk = refine<{
              prompt: (text: string) => Promise<void>
            }>(stub.session)
            sdk.prompt = async (text: string) => {
              list.push(text)
              // Only the scheduler's decision-point turn hangs on the gate.
              if (text.includes("回合协议")) await gate
            }
            return stub
          }
        ),
      })
      made = h
      const { db, service } = h

      await service.startScheduler("evt-1")
      await settle()
      const orch = orchestratorOf(db)

      // B 批 injection: the orchestrator session carries the native tool,
      // spawned by ROLE (not the row's tools snapshot).
      const submitPlanTool = refine<
        | {
            execute: (
              id: string,
              params: unknown
            ) => Promise<{ content: Array<{ text: string }> }>
          }
        | undefined
      >((extraTools.get(orch.id) ?? []).find((t) => t.name === "submit_plan"))
      expect(submitPlanTool).toBeTruthy()
      expect(JSON.parse(orch.tools)).toEqual(["submit_plan"])

      const solver = await service.spawn(
        { eventId: "evt-1", challengeId: "ch-1" },
        USER
      )
      expect(
        (extraTools.get(solver.id) ?? []).some((t) => t.name === "submit_plan")
      ).toBe(false)
      await settle()
      // The decision-point turn is now mid-flight (hung in prompt) — match
      // the payload's protocol demand, not the initial prompt.
      await waitUntil(() =>
        (promptLog.get(orch.id) ?? []).some((t) => t.includes("回合协议"))
      )
      expect(
        decisionPoints(db).some((d) => d.type === "decision_point.opened")
      ).toBe(true)

      // The scheduler "calls the tool" mid-turn: in-process applier + a plan
      // registration stamped with the in-flight turn's generation.
      const result = await submitPlanTool!.execute("call-1", {
        rationale: "quiet round, nothing to do",
        actions: [{ ref: "r1", kind: "noOp", reason: "no change" }],
      })
      const parsed = refine<{
        planId: string
        results: Array<{ ref: string; ok: boolean; kind: string }>
      }>(JSON.parse(result.content[0]?.text ?? "{}"))
      expect(parsed.planId).toBeTruthy()
      expect(parsed.results[0]).toMatchObject({ ref: "r1", ok: true })

      release()
      await waitUntil(() =>
        decisionPoints(db).some((d) => d.type === "decision_point.closed")
      )
      const closed = decisionPoints(db).find(
        (d) => d.type === "decision_point.closed"
      )
      expect(closed?.outcome).toBe("plan")
    } finally {
      release()
      await made?.close().catch(() => undefined)
    }
  })

  test("a plan submitted over the HTTP endpoint (no tool, no registration) does NOT close the point", async () => {
    const promptLog = new Map<string, string[]>()
    let made: ReturnType<typeof makeAgentService> | undefined
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    try {
      const h = makeAgentService({
        decisionTimings: {
          coalesceMs: 5,
          errorRetryMs: 20,
          periodicMs: 3_600_000,
        },
        createHost: mock(async (input: { agentId: string }) => {
          const stub = stubHostAgentSession("sess-" + input.agentId.slice(0, 6))
          const list: string[] = []
          promptLog.set(input.agentId, list)
          const sdk = refine<{
            prompt: (text: string) => Promise<void>
          }>(stub.session)
          sdk.prompt = async (text: string) => {
            list.push(text)
            if (text.includes("回合协议")) await gate
          }
          return stub
        }),
      })
      made = h
      const { db, service } = h

      await service.startScheduler("evt-1")
      await settle()
      const orch = orchestratorOf(db)
      const solver = await service.spawn(
        { eventId: "evt-1", challengeId: "ch-1" },
        USER
      )
      await settle()
      await waitUntil(() =>
        (promptLog.get(orch.id) ?? []).some((t) => t.includes("回合协议"))
      )

      // The escape hatch is admitted (the endpoint's verdict allows this
      // event's scheduler) but never registers → the ladder owns the turn.
      await service.submitPlan(
        "evt-1",
        {
          rationale: "endpoint plan",
          actions: [{ ref: "r1", kind: "noOp", reason: "no change" }],
        },
        {
          kind: "agent",
          agentId: orch.id,
          eventId: "evt-1",
          challengeId: null,
          role: "orchestrator",
        }
      )
      release()
      await waitUntil(() =>
        decisionPoints(db).some((d) => d.type === "decision_point.closed")
      )
      const closed = decisionPoints(db).find(
        (d) => d.type === "decision_point.closed"
      )
      expect(closed?.outcome).toBe("violation")
      expect(solver.id).toBeTruthy()
    } finally {
      release()
      await made?.close().catch(() => undefined)
    }
  })

  test("a first flag acceptance is an URGENT trigger: the decision point flushes without the window", async () => {
    const promptLog = new Map<string, string[]>()
    let made: ReturnType<typeof makeService> | undefined
    try {
      made = makeService(promptLog)
      const { db, service } = made

      await service.startScheduler("evt-1")
      await settle()
      const orch = orchestratorOf(db)
      const primed = promptLog.get(orch.id)?.length ?? 0

      const solver = await service.spawn(
        { eventId: "evt-1", challengeId: "ch-1" },
        USER
      )
      await settle()
      // Drain the settle's decision point (payload + re-prompt + violation).
      await waitUntil(() => (promptLog.get(orch.id)?.length ?? 0) >= primed + 2)
      const afterSettle = promptLog.get(orch.id)!.length
      const closedAfterSettle = decisionPoints(db).filter(
        (d) => d.type === "decision_point.closed"
      ).length

      // First flag: urgent → the next payload arrives without waiting.
      service.notifyFlagAccepted("ch-1", solver.id)
      await settle()
      const texts = promptLog.get(orch.id) ?? []
      expect(texts.length).toBeGreaterThan(afterSettle)
      const flagPayload = texts.at(-2)!
      expect(flagPayload).toContain("flag.accepted：")
      expect(flagPayload).toContain("首次解出")
      expect(flagPayload).toContain("submit_plan")
      await waitUntil(
        () =>
          decisionPoints(db).filter((d) => d.type === "decision_point.closed")
            .length > closedAfterSettle
      )
    } finally {
      await made?.h.close().catch(() => undefined)
    }
  })

  test("W3 paused: no orch rows and no decision points; resume opens a user.directive re-sync point", async () => {
    const promptLog = new Map<string, string[]>()
    let made: ReturnType<typeof makeService> | undefined
    try {
      made = makeService(promptLog)
      const { db, service } = made

      await service.startScheduler("evt-1")
      await settle()
      const orch = orchestratorOf(db)
      const primed = promptLog.get(orch.id)?.length ?? 0

      await service.pauseScheduler("evt-1")
      const solver = await service.spawn(
        { eventId: "evt-1", challengeId: "ch-1" },
        USER
      )
      await settle()
      service.notifyFlagAccepted("ch-1", solver.id)
      await settle()
      await service.queue().enqueue(
        {
          eventId: "evt-1",
          challengeId: "ch-1",
          source: "scheduler",
          prompt: "p",
        },
        USER
      )
      await settle()

      // Silent: no orch rows, no decision points, no payloads.
      expect(orchRows(db)).toHaveLength(0)
      expect(decisionPoints(db)).toHaveLength(0)
      expect(promptLog.get(orch.id)?.length ?? 0).toBe(primed)

      await service.resumeScheduler("evt-1")
      await settle()
      await waitUntil(() => (promptLog.get(orch.id)?.length ?? 0) >= primed + 1)
      const texts = promptLog.get(orch.id) ?? []
      const payload = texts[primed]
      expect(payload).toContain("[决策点")
      expect(payload).toContain("调度已恢复")
      expect(payload).toContain("aegisx.snapshot()")
      const opened = decisionPoints(db).find(
        (d) => d.type === "decision_point.opened"
      )
      expect(opened).toBeTruthy()
      expect(Array.isArray(opened.triggers) && opened.triggers[0]).toContain(
        "user.directive"
      )
    } finally {
      await made?.h.close().catch(() => undefined)
    }
  })

  test("a terminal scheduler stores events unread; a restart reopens the SAME agent with a reviving decision point (no delivery catch-up)", async () => {
    const promptLog = new Map<string, string[]>()
    let made: ReturnType<typeof makeService> | undefined
    try {
      made = makeService(promptLog)
      const { db, service } = made

      const sched = await service.startScheduler("evt-1")
      await settle()
      const orchId = orchestratorOf(db).id

      await service.closeScheduler("evt-1")
      expect(service.getAgent(sched.id)?.status).toBe("aborted")

      // Events while the scheduler is terminal: stored under the stable
      // 'scheduler' cursor, nothing delivered (the SDK replays the ledger).
      const solver = await service.spawn(
        { eventId: "evt-1", challengeId: "ch-1" },
        USER
      )
      await settle()
      const stored = orchRows(db)
      expect(stored.length).toBeGreaterThanOrEqual(2)

      // Restore: SAME scheduler agent (memory kept) + a user.directive
      // decision point cold-resumes it.
      const restored = await service.startScheduler("evt-1")
      await settle()
      expect(restored.id).toBe(sched.id)
      await waitUntil(() => (promptLog.get(orchId)?.length ?? 0) >= 1)
      const payload = promptLog.get(orchId)![0]
      expect(payload).toContain("[决策点")
      expect(payload).toContain("调度已恢复")
      expect(payload).not.toContain("[频道消息]")
      // The ledger backlog stays unread for the scheduler's own reads.
      expect(service.channels.unreadCount(orchKey("evt-1"), "scheduler")).toBe(
        stored.length
      )
      expect(solver.id).toBeTruthy()
    } finally {
      await made?.h.close().catch(() => undefined)
    }
  })

  test("startScheduler reset recreates: the terminal scheduler is deleted, a fresh one made (W3.2)", async () => {
    const promptLog = new Map<string, string[]>()
    let made: ReturnType<typeof makeService> | undefined
    try {
      made = makeService(promptLog)
      const { service } = made

      const sched = await service.startScheduler("evt-1")
      await settle()
      await service.closeScheduler("evt-1")

      const fresh = await service.startScheduler("evt-1", { reset: true })
      await settle()
      expect(fresh.id).not.toBe(sched.id)
      expect(service.getAgent(sched.id)).toBeUndefined()
      expect(service.getAgent(fresh.id)?.status).toBe("idle")
    } finally {
      await made?.h.close().catch(() => undefined)
    }
  })

  test("scheduler-spawned agents carry no manual marker in the orch ledger (W5)", async () => {
    const promptLog = new Map<string, string[]>()
    let made: ReturnType<typeof makeService> | undefined
    try {
      made = makeService(promptLog)
      const { db, service } = made

      await service.startScheduler("evt-1")
      await settle()
      expect(orchestratorOf(db).id).toBeTruthy()

      const solver = await service.spawn(
        {
          eventId: "evt-1",
          challengeId: "ch-1",
          source: "scheduler",
        },
        USER
      )
      await settle()
      const started = orchRows(db).filter(
        (r) => metaOf(r).eventType === "agent.started"
      )
      expect(started).toHaveLength(1)
      expect(started[0].body).toBe(`${tagOf(solver.id)}已启动`)
      expect(metaOf(started[0]).source).toBe("scheduler")
    } finally {
      await made?.h.close().catch(() => undefined)
    }
  })

  test("the queue's low-water edge rides a queue.changed decision point", async () => {
    const promptLog = new Map<string, string[]>()
    let made: ReturnType<typeof makeService> | undefined
    try {
      made = makeService(promptLog)
      const { db, service } = made
      seedChallenge(db, { id: "ch-2", eventId: "evt-1" })

      await service.startScheduler("evt-1")
      await settle()
      const orch = orchestratorOf(db)
      const primed = promptLog.get(orch.id)?.length ?? 0

      const queue = service.queue()
      const one = queue.enqueue(
        {
          eventId: "evt-1",
          challengeId: "ch-1",
          source: "scheduler",
          prompt: "p1",
        },
        USER
      )
      queue.enqueue(
        {
          eventId: "evt-1",
          challengeId: "ch-2",
          source: "scheduler",
          prompt: "p2",
        },
        USER
      )
      queue.cancelDrain()
      queue.remove("evt-1", one.id, USER)
      await settle()
      await waitUntil(() => (promptLog.get(orch.id)?.length ?? 0) >= primed + 1)
      const payload = promptLog.get(orch.id)![primed]
      expect(payload).toContain("[决策点")
      expect(payload).toContain("queue.changed：队列低水位（待发 1）")
      // The old starved-edge emergency notice is gone — no urgent orch line.
      expect(orchRows(db).every((r) => metaOf(r).urgent !== true)).toBe(true)
    } finally {
      await made?.h.close().catch(() => undefined)
    }
  })

  test("recoverOnBoot re-enters via a boot.resync decision point (replaces boot-reentry)", async () => {
    const promptLog = new Map<string, string[]>()
    let made: ReturnType<typeof makeService> | undefined
    try {
      made = makeService(promptLog)
      const { db, service } = made

      await service.startScheduler("evt-1")
      await settle()
      const scheduler = orchestratorOf(db)
      const primed = promptLog.get(scheduler.id)?.length ?? 0
      await service.spawn({ eventId: "evt-1", challengeId: "ch-1" }, USER)
      await settle()
      await service.spawn({ eventId: "evt-1", challengeId: "ch-1" }, USER)

      await service.recoverOnBoot()
      await waitUntil(
        () => (promptLog.get(scheduler.id)?.length ?? 0) >= primed + 1
      )
      const payload = promptLog.get(scheduler.id)!.at(-1)!
      expect(payload).toContain("[决策点")
      expect(payload).toContain("boot.resync：服务已重启")
      expect(payload).toContain("重新同步")
      const opened = decisionPoints(db).filter(
        (d) => d.type === "decision_point.opened"
      )
      expect(
        opened.some(
          (d) =>
            Array.isArray(d.triggers) &&
            d.triggers.some((t: string) => t.includes("boot.resync"))
        )
      ).toBe(true)
    } finally {
      await made?.h.close().catch(() => undefined)
    }
  })
})
