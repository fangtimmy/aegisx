import { describe, expect, mock, test } from "bun:test"

import { eq } from "drizzle-orm"

import {
  agents,
  challengeFlags,
  channelMessages,
  schedulerConfig,
  spawnQueue,
} from "../../src/db/schema"
import { orchKey, teamKey } from "../../src/run/channels"
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

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type Db = ReturnType<typeof setupDb>["db"]

/** Service with per-agent prompt + abort recording (no hang: turns settle;
 * "streaming" targets are staged by flipping agent rows to running). */
function makeService(
  db: Db,
  dir: string,
  opts: { targetCalls?: string[] } = {}
) {
  const provider = makeProvider()
  const { manager } = stubContainerManager()
  const promptLog = new Map<string, string[]>()
  const abortLog: string[] = []
  const service = createAgentService({
    db,
    dataDir: dir,
    containerManager: manager,
    platformService: {
      submitFlag: async () => undefined,
      targetAction: async (_challengeId: string, action: string) => {
        opts.targetCalls?.push(action)
        return { status: "running", endpoints: [], expiresAt: null }
      },
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

/** Stage an agent as mid-turn (the cleanup paths target running solvers;
 * the stub session is idle, so the DB row is the truth). */
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

const tagOf = (agentId: string) =>
  `「Test Challenge」agent-${agentId.slice(0, 8)}`

describe("solved-challenge cleanup (v19 flag hooks)", () => {
  test("full solve stops sibling agents, cancels pending items, stops the orphan target; the scheduler learns via orch messages", async () => {
    const { db, dir, close } = setupDb()
    let service: ReturnType<typeof makeService>["service"] | undefined
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      seedChallenge(db, { id: "ch-2", eventId: "evt-1" })
      // ch-1 is target-capable → the full-solve orphan cleanup stops it.
      db.insert(require("../../src/db/schema").challengeRemote)
        .values({
          challengeId: "ch-1",
          eventId: "evt-1",
          sourceKey: "src",
          remoteId: "r-1",
          available: true,
          solved: false,
          targetSupported: true,
          targetIgnored: false,
          targetCount: 1,
          targetInfo: "[]",
          syncedAt: new Date().toISOString(),
        })
        .run()
      const targetCalls: string[] = []
      const made = makeService(db, dir, { targetCalls })
      service = made.service

      await service.startScheduler("evt-1")
      await settle()

      // Three agents on ch-1 (submitter + co-solver + sibling) + one on ch-2.
      const submitter = await service.spawn({
        eventId: "evt-1",
        challengeId: "ch-1",
      })
      const coSolver = await service.spawn({
        eventId: "evt-1",
        challengeId: "ch-1",
      })
      const sibling = await service.spawn({
        eventId: "evt-1",
        challengeId: "ch-1",
      })
      await service.spawn({ eventId: "evt-1", challengeId: "ch-2" })
      await settle()
      stageRunning(db, coSolver.id)
      stageRunning(db, sibling.id)

      // Stale pending item on ch-1 (cancelled) + one on ch-2 (kept).
      const queue = service.queue()
      const stale = queue.enqueue({
        eventId: "evt-1",
        challengeId: "ch-1",
        source: "scheduler",
        prompt: "stale",
      })
      const keep = queue.enqueue({
        eventId: "evt-1",
        challengeId: "ch-2",
        source: "scheduler",
        prompt: "keep",
      })
      queue.cancelDrain()

      service.notifyFlagAccepted("ch-1", submitter.id)
      await wait(80)
      await settle()

      // The sibling + co-solver were closed (aborted); the submitter stays.
      expect(
        db.select().from(agents).where(eq(agents.id, sibling.id)).get()!.status
      ).toBe("aborted")
      expect(
        db.select().from(agents).where(eq(agents.id, coSolver.id)).get()!.status
      ).toBe("aborted")
      expect(
        db.select().from(agents).where(eq(agents.id, submitter.id)).get()!
          .status
      ).not.toBe("aborted")
      // closeAgent disposes the sibling/co-solver sessions (never the
      // submitter's — it stays to write up).
      expect(
        db.select().from(agents).where(eq(agents.id, sibling.id)).get()!.status
      ).toBe("aborted")
      expect(
        db.select().from(agents).where(eq(agents.id, coSolver.id)).get()!.status
      ).toBe("aborted")

      // Stale ch-1 queue item cancelled; ch-2 untouched.
      const rawItem = (id: string) =>
        db.select().from(spawnQueue).where(eq(spawnQueue.id, id)).get()!
      expect(rawItem(stale.id).status).toBe("cancelled")
      expect(rawItem(keep.id).status).toBe("pending")

      // Orphan target stop: no live agent left on ch-1 → target stopped.
      expect(targetCalls).toContain("stop")

      // The scheduler learns via orch messages: the flagAccepted event +
      // the cleanup summary notice.
      const orch = orchRows(db)
      expect(
        orch.some((r) => r.body === `${tagOf(submitter.id)}flag 已接受`)
      ).toBe(true)
      const cleanup = orch.find((r) => r.body.includes("已完全解出"))
      expect(cleanup).toBeDefined()
      expect(cleanup!.body).toContain("已停止 2 个同题 agent")
      expect(cleanup!.body).toContain("已取消 1 个排队项")
    } finally {
      await service?.close().catch(() => undefined)
      close()
    }
  })

  test("partial multi-flag solve posts ONE #team notice; the tick steers every live agent on the challenge", async () => {
    const { db, dir, close } = setupDb()
    let service: ReturnType<typeof makeService>["service"] | undefined
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      // Two accepted flags already recorded for the challenge (the spawn
      // gate must be off for agents to still run on it).
      const ts = new Date().toISOString()
      db.insert(schedulerConfig)
        .values({
          eventId: "evt-1",
          blockSpawnOnSolved: false,
          createdAt: ts,
          updatedAt: ts,
        })
        .run()
      for (const flag of ["flag{one}", "flag{two}"]) {
        db.insert(challengeFlags)
          .values({
            id: crypto.randomUUID(),
            challengeId: "ch-1",
            flag,
            status: "accepted",
            source: "agent",
            createdAt: ts,
            updatedAt: ts,
          })
          .run()
      }
      const made = makeService(db, dir)
      service = made.service
      const { promptLog } = made

      await service.startScheduler("evt-1")
      await settle()

      const submitter = await service.spawn({
        eventId: "evt-1",
        challengeId: "ch-1",
      })
      const coSolver = await service.spawn({
        eventId: "evt-1",
        challengeId: "ch-1",
      })
      const sibling = await service.spawn({
        eventId: "evt-1",
        challengeId: "ch-1",
      })
      await settle()

      service.notifyFlagPartial(
        "ch-1",
        "flag 2/3 已确认（+10 分）",
        submitter.id
      )
      await settle()

      // ONE system post in the challenge's #team (urgent-team policy default
      // ON → it delivers IMMEDIATELY to every live agent on the challenge)…
      const partialPosts = db
        .select()
        .from(channelMessages)
        .where(eq(channelMessages.channelKey, teamKey("ch-1")))
        .all()
        .filter((row) => row.body.includes("多 flag 进度"))
      expect(partialPosts).toHaveLength(1)

      const steered = (id: string) =>
        (promptLog.get(id) ?? []).filter((t) => t.includes("多 flag 进度"))
      await wait(60)
      expect(steered(coSolver.id)).toHaveLength(1)
      expect(steered(sibling.id)).toHaveLength(1)
      expect(steered(submitter.id)).toHaveLength(1)
      expect(steered(coSolver.id)[0]).toContain("flag{one}")
      expect(steered(coSolver.id)[0]).toContain("flag 2/3 已确认")
      // …and the tick does not re-deliver (cursors advanced).
      service.channels.runFlushTick()
      await wait(60)
      expect(steered(coSolver.id)).toHaveLength(1)
      // Nothing was torn down — the challenge is not fully solved.
      expect(
        db.select().from(agents).where(eq(agents.id, submitter.id)).get()!
          .status
      ).not.toBe("aborted")
      expect(
        db.select().from(agents).where(eq(agents.id, coSolver.id)).get()!.status
      ).not.toBe("aborted")
      // The scheduler gets a non-urgent orch notice.
      const orchNotice = orchRows(db).find((r) => r.body.includes("部分解出"))
      expect(orchNotice).toBeDefined()
      expect(JSON.parse(orchNotice!.meta).urgent).toBeUndefined()
    } finally {
      await service?.close().catch(() => undefined)
      close()
    }
  })

  test("policy stop-siblings/stop-target off: teammates survive with a wrap-up #team notice, the target stays; queue items still cancel", async () => {
    const { db, dir, close } = setupDb()
    let service: ReturnType<typeof makeService>["service"] | undefined
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      db.insert(require("../../src/db/schema").challengeRemote)
        .values({
          challengeId: "ch-1",
          eventId: "evt-1",
          sourceKey: "src",
          remoteId: "r-1",
          available: true,
          solved: false,
          targetSupported: true,
          targetIgnored: false,
          targetCount: 1,
          targetInfo: "[]",
          syncedAt: new Date().toISOString(),
        })
        .run()
      db.insert(schedulerConfig)
        .values({
          eventId: "evt-1",
          stopSiblingsOnSolve: false,
          stopTargetOnSolve: false,
          blockSpawnOnSolved: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .run()
      // The accepted flag the #team notice quotes.
      const ts = new Date().toISOString()
      db.insert(challengeFlags)
        .values({
          id: crypto.randomUUID(),
          challengeId: "ch-1",
          flag: "flag{keep}",
          status: "accepted",
          source: "agent",
          createdAt: ts,
          updatedAt: ts,
        })
        .run()
      const targetCalls: string[] = []
      const made = makeService(db, dir, { targetCalls })
      service = made.service

      await service.startScheduler("evt-1")
      await settle()
      const submitter = await service.spawn({
        eventId: "evt-1",
        challengeId: "ch-1",
      })
      const sibling = await service.spawn({
        eventId: "evt-1",
        challengeId: "ch-1",
      })
      await settle()
      stageRunning(db, sibling.id)
      const queue = service.queue()
      const stale = queue.enqueue({
        eventId: "evt-1",
        challengeId: "ch-1",
        source: "scheduler",
        prompt: "stale",
      })
      queue.cancelDrain()

      service.notifyFlagAccepted("ch-1", submitter.id)
      await wait(80)
      await settle()

      // Teammates survive; the target is NOT stopped.
      expect(
        db.select().from(agents).where(eq(agents.id, sibling.id)).get()!.status
      ).not.toBe("aborted")
      expect(targetCalls).not.toContain("stop")
      // Pending items on the solved challenge still cancel.
      expect(
        db.select().from(spawnQueue).where(eq(spawnQueue.id, stale.id)).get()!
          .status
      ).toBe("cancelled")
      // The #team notice quotes the flag and tells survivors to wrap up.
      const notice = db
        .select()
        .from(channelMessages)
        .where(eq(channelMessages.channelKey, teamKey("ch-1")))
        .all()
        .find((r) => r.body.includes("已完全解出"))
      expect(notice).toBeDefined()
      expect(notice!.body).toContain("flag{keep}")
      expect(notice!.body).toContain("finish_run")
      // The orch summary no longer claims stopped agents.
      const cleanup = orchRows(db).find((r) => r.body.includes("已完全解出"))
      expect(cleanup).toBeDefined()
      expect(cleanup!.body).not.toContain("已停止")
    } finally {
      await service?.close().catch(() => undefined)
      close()
    }
  })

  test("policy notify off: no #team posts on acceptance; the cleanup still runs", async () => {
    const { db, dir, close } = setupDb()
    let service: ReturnType<typeof makeService>["service"] | undefined
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      db.insert(schedulerConfig)
        .values({
          eventId: "evt-1",
          notifyTeamOnFlag: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .run()
      const made = makeService(db, dir)
      service = made.service

      await service.startScheduler("evt-1")
      await settle()
      const submitter = await service.spawn({
        eventId: "evt-1",
        challengeId: "ch-1",
      })
      const sibling = await service.spawn({
        eventId: "evt-1",
        challengeId: "ch-1",
      })
      await settle()
      stageRunning(db, sibling.id)

      service.notifyFlagAccepted("ch-1", submitter.id)
      await wait(80)
      await settle()

      expect(
        db
          .select()
          .from(channelMessages)
          .where(eq(channelMessages.channelKey, teamKey("ch-1")))
          .all()
      ).toHaveLength(0)
      // Default stop-siblings still applies.
      expect(
        db.select().from(agents).where(eq(agents.id, sibling.id)).get()!.status
      ).toBe("aborted")
    } finally {
      await service?.close().catch(() => undefined)
      close()
    }
  })
})

describe("acceptance outcome tiers (repeat / extra)", () => {
  test("repeat: a duplicate of an accepted value fires only the submitter event — no notice, no stops, no cancel", async () => {
    const { db, dir, close } = setupDb()
    let service: ReturnType<typeof makeService>["service"] | undefined
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const targetCalls: string[] = []
      const made = makeService(db, dir, { targetCalls })
      service = made.service
      const submitter = await service.spawn({
        eventId: "evt-1",
        challengeId: "ch-1",
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      const queue = service.queue()
      const pending = queue.enqueue({
        eventId: "evt-1",
        challengeId: "ch-1",
        source: "scheduler",
        prompt: "work",
      })
      queue.cancelDrain()

      service.notifyFlagAccepted("ch-1", submitter.id, "repeat")
      await new Promise((resolve) => setTimeout(resolve, 80))

      // The submitter's agent.flagAccepted event still lands (attribution).
      expect(
        orchRows(db).some((r) => r.body === `${tagOf(submitter.id)}flag 已接受`)
      ).toBe(true)
      // But nothing else: no full-solve notice, no stop, no cancel.
      expect(
        db
          .select()
          .from(channelMessages)
          .where(eq(channelMessages.channelKey, teamKey("ch-1")))
          .all()
      ).toHaveLength(0)
      expect(
        db.select().from(agents).where(eq(agents.id, submitter.id)).get()!
          .status
      ).not.toBe("aborted")
      expect(
        db.select().from(spawnQueue).where(eq(spawnQueue.id, pending.id)).get()!
          .status
      ).toBe("pending")
      expect(targetCalls).toHaveLength(0)
    } finally {
      await service?.close().catch(() => undefined)
      close()
    }
  })

  test("extra: a new flag value on a solved challenge posts ONE light notice; siblings survive, queue and target untouched", async () => {
    const { db, dir, close } = setupDb()
    let service: ReturnType<typeof makeService>["service"] | undefined
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      // The challenge is already solved (an accepted flag exists); the
      // reproduction switch lets agents still run on it.
      db.insert(challengeFlags)
        .values({
          id: "f-1",
          challengeId: "ch-1",
          flag: "flag{first}",
          status: "accepted",
          source: "agent",
          agentId: null,
          remoteId: null,
          message: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .run()
      db.insert(schedulerConfig)
        .values({
          eventId: "evt-1",
          blockSpawnOnSolved: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .run()
      const targetCalls: string[] = []
      const made = makeService(db, dir, { targetCalls })
      service = made.service
      const finder = await service.spawn({
        eventId: "evt-1",
        challengeId: "ch-1",
      })
      const sibling = await service.spawn({
        eventId: "evt-1",
        challengeId: "ch-1",
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      stageRunning(db, sibling.id)
      const queue = service.queue()
      const pending = queue.enqueue({
        eventId: "evt-1",
        challengeId: "ch-1",
        source: "scheduler",
        prompt: "work",
      })
      queue.cancelDrain()

      service.notifyFlagAccepted("ch-1", finder.id, "extra")
      await new Promise((resolve) => setTimeout(resolve, 80))

      const team = db
        .select()
        .from(channelMessages)
        .where(eq(channelMessages.channelKey, teamKey("ch-1")))
        .all()
      expect(team).toHaveLength(1)
      expect(team[0]!.body).toContain("再解出一个 flag")
      expect(team[0]!.body).toContain("agent-" + finder.id.slice(0, 8))
      // No cleanup round: the sibling survives, the pending item stays, the
      // target is not stopped (it all ran at the FIRST acceptance).
      expect(
        db.select().from(agents).where(eq(agents.id, sibling.id)).get()!.status
      ).not.toBe("aborted")
      expect(
        db.select().from(spawnQueue).where(eq(spawnQueue.id, pending.id)).get()!
          .status
      ).toBe("pending")
      expect(targetCalls).toHaveLength(0)
    } finally {
      await service?.close().catch(() => undefined)
      close()
    }
  })
})
