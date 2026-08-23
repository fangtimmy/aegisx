import { describe, expect, mock, test } from "bun:test"

import { eq } from "drizzle-orm"

import { agents, channelMessages } from "../../src/db/schema"
import { orchKey } from "../../src/run/channels"
import { createAgentService } from "../../src/run/service"
import {
  flatSettingsWithDefaultModel,
  makeProvider,
  seedChallenge,
  seedEvent,
  setupDb,
  stubConfigStore,
  stubContainerManager,
  stubHostAgentSession,
} from "../helpers"
import { refine } from "../support"

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type Db = ReturnType<typeof setupDb>["db"]

/** The event's orchestrator agent row. */
function orchestratorOf(db: Db, eventId = "evt-1") {
  return db
    .select()
    .from(agents)
    .where(eq(agents.eventId, eventId))
    .all()
    .filter((a) => a.role === "orchestrator")
    .at(-1)!
}

/** orch channel message rows (id order) for an event. */
function orchRows(db: Db, eventId = "evt-1") {
  return db
    .select()
    .from(channelMessages)
    .where(eq(channelMessages.channelKey, orchKey(eventId)))
    .all()
}

function metaOf(row: { meta: string }): Record<string, unknown> {
  return JSON.parse(row.meta)
}

/** Service whose scheduler createHost records prompt texts per agent. */
function makeService(
  db: Db,
  dir: string,
  promptLog: Map<string, string[]>,
  failSolver = false
) {
  const provider = makeProvider()
  const { manager } = stubContainerManager()
  return createAgentService({
    db,
    dataDir: dir,
    containerManager: manager,
    platformService: refine({
      submitFlag: async () => undefined,
      targetAction: async () => ({
        status: "running",
        endpoints: [],
        expiresAt: null,
      }),
    }),
    configStore: stubConfigStore([provider]),
    getSettings: flatSettingsWithDefaultModel,
    createHost: mock(async (input: { agentId: string }) => {
      const stub = stubHostAgentSession("sess-" + input.agentId.slice(0, 6))
      const list: string[] = []
      promptLog.set(input.agentId, list)
      const sdk = refine<{
        prompt: (text: string) => Promise<void>
      }>(stub.session)
      sdk.prompt = async (text: string) => {
        if (failSolver) {
          const row = db
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
}

const tagOf = (agentId: string) =>
  `「Test Challenge」agent-${agentId.slice(0, 8)}`

describe("agent lifecycle events → orch messages (v19)", () => {
  test("started/idle post as NON-urgent orch messages; the live scheduler is not woken until the tick", async () => {
    const { db, dir, close } = setupDb()
    let service: ReturnType<typeof createAgentService> | undefined
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const promptLog = new Map<string, string[]>()
      service = makeService(db, dir, promptLog)

      await service.startScheduler("evt-1")
      await settle()
      const orch = orchestratorOf(db)
      const primed = promptLog.get(orch.id)?.length ?? 0

      const solver = await service.spawn({
        eventId: "evt-1",
        challengeId: "ch-1",
      })
      await settle()

      // Events ARE messages: started (manual marker) + idle both landed in
      // orch as system posts, non-urgent.
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
      // No immediate wake: the scheduler saw nothing new.
      expect(promptLog.get(orch.id)?.length ?? 0).toBe(primed)

      // The tick delivers the backlog as ONE merged steer.
      service.channels.runFlushTick()
      await settle()
      const texts = promptLog.get(orch.id) ?? []
      expect(texts.length).toBe(primed + 1)
      expect(texts.at(-1)).toContain("[频道消息]")
      expect(texts.at(-1)).toContain("已启动（手动）")
      expect(texts.at(-1)).toContain("已空闲")
      service.channels.runFlushTick()
      await settle()
      expect(promptLog.get(orch.id)?.length).toBe(primed + 1)
      await service.close()
    } finally {
      await service?.close().catch(() => undefined)
      close()
    }
  })

  test("flagAccepted and finished post orch messages; a failed settle carries the idle(failed) marker", async () => {
    const { db, dir, close } = setupDb()
    let service: ReturnType<typeof createAgentService> | undefined
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const promptLog = new Map<string, string[]>()
      service = makeService(db, dir, promptLog)

      await service.startScheduler("evt-1")
      await settle()
      expect(orchestratorOf(db).id).toBeTruthy()

      const solver = await service.spawn({
        eventId: "evt-1",
        challengeId: "ch-1",
      })
      await settle()

      service.notifyFlagAccepted("ch-1", solver.id)
      const tag = tagOf(solver.id)
      expect(
        orchRows(db).some(
          (r) =>
            r.body === `${tag}flag 已接受` && metaOf(r).agentId === solver.id
        )
      ).toBe(true)

      await service.finishAgent(solver.id, "solved it")
      await settle()
      expect(
        orchRows(db).some(
          (r) =>
            r.body === `${tag}已完成` &&
            metaOf(r).eventType === "agent.finished" &&
            metaOf(r).urgent !== true
        )
      ).toBe(true)
      await service.close()
    } finally {
      await service?.close().catch(() => undefined)
      close()
    }
  })

  test("a failed solver turn posts idle(failed) so the scheduler can tell a dead solver from a pause", async () => {
    const { db, dir, close } = setupDb()
    let service: ReturnType<typeof createAgentService> | undefined
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const promptLog = new Map<string, string[]>()
      service = makeService(db, dir, promptLog, true)

      await service.startScheduler("evt-1")
      await settle()
      expect(orchestratorOf(db).id).toBeTruthy()

      await service.spawn({ eventId: "evt-1", challengeId: "ch-1" })
      await wait(80)

      expect(
        orchRows(db).some(
          (r) =>
            !r.body.endsWith("「Test Challenge」agent-") &&
            r.body.includes("「Test Challenge」") &&
            r.body.endsWith("已空闲（失败）") &&
            metaOf(r).eventType === "agent.idle"
        )
      ).toBe(true)
      await service.close()
    } finally {
      await service?.close().catch(() => undefined)
      close()
    }
  })

  test("a reopened agent posts agent.reopened", async () => {
    const { db, dir, close } = setupDb()
    let service: ReturnType<typeof createAgentService> | undefined
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const promptLog = new Map<string, string[]>()
      service = makeService(db, dir, promptLog)

      await service.startScheduler("evt-1")
      await settle()
      expect(orchestratorOf(db).id).toBeTruthy()

      const solver = await service.spawn({
        eventId: "evt-1",
        challengeId: "ch-1",
      })
      await settle()
      await service.closeAgent(solver.id)
      await settle()

      // Direct user message → lifecycle.send → onResume reopen; the restore
      // posts agent.reopened into orch.
      await service.sendMessage(solver.id, { text: "继续" })
      await wait(80)
      const tag = tagOf(solver.id)
      expect(
        orchRows(db).some(
          (r) =>
            r.body === `${tag}已重开` &&
            metaOf(r).eventType === "agent.reopened"
        )
      ).toBe(true)
      await service.close()
    } finally {
      await service?.close().catch(() => undefined)
      close()
    }
  })

  test("the queue-starved edge posts an URGENT orch message that wakes the live scheduler immediately", async () => {
    const { db, dir, close } = setupDb()
    let service: ReturnType<typeof createAgentService> | undefined
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      seedChallenge(db, { id: "ch-2", eventId: "evt-1" })
      const promptLog = new Map<string, string[]>()
      service = makeService(db, dir, promptLog)

      await service.startScheduler("evt-1")
      await settle()
      const orch = orchestratorOf(db)
      const primed = promptLog.get(orch.id)?.length ?? 0

      const queue = service.queue()
      const one = queue.enqueue({
        eventId: "evt-1",
        challengeId: "ch-1",
        source: "scheduler",
        prompt: "p1",
      })
      queue.enqueue({
        eventId: "evt-1",
        challengeId: "ch-2",
        source: "scheduler",
        prompt: "p2",
      })
      queue.cancelDrain()
      queue.remove(one.id)
      await settle()

      const urgent = orchRows(db).filter((r) => metaOf(r).urgent === true)
      expect(urgent).toHaveLength(1)
      expect(urgent[0].body).toContain("队列不足")
      expect(metaOf(urgent[0]).noticeType).toBe("emergency")
      // Immediate wake: the scheduler got the steer without any tick.
      const texts = promptLog.get(orch.id) ?? []
      expect(texts.length).toBe(primed + 1)
      expect(texts.at(-1)).toContain("队列不足")
      await service.close()
    } finally {
      await service?.close().catch(() => undefined)
      close()
    }
  })

  test("W3 paused: agent events and queue urgent lines are dropped entirely; resume wakes with the re-sync message", async () => {
    const { db, dir, close } = setupDb()
    let service: ReturnType<typeof createAgentService> | undefined
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const promptLog = new Map<string, string[]>()
      service = makeService(db, dir, promptLog)

      await service.startScheduler("evt-1")
      await settle()
      const orch = orchestratorOf(db)
      const primed = promptLog.get(orch.id)?.length ?? 0

      await service.pauseScheduler("evt-1")
      const solver = await service.spawn({
        eventId: "evt-1",
        challengeId: "ch-1",
      })
      await settle()
      service.notifyFlagAccepted("ch-1", solver.id)
      const queue = service.queue()
      const one = queue.enqueue({
        eventId: "evt-1",
        challengeId: "ch-1",
        source: "scheduler",
        prompt: "p",
      })
      queue.enqueue({
        eventId: "evt-1",
        challengeId: "ch-1",
        source: "scheduler",
        prompt: "q",
      })
      queue.cancelDrain()
      queue.remove(one.id)
      await settle()

      // Silent: no orch rows at all while paused (dropped, not stored).
      expect(orchRows(db)).toHaveLength(0)
      expect(promptLog.get(orch.id)?.length ?? 0).toBe(primed)

      await service.resumeScheduler("evt-1")
      await settle()
      const texts = promptLog.get(orch.id) ?? []
      expect(texts.length).toBeGreaterThan(primed)
      expect(texts.some((t) => t.includes("重新同步"))).toBe(true)
      await service.close()
    } finally {
      await service?.close().catch(() => undefined)
      close()
    }
  })

  test("a terminal scheduler stores events unread; a restart reopens the SAME agent and the tick catches up", async () => {
    const { db, dir, close } = setupDb()
    let service: ReturnType<typeof createAgentService> | undefined
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const promptLog = new Map<string, string[]>()
      service = makeService(db, dir, promptLog)

      const sched = await service.startScheduler("evt-1")
      await settle()
      const orchId = orchestratorOf(db).id

      await service.closeScheduler("evt-1")
      expect(service.getAgent(sched.id)?.status).toBe("aborted")

      // Events while the scheduler is terminal: stored under the stable
      // 'scheduler' cursor, nothing delivered.
      const solver = await service.spawn({
        eventId: "evt-1",
        challengeId: "ch-1",
      })
      await settle()
      const stored = orchRows(db)
      expect(stored.length).toBeGreaterThanOrEqual(2)
      expect(service.channels.unreadCount(orchKey("evt-1"), "scheduler")).toBe(
        stored.length
      )

      // Restore: SAME scheduler agent (memory kept)…
      const restored = await service.startScheduler("evt-1")
      await settle()
      expect(restored.id).toBe(sched.id)

      // …and the next tick sweeps the stored backlog into the orchestrator.
      service.channels.runFlushTick()
      await settle()
      const texts = promptLog.get(orchId) ?? []
      const catchUp = texts.find(
        (t) => t.includes("[频道消息") && t.includes("已启动")
      )
      expect(catchUp).toBeDefined()
      expect(catchUp).toContain("已空闲")
      expect(solver.id).toBeTruthy()
      await service.close()
    } finally {
      await service?.close().catch(() => undefined)
      close()
    }
  })

  test("startScheduler reset recreates: the terminal scheduler is deleted, a fresh one made (W3.2)", async () => {
    const { db, dir, close } = setupDb()
    let service: ReturnType<typeof createAgentService> | undefined
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const promptLog = new Map<string, string[]>()
      service = makeService(db, dir, promptLog)

      const sched = await service.startScheduler("evt-1")
      await settle()
      await service.closeScheduler("evt-1")

      const fresh = await service.startScheduler("evt-1", { reset: true })
      await settle()
      expect(fresh.id).not.toBe(sched.id)
      expect(service.getAgent(sched.id)).toBeUndefined()
      expect(service.getAgent(fresh.id)?.status).toBe("idle")
      await service.close()
    } finally {
      await service?.close().catch(() => undefined)
      close()
    }
  })

  test("scheduler-launched agents carry no manual marker in the orch message (W5)", async () => {
    const { db, dir, close } = setupDb()
    let service: ReturnType<typeof createAgentService> | undefined
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const promptLog = new Map<string, string[]>()
      service = makeService(db, dir, promptLog)

      await service.startScheduler("evt-1")
      await settle()
      expect(orchestratorOf(db).id).toBeTruthy()

      // A scheduler-spawned agent: source='scheduler' — NO manual marker.
      const solver = await service.spawn({
        eventId: "evt-1",
        challengeId: "ch-1",
        source: "scheduler",
      })
      await settle()
      const started = orchRows(db).filter(
        (r) => metaOf(r).eventType === "agent.started"
      )
      expect(started).toHaveLength(1)
      expect(started[0].body).toBe(`${tagOf(solver.id)}已启动`)
      expect(metaOf(started[0]).source).toBe("scheduler")
      await service.close()
    } finally {
      await service?.close().catch(() => undefined)
      close()
    }
  })
})
