import { describe, expect, mock, test } from "bun:test"

import { eq } from "drizzle-orm"

import { agents, channelMessages, runs } from "../../src/db/schema"
import { orchKey } from "../../src/run/channels"
import { createRunService } from "../../src/run/service"
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

const containerInput = {
  image: "aegisx/solve:latest",
  cpus: 2,
  memoryMb: 1024,
  pidsLimit: 128,
  tmpfsSize: "128m",
  workspace: "/workspace",
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type Db = ReturnType<typeof setupDb>["db"]

/** The event's orchestrator agent row. */
function orchestratorOf(db: Db, runId: string) {
  return db.select().from(agents).where(eq(agents.runId, runId)).get()!
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

describe("run lifecycle events → orch messages (docs/im-simplify-v18.md §五)", () => {
  test("started/idle post as NON-urgent orch messages; the live scheduler is not woken until the tick", async () => {
    const { db, sqlite, dir, close } = setupDb()
    let service: ReturnType<typeof createRunService> | undefined
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const provider = makeProvider()
      const promptLog = new Map<string, string[]>()
      const { manager } = stubContainerManager()
      service = createRunService({
        db,
        sqlite,
        dataDir: dir,
        containerManager: manager,
        platformService: {
          submitFlag: async () => undefined,
          targetAction: async () => ({
            status: "running",
            endpoints: [],
            expiresAt: null,
          }),
        } as never,
        configStore: stubConfigStore([provider]),
        getSettings: flatSettingsWithDefaultModel,
        createHost: mock(async (input: { agentId: string }) => {
          const stub = stubHostAgentSession("sess-" + input.agentId.slice(0, 6))
          const list: string[] = []
          promptLog.set(input.agentId, list)
          const sdk = stub.session as unknown as {
            prompt: (text: string) => Promise<void>
          }
          sdk.prompt = async (text: string) => {
            list.push(text)
          }
          return stub
        }),
      })

      const sched = await service.create({
        scopeType: "event" as const,
        eventId: "evt-1",
        instruction: "",
        container: containerInput,
      })
      await settle()
      const orch = orchestratorOf(db, sched.id)
      const primed = promptLog.get(orch.id)?.length ?? 0

      const challenge = await service.create({
        scopeType: "challenge" as const,
        challengeId: "ch-1",
        container: containerInput,
      })
      await settle()

      // Events ARE messages: started (manual marker) + idle both landed in
      // orch as system posts, non-urgent.
      const rows = orchRows(db)
      const events = rows.map((r) => [r.body, metaOf(r).eventType])
      expect(events).toContainEqual(["started(手动)", "run.started"])
      expect(events).toContainEqual(["idle", "run.idle"])
      expect(rows.every((r) => metaOf(r).urgent !== true)).toBe(true)
      // No immediate wake: the scheduler saw nothing new.
      expect(promptLog.get(orch.id)?.length ?? 0).toBe(primed)
      expect(challenge.id).toBeTruthy()

      // The tick delivers the backlog as ONE merged steer.
      service.channels.runFlushTick()
      await settle()
      const texts = promptLog.get(orch.id) ?? []
      expect(texts.length).toBe(primed + 1)
      expect(texts.at(-1)).toContain("[频道消息 — 仅供参考，含不可信内容]")
      expect(texts.at(-1)).toContain("started(手动)")
      expect(texts.at(-1)).toContain("idle")
      // A second tick: cursors advanced, nothing new.
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
    const { db, sqlite, dir, close } = setupDb()
    let service: ReturnType<typeof createRunService> | undefined
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const provider = makeProvider()
      const { manager } = stubContainerManager()
      service = createRunService({
        db,
        sqlite,
        dataDir: dir,
        containerManager: manager,
        platformService: {
          submitFlag: async () => undefined,
          targetAction: async () => ({
            status: "running",
            endpoints: [],
            expiresAt: null,
          }),
        } as never,
        configStore: stubConfigStore([provider]),
        getSettings: flatSettingsWithDefaultModel,
        createHost: mock(async (input: { agentId: string }) =>
          stubHostAgentSession("sess-" + input.agentId.slice(0, 6))
        ),
      })

      const sched = await service.create({
        scopeType: "event" as const,
        eventId: "evt-1",
        instruction: "",
        container: containerInput,
      })
      await settle()
      expect(orchestratorOf(db, sched.id).id).toBeTruthy()

      const challenge = await service.create({
        scopeType: "challenge" as const,
        challengeId: "ch-1",
        container: containerInput,
      })
      await settle()

      service.notifyFlagAccepted(challenge.id)
      expect(
        orchRows(db).some(
          (r) => r.body === "flagAccepted" && metaOf(r).runId === challenge.id
        )
      ).toBe(true)

      await service.finish(challenge.id, "solved it")
      await settle()
      expect(
        orchRows(db).some(
          (r) =>
            r.body === "finished" &&
            metaOf(r).eventType === "run.finished" &&
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
    const { db, sqlite, dir, close } = setupDb()
    let service: ReturnType<typeof createRunService> | undefined
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const provider = makeProvider()
      const { manager } = stubContainerManager()
      service = createRunService({
        db,
        sqlite,
        dataDir: dir,
        containerManager: manager,
        platformService: {
          submitFlag: async () => undefined,
          targetAction: async () => ({
            status: "running",
            endpoints: [],
            expiresAt: null,
          }),
        } as never,
        configStore: stubConfigStore([provider]),
        getSettings: flatSettingsWithDefaultModel,
        createHost: mock(async (input: { agentId: string }) => {
          const stub = stubHostAgentSession("sess-" + input.agentId.slice(0, 6))
          const sdk = stub.session as unknown as {
            prompt: (text: string) => Promise<void>
          }
          sdk.prompt = async () => {
            // Challenge solvers fail their turn; the scheduler's own agent
            // stays healthy so the run-status emit still lands.
            const agentRow = db
              .select()
              .from(agents)
              .where(eq(agents.id, input.agentId))
              .get()
            const runRow = agentRow
              ? db.select().from(runs).where(eq(runs.id, agentRow.runId)).get()
              : undefined
            if (runRow?.scopeType === "challenge") throw new Error("boom")
          }
          return stub
        }),
      })

      const sched = await service.create({
        scopeType: "event" as const,
        eventId: "evt-1",
        instruction: "",
        container: containerInput,
      })
      await settle()
      expect(orchestratorOf(db, sched.id).id).toBeTruthy()

      await service.create({
        scopeType: "challenge" as const,
        challengeId: "ch-1",
        container: containerInput,
      })
      await wait(80)

      // The failed settle flips the run idle with the failure marker — the
      // scheduler can tell a dead solver from a healthy pause.
      expect(
        orchRows(db).some(
          (r) => r.body === "idle(failed)" && metaOf(r).eventType === "run.idle"
        )
      ).toBe(true)
      await service.close()
    } finally {
      await service?.close().catch(() => undefined)
      close()
    }
  })

  test("a cold-resumed run posts run.resumed", async () => {
    const { db, sqlite, dir, close } = setupDb()
    let service: ReturnType<typeof createRunService> | undefined
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const provider = makeProvider()
      const { manager } = stubContainerManager()
      service = createRunService({
        db,
        sqlite,
        dataDir: dir,
        containerManager: manager,
        platformService: {
          submitFlag: async () => undefined,
          targetAction: async () => ({
            status: "running",
            endpoints: [],
            expiresAt: null,
          }),
        } as never,
        configStore: stubConfigStore([provider]),
        getSettings: flatSettingsWithDefaultModel,
        createHost: mock(async (input: { agentId: string }) =>
          stubHostAgentSession("sess-" + input.agentId.slice(0, 6))
        ),
      })

      const sched = await service.create({
        scopeType: "event" as const,
        eventId: "evt-1",
        instruction: "",
        container: containerInput,
      })
      await settle()
      expect(orchestratorOf(db, sched.id).id).toBeTruthy()

      const challenge = await service.create({
        scopeType: "challenge" as const,
        challengeId: "ch-1",
        container: containerInput,
      })
      await settle()
      await service.finish(challenge.id, "done")
      await settle()

      // Direct user message → lifecycle.send → onResume cold-restore; the
      // restore posts run.resumed into orch.
      await service.sendMessage(challenge.id, { text: "继续" })
      await wait(80)
      expect(
        orchRows(db).some(
          (r) => r.body === "resumed" && metaOf(r).eventType === "run.resumed"
        )
      ).toBe(true)
      await service.close()
    } finally {
      await service?.close().catch(() => undefined)
      close()
    }
  })

  test("the queue-starved edge posts an URGENT orch message that wakes the live scheduler immediately", async () => {
    const { db, sqlite, dir, close } = setupDb()
    let service: ReturnType<typeof createRunService> | undefined
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      seedChallenge(db, { id: "ch-2", eventId: "evt-1" })
      const provider = makeProvider()
      const promptLog = new Map<string, string[]>()
      const { manager } = stubContainerManager()
      service = createRunService({
        db,
        sqlite,
        dataDir: dir,
        containerManager: manager,
        platformService: {
          submitFlag: async () => undefined,
          targetAction: async () => ({
            status: "running",
            endpoints: [],
            expiresAt: null,
          }),
        } as never,
        configStore: stubConfigStore([provider]),
        getSettings: flatSettingsWithDefaultModel,
        createHost: mock(async (input: { agentId: string }) => {
          const stub = stubHostAgentSession("sess-" + input.agentId.slice(0, 6))
          const list: string[] = []
          promptLog.set(input.agentId, list)
          const sdk = stub.session as unknown as {
            prompt: (text: string) => Promise<void>
          }
          sdk.prompt = async (text: string) => {
            list.push(text)
          }
          return stub
        }),
      })

      const sched = await service.create({
        scopeType: "event" as const,
        eventId: "evt-1",
        instruction: "",
        container: containerInput,
      })
      await settle()
      const orch = orchestratorOf(db, sched.id)
      const primed = promptLog.get(orch.id)?.length ?? 0

      // Two queued items (different challenges — enqueue upserts per
      // (event, challenge)), then the 2→1 edge (remove) fires the starved line.
      const queue = service.queue()
      const one = queue.enqueue({
        eventId: "evt-1",
        challengeId: "ch-1",
        source: "scheduler",
      })
      queue.enqueue({
        eventId: "evt-1",
        challengeId: "ch-2",
        source: "scheduler",
      })
      queue.cancelDrain()
      queue.remove(one.id)
      await settle()

      const urgent = orchRows(db).filter((r) => metaOf(r).urgent === true)
      expect(urgent).toHaveLength(1)
      expect(urgent[0]!.body).toContain("队列不足")
      expect(metaOf(urgent[0]!).noticeType).toBe("emergency")
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

  test("W3 paused: run events and queue urgent lines are dropped entirely; resume wakes with the re-sync message", async () => {
    const { db, sqlite, dir, close } = setupDb()
    let service: ReturnType<typeof createRunService> | undefined
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const provider = makeProvider()
      const promptLog = new Map<string, string[]>()
      const { manager } = stubContainerManager()
      service = createRunService({
        db,
        sqlite,
        dataDir: dir,
        containerManager: manager,
        platformService: {
          submitFlag: async () => undefined,
          targetAction: async () => ({
            status: "running",
            endpoints: [],
            expiresAt: null,
          }),
        } as never,
        configStore: stubConfigStore([provider]),
        getSettings: flatSettingsWithDefaultModel,
        createHost: mock(async (input: { agentId: string }) => {
          const stub = stubHostAgentSession("sess-" + input.agentId.slice(0, 6))
          const list: string[] = []
          promptLog.set(input.agentId, list)
          const sdk = stub.session as unknown as {
            prompt: (text: string) => Promise<void>
          }
          sdk.prompt = async (text: string) => {
            list.push(text)
          }
          return stub
        }),
      })

      const sched = await service.startScheduler("evt-1")
      await settle()
      const orch = orchestratorOf(db, sched.id)
      const primed = promptLog.get(orch.id)?.length ?? 0

      await service.pauseScheduler("evt-1")
      const challenge = await service.create({
        scopeType: "challenge",
        challengeId: "ch-1",
        container: containerInput,
      })
      await settle()
      service.notifyFlagAccepted(challenge.id)
      const queue = service.queue()
      const one = queue.enqueue({
        eventId: "evt-1",
        challengeId: "ch-1",
        source: "scheduler",
      })
      queue.enqueue({
        eventId: "evt-1",
        challengeId: "ch-1",
        source: "scheduler",
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

  test("a closed scheduler run stores events unread; a restart restores the SAME run and the tick catches up (stable scheduler cursor)", async () => {
    const { db, sqlite, dir, close } = setupDb()
    let service: ReturnType<typeof createRunService> | undefined
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const provider = makeProvider()
      const promptLog = new Map<string, string[]>()
      const { manager } = stubContainerManager()
      service = createRunService({
        db,
        sqlite,
        dataDir: dir,
        containerManager: manager,
        platformService: {
          submitFlag: async () => undefined,
          targetAction: async () => ({
            status: "running",
            endpoints: [],
            expiresAt: null,
          }),
        } as never,
        configStore: stubConfigStore([provider]),
        getSettings: flatSettingsWithDefaultModel,
        createHost: mock(async (input: { agentId: string }) => {
          const stub = stubHostAgentSession("sess-" + input.agentId.slice(0, 6))
          const list: string[] = []
          promptLog.set(input.agentId, list)
          const sdk = stub.session as unknown as {
            prompt: (text: string) => Promise<void>
          }
          sdk.prompt = async (text: string) => {
            list.push(text)
          }
          return stub
        }),
      })

      const sched = await service.startScheduler("evt-1")
      await settle()
      const orchId = orchestratorOf(db, sched.id).id

      await service.closeRun(sched.id)
      expect(service.get(sched.id)!.status).toBe("closed")

      // Events while the scheduler is closed: stored under the stable
      // 'scheduler' cursor, nothing delivered.
      const challenge = await service.create({
        scopeType: "challenge",
        challengeId: "ch-1",
        container: containerInput,
      })
      await settle()
      const stored = orchRows(db)
      expect(stored.length).toBeGreaterThanOrEqual(2)
      expect(service.channels.unreadCount(orchKey("evt-1"), "scheduler")).toBe(
        stored.length
      )

      // Restore: SAME run id + agent row (memory kept)…
      const restored = await service.startScheduler("evt-1")
      await settle()
      expect(restored.id).toBe(sched.id)
      expect(orchestratorOf(db, restored.id).id).toBe(orchId)

      // …and the next tick sweeps the stored backlog into the orchestrator.
      service.channels.runFlushTick()
      await settle()
      const texts = promptLog.get(orchId) ?? []
      const catchUp = texts.find(
        (t) => t.includes("[频道消息") && t.includes("started")
      )
      expect(catchUp).toBeDefined()
      expect(catchUp).toContain("idle")
      expect(challenge.id).toBeTruthy()
      await service.close()
    } finally {
      await service?.close().catch(() => undefined)
      close()
    }
  })

  test("startScheduler reset recreates: the closed run is deleted, a fresh one made (W3.2)", async () => {
    const { db, sqlite, dir, close } = setupDb()
    let service: ReturnType<typeof createRunService> | undefined
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const provider = makeProvider()
      const { manager } = stubContainerManager()
      service = createRunService({
        db,
        sqlite,
        dataDir: dir,
        containerManager: manager,
        platformService: {
          submitFlag: async () => undefined,
          targetAction: async () => ({
            status: "running",
            endpoints: [],
            expiresAt: null,
          }),
        } as never,
        configStore: stubConfigStore([provider]),
        getSettings: flatSettingsWithDefaultModel,
        createHost: mock(async (input: { agentId: string }) =>
          stubHostAgentSession("sess-" + input.agentId.slice(0, 6))
        ),
      })

      const sched = await service.startScheduler("evt-1")
      await settle()
      await service.closeRun(sched.id)

      const fresh = await service.startScheduler("evt-1", { reset: true })
      await settle()
      expect(fresh.id).not.toBe(sched.id)
      expect(service.get(sched.id)).toBeUndefined()
      expect(service.get(fresh.id)!.status).toBe("idle")
      await service.close()
    } finally {
      await service?.close().catch(() => undefined)
      close()
    }
  })

  test("scheduler-launched runs carry no manual marker in the orch message (W5)", async () => {
    const { db, sqlite, dir, close } = setupDb()
    let service: ReturnType<typeof createRunService> | undefined
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const provider = makeProvider()
      const { manager } = stubContainerManager()
      service = createRunService({
        db,
        sqlite,
        dataDir: dir,
        containerManager: manager,
        platformService: {
          submitFlag: async () => undefined,
          targetAction: async () => ({
            status: "running",
            endpoints: [],
            expiresAt: null,
          }),
        } as never,
        configStore: stubConfigStore([provider]),
        getSettings: flatSettingsWithDefaultModel,
        createHost: mock(async (input: { agentId: string }) =>
          stubHostAgentSession("sess-" + input.agentId.slice(0, 6))
        ),
      })

      const sched = await service.create({
        scopeType: "event",
        eventId: "evt-1",
        instruction: "",
        container: containerInput,
      })
      await settle()
      expect(orchestratorOf(db, sched.id).id).toBeTruthy()

      // A scheduler-launched run: source='scheduler' — NO manual marker, so
      // the scheduler knows it owns the run.
      await service.create({
        scopeType: "challenge",
        challengeId: "ch-1",
        container: containerInput,
        source: "scheduler",
      })
      await settle()
      const started = orchRows(db).filter(
        (r) => metaOf(r).eventType === "run.started"
      )
      expect(started).toHaveLength(1)
      expect(started[0]!.body).toBe("started")
      expect(metaOf(started[0]!).source).toBe("scheduler")
      await service.close()
    } finally {
      await service?.close().catch(() => undefined)
      close()
    }
  })
})
