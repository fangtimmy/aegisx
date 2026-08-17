import { describe, expect, mock, test } from "bun:test"

import { eq } from "drizzle-orm"

import {
  agents,
  challengeFlags,
  channelMessages,
  runQueue,
  runs,
} from "../../src/db/schema"
import { orchKey, teamKey } from "../../src/run/channels"
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

/** Service with per-agent prompt + abort recording (no hang: turns settle;
 * "streaming" targets are staged by flipping agent rows to running). */
function makeService(
  db: Db,
  sqlite: ReturnType<typeof setupDb>["sqlite"],
  dir: string
) {
  const provider = makeProvider()
  const { manager } = stubContainerManager()
  const promptLog = new Map<string, string[]>()
  const abortLog: string[] = []
  const service = createRunService({
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
        abort: () => Promise<void>
      }
      sdk.prompt = async (text: string) => {
        list.push(text)
      }
      sdk.abort = async () => {
        abortLog.push(input.agentId)
      }
      return stub
    }),
  })
  return { service, promptLog, abortLog }
}

/** Stage an agent as mid-turn (the cleanup/steer paths target running
 * solvers; the stub session is idle, so the DB row is the truth). */
function stageRunning(db: Db, agentId: string) {
  db.update(agents)
    .set({ status: "running", updatedAt: new Date().toISOString() })
    .where(eq(agents.id, agentId))
    .run()
}

function orchRows(db: Db, eventId = "evt-1") {
  return db
    .select()
    .from(channelMessages)
    .where(eq(channelMessages.channelKey, orchKey(eventId)))
    .all()
}

describe("solved-challenge cleanup (flag hooks)", () => {
  test("full solve stops sibling runs, aborts co-solvers, cancels pending items; the scheduler learns via orch messages", async () => {
    const { db, sqlite, dir, close } = setupDb()
    let service: ReturnType<typeof makeService>["service"] | undefined
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      seedChallenge(db, { id: "ch-2", eventId: "evt-1" })
      const made = makeService(db, sqlite, dir)
      service = made.service
      const { abortLog } = made

      const sched = await service.create({
        scopeType: "event" as const,
        eventId: "evt-1",
        instruction: "",
        container: containerInput,
      })
      await settle()
      expect(
        db.select().from(agents).where(eq(agents.runId, sched.id)).get()!.id
      ).toBeTruthy()

      // Submitting run: two solvers; sibling run on the same challenge.
      const submitter = await service.create({
        scopeType: "challenge" as const,
        challengeId: "ch-1",
        container: containerInput,
        solvers: [{}, {}],
      })
      const sibling = await service.create({
        scopeType: "challenge" as const,
        challengeId: "ch-1",
        container: containerInput,
      })
      await settle()
      // A pending queue item on ch-1 (stale work) + one on ch-2 (keep).
      const queue = service.queue()
      const stale = queue.enqueue({
        eventId: "evt-1",
        challengeId: "ch-1",
        source: "scheduler",
      })
      const keep = queue.enqueue({
        eventId: "evt-1",
        challengeId: "ch-2",
        source: "scheduler",
      })
      queue.cancelDrain()

      const [submitterAgent, coSolver] = db
        .select()
        .from(agents)
        .where(eq(agents.runId, submitter.id))
        .orderBy(agents.slot)
        .all()
      stageRunning(db, coSolver.id)

      service.notifyFlagAccepted(submitter.id, submitterAgent.id)
      await wait(80)
      await settle()

      // Sibling torn down with the auto-stop summary.
      const siblingRow = db
        .select()
        .from(runs)
        .where(eq(runs.id, sibling.id))
        .get()!
      expect(siblingRow.status).toBe("closed")
      expect(siblingRow.summary).toBe("同题已完全解出，自动停止")
      // The submitting run itself stays open (the submitter writes up).
      expect(
        db.select().from(runs).where(eq(runs.id, submitter.id)).get()!.status
      ).not.toBe("closed")
      // The co-solver was aborted — never the submitter.
      expect(abortLog).toContain(coSolver.id)
      expect(abortLog).not.toContain(submitterAgent.id)
      // Stale ch-1 queue item cancelled; ch-2 untouched (raw rows: cancelled
      // items drop out of the actionable list).
      const rawItem = (id: string) =>
        db.select().from(runQueue).where(eq(runQueue.id, id)).get()!
      expect(rawItem(stale.id).status).toBe("cancelled")
      expect(rawItem(keep.id).status).toBe("pending")

      // The scheduler learns via orch messages (v18 §五: events are
      // messages): the flagAccepted run event + the cleanup summary notice.
      const orch = orchRows(db)
      expect(
        orch.some((r) => r.body === "flagAccepted")
      ).toBe(true)
      const cleanup = orch.find((r) => r.body.includes("已完全解出"))
      expect(cleanup).toBeDefined()
      expect(cleanup!.body).toContain("停止 1 个同题 run")
      expect(cleanup!.body).toContain("取消 1 个排队项")
      // The queue-starved edge (pending 2→1 after the cancel) posted an
      // URGENT orch line.
      const starved = orch.find((r) => r.body.includes("队列不足"))
      expect(starved).toBeDefined()
      expect(JSON.parse(starved!.meta).urgent).toBe(true)
    } finally {
      await service?.close().catch(() => undefined)
      close()
    }
  })

  test("partial multi-flag solve posts ONE #team notice; the tick steers every live solver on the challenge", async () => {
    const { db, sqlite, dir, close } = setupDb()
    let service: ReturnType<typeof makeService>["service"] | undefined
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      // Two accepted flags already recorded for the challenge.
      const ts = new Date().toISOString()
      for (const flag of ["flag{one}", "flag{two}"]) {
        db.insert(challengeFlags)
          .values({
            id: crypto.randomUUID(),
            challengeId: "ch-1",
            flag,
            status: "accepted",
            source: "run",
            createdAt: ts,
            updatedAt: ts,
          })
          .run()
      }
      const made = makeService(db, sqlite, dir)
      service = made.service
      const { promptLog } = made

      const sched = await service.create({
        scopeType: "event" as const,
        eventId: "evt-1",
        instruction: "",
        container: containerInput,
      })
      await settle()
      const orch = db
        .select()
        .from(agents)
        .where(eq(agents.runId, sched.id))
        .get()!

      const runA = await service.create({
        scopeType: "challenge" as const,
        challengeId: "ch-1",
        container: containerInput,
        solvers: [{}, {}],
      })
      const runB = await service.create({
        scopeType: "challenge" as const,
        challengeId: "ch-1",
        container: containerInput,
      })
      await settle()
      const [submitter, coSolver] = db
        .select()
        .from(agents)
        .where(eq(agents.runId, runA.id))
        .orderBy(agents.slot)
        .all()
      const runBAgent = db
        .select()
        .from(agents)
        .where(eq(agents.runId, runB.id))
        .get()!

      service.notifyFlagPartial(
        runA.id,
        "flag 2/3 已确认（+10 分）",
        submitter.id
      )
      await settle()

      // v18 §五: ONE non-urgent system post in the challenge's #team (not
      // one per run) — the tick fans it out to every live solver.
      const partialPosts = db
        .select()
        .from(channelMessages)
        .where(eq(channelMessages.channelKey, teamKey("ch-1")))
        .all()
        .filter((row) => row.body.includes("[多 flag 进度]"))
      expect(partialPosts).toHaveLength(1)

      // Nothing steered yet (notice level, rides the tick)…
      const steered = (id: string) =>
        (promptLog.get(id) ?? []).filter((t) => t.includes("[多 flag 进度]"))
      expect(steered(coSolver.id)).toHaveLength(0)
      // …then one tick delivers it to EVERY live solver on the challenge
      // (v18 dropped the submitter skip — one extra message is harmless).
      service.channels.runFlushTick()
      await wait(60)
      expect(steered(coSolver.id)).toHaveLength(1)
      expect(steered(runBAgent.id)).toHaveLength(1)
      expect(steered(submitter.id)).toHaveLength(1)
      expect(steered(coSolver.id)[0]).toContain("flag{one}")
      expect(steered(coSolver.id)[0]).toContain("flag 2/3 已确认")
      // Nothing was torn down — the challenge is not fully solved.
      expect(
        db.select().from(runs).where(eq(runs.id, runA.id)).get()!.status
      ).not.toBe("closed")
      expect(
        db.select().from(runs).where(eq(runs.id, runB.id)).get()!.status
      ).not.toBe("closed")
      // The scheduler gets a non-urgent orch notice with the next flush.
      const orchNotice = orchRows(db).find((r) => r.body.includes("部分解出"))
      expect(orchNotice).toBeDefined()
      expect(JSON.parse(orchNotice!.meta).urgent).toBeUndefined()
      expect(orch.id).toBeTruthy()
    } finally {
      await service?.close().catch(() => undefined)
      close()
    }
  })
})
