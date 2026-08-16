import { describe, expect, mock, test } from "bun:test"

import { defaultSettings } from "@aegisx/shared"
import { eq } from "drizzle-orm"

import {
  agents,
  challengeRemote,
  queueState,
  runQueue,
  runs,
} from "../../src/db/schema"
import { createRunService } from "../../src/run/service"
import {
  flatSettingsWithDefaultModel,
  makeProvider,
  seedChallenge,
  seedEvent,
  seedRun,
  setupDb,
  stubConfigStore,
  stubContainerManager,
  stubHostAgentSession,
  toConnection,
  now,
} from "../helpers"

const containerInput = {
  image: "aegisx/solve:latest",
  cpus: 2,
  memoryMb: 1024,
  pidsLimit: 128,
  tmpfsSize: "128m",
  workspace: "/workspace",
}

type Db = ReturnType<typeof setupDb>["db"]

/** flatSettings with a default model ref so resolveAndCreate / startScheduler
 * can resolve a provider+model (the test provider is pi-bound openai/*). */
const settingsWithModel = () => ({
  ...defaultSettings(),
  "agent.defaultModelId": "openai/gpt-4o-mini:off",
})

function makeService(
  db: Db,
  sqlite: ReturnType<typeof setupDb>["sqlite"],
  dir: string
) {
  const provider = makeProvider()
  const { manager } = stubContainerManager()
  return {
    provider,
    service: createRunService({
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
      getSettings: settingsWithModel,
      createHost: mock(async (input: { agentId: string }) =>
        stubHostAgentSession("sess-" + input.agentId.slice(0, 6), {
          hang: true,
        })
      ),
    }),
  }
}

const settle = () => new Promise((r) => setTimeout(r, 10))

describe("v9 launch spec passthrough (params → drainer → create)", () => {
  /** Service variant capturing every agent's prompt texts. */
  function makeCapturingService(
    db: Db,
    sqlite: ReturnType<typeof setupDb>["sqlite"],
    dir: string
  ) {
    const provider = makeProvider()
    const { manager } = stubContainerManager()
    const promptLog = new Map<string, string[]>()
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
      getSettings: settingsWithModel,
      createHost: mock(async (input: { agentId: string }) => {
        const stub = stubHostAgentSession("sess-" + input.agentId.slice(0, 6), {
          hang: true,
        })
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
    return { service, promptLog }
  }

  test("enqueue with solvers launches a run shaped by them (solvers win over model)", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-a", eventId: "evt-1" })
      const { service, promptLog } = makeCapturingService(db, sqlite, dir)
      const queue = service.queue()

      const item = queue.enqueue({
        eventId: "evt-1",
        challengeId: "ch-a",
        source: "scheduler",
        strategy: "shared run strategy",
        model: "openai/gpt-4o-mini:high",
        solvers: [
          { model: "openai/gpt-4o-mini:off" },
          { prompt: "solver-level angle" },
        ],
      })
      await queue.drainOnce()

      const launched = queue.list("evt-1").find((i) => i.id === item.id)!
      expect(launched.status).toBe("running")
      const run = db
        .select()
        .from(runs)
        .where(eq(runs.id, launched.runId!))
        .get()!
      expect(run.queueItemId).toBe(item.id)
      const solverAgents = db
        .select()
        .from(agents)
        .where(eq(agents.runId, run.id))
        .orderBy(agents.slot)
        .all()
      // Per-solver models won over the shared `model`; solver-2 fell back to
      // the run default (no model in its spec).
      expect(solverAgents.map((a) => a.model)).toEqual([
        "openai/gpt-4o-mini:off",
        "openai/gpt-4o-mini:off",
      ])
      // Strategy rendering: solver-2's Strategy section carries the run-level
      // strategy + its own prompt; solver-1 got the run-level strategy only.
      const primes = solverAgents.map((a) => promptLog.get(a.id)?.[0] ?? "")
      expect(primes[0]).toContain("shared run strategy")
      expect(primes[1]).toContain("shared run strategy")
      expect(primes[1]).toContain("solver-level angle")
      await service.close()
    } finally {
      close()
    }
  })

  test("enqueue with model + solver_count shapes the run; prompt-only rows still pass the strategy", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-a", eventId: "evt-1" })
      seedChallenge(db, { id: "ch-b", eventId: "evt-1" })
      const { service, promptLog } = makeCapturingService(db, sqlite, dir)
      const queue = service.queue()

      const shaped = queue.enqueue({
        eventId: "evt-1",
        challengeId: "ch-a",
        source: "scheduler",
        model: "openai/gpt-4o-mini:low",
        solverCount: 2,
      })
      // Legacy field name (the HTTP routes): still lands as the strategy.
      const legacy = queue.enqueue({
        eventId: "evt-1",
        challengeId: "ch-b",
        source: "manual",
        prompt: "legacy prompt strategy",
      })
      await queue.drainOnce()

      const shapedRun = db
        .select()
        .from(runs)
        .where(eq(runs.queueItemId, shaped.id))
        .get()!
      const shapedAgents = db
        .select()
        .from(agents)
        .where(eq(agents.runId, shapedRun.id))
        .all()
      expect(shapedAgents).toHaveLength(2)
      expect(
        shapedAgents.every((a) => a.model === "openai/gpt-4o-mini:low")
      ).toBe(true)

      const legacyRun = db
        .select()
        .from(runs)
        .where(eq(runs.queueItemId, legacy.id))
        .get()!
      const legacyAgent = db
        .select()
        .from(agents)
        .where(eq(agents.runId, legacyRun.id))
        .get()!
      expect(promptLog.get(legacyAgent.id)?.[0]).toContain(
        "legacy prompt strategy"
      )
      await service.close()
    } finally {
      close()
    }
  })
})

describe("scheduler queue integration (P3)", () => {
  test("enqueue → drainOnce launches a run; item running + run.queueItemId linked", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-a", eventId: "evt-1" })
      const { service } = makeService(db, sqlite, dir)
      const queue = service.queue()

      const item = queue.enqueue({
        eventId: "evt-1",
        challengeId: "ch-a",
        source: "manual",
        prompt: "go",
      })
      expect(item.status).toBe("pending")
      await queue.drainOnce()

      const launched = queue.list("evt-1").find((i) => i.id === item.id)!
      expect(launched.status).toBe("running")
      expect(launched.runId).toBeTruthy()
      const run = db
        .select()
        .from(runs)
        .where(eq(runs.id, launched.runId!))
        .get()!
      expect(run.queueItemId).toBe(item.id)
      expect(run.source).toBe("manual")
      await service.close()
    } finally {
      close()
    }
  })

  test("finishing a queue-sourced run transitions its item to done", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-a", eventId: "evt-1" })
      const { service } = makeService(db, sqlite, dir)
      const queue = service.queue()
      const item = queue.enqueue({
        eventId: "evt-1",
        challengeId: "ch-a",
        source: "scheduler",
        prompt: "go",
      })
      await queue.drainOnce()
      const runId = queue.list("evt-1").find((i) => i.id === item.id)!.runId!

      await service.finish(runId, "solved")
      await settle()

      const done = db
        .select()
        .from(runQueue)
        .where(eq(runQueue.id, item.id))
        .get()!
      expect(done.status).toBe("done")
      await service.close()
    } finally {
      close()
    }
  })

  test("setRunTimeout updates the deadline (and re-arms a warm run)", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-a", eventId: "evt-1" })
      const { service } = makeService(db, sqlite, dir)
      const queue = service.queue()
      queue.enqueue({
        eventId: "evt-1",
        challengeId: "ch-a",
        source: "manual",
        prompt: "go",
      })
      await queue.drainOnce()
      const runId = queue.list("evt-1")[0]!.runId!
      const before = db.select().from(runs).where(eq(runs.id, runId)).get()!

      service.setRunTimeout(runId, 7_200_000)
      const after = db.select().from(runs).where(eq(runs.id, runId)).get()!
      expect(after.timeoutMs).toBe(7_200_000)
      expect(after.deadlineAt).not.toBe(before.deadlineAt)
      await service.close()
    } finally {
      close()
    }
  })

  test("cold-restore is rejected at the global cap and the run stays closed", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-a", eventId: "evt-1" })
      // Saturate the global cap (default 4) with running runs.
      for (let i = 1; i <= 4; i++) {
        seedRun(db, { id: `r${i}`, status: "running", challengeId: "ch-a" })
      }
      // A closed run with an entry agent — messaging it cold-restores it.
      seedRun(db, { id: "cold", status: "closed", challengeId: "ch-a" })
      db.insert(agents)
        .values({
          id: "a-cold",
          runId: "cold",
          slot: "solver",
          role: "solver",
          isEntry: true,
          model: "openai/gpt-4o-mini:off",
          systemPrompt: "sp",
          tools: "[]",
          status: "idle",
          sessionFile: "sess-cold",
          name: "Solver",
          createdAt: now(),
          updatedAt: now(),
        })
        .run()

      const { service } = makeService(db, sqlite, dir)
      await expect(
        service.sendMessage("cold", { text: "ping" })
      ).rejects.toThrow(/Live container cap reached/)
      // The run is unchanged (still closed) — the slot reservation reverted.
      const row = db.select().from(runs).where(eq(runs.id, "cold")).get()!
      expect(row.status).toBe("closed")
      await service.close()
    } finally {
      close()
    }
  })

  test("startScheduler builds an event-scoped run from scheduler_config", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-a", eventId: "evt-1" })
      const { service } = makeService(db, sqlite, dir)
      service.upsertSchedulerConfig({
        eventId: "evt-1",
        instruction: "Hit crypto first.",
        maxConcurrentTargets: 2,
      })

      const sched = await service.startScheduler("evt-1")
      expect(sched.scopeType).toBe("event")
      const config = service.getSchedulerConfig("evt-1")
      expect(config.instruction).toBe("Hit crypto first.")
      expect(config.maxConcurrentTargets).toBe(2)
      // get_status reflects the configured target cap.
      const status = service.getStatus("evt-1")
      expect(status.maxConcurrentTargets).toBe(2)
      await service.close()
    } finally {
      close()
    }
  })

  test("launch failure marks the queue item failed and notifies the scheduler", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-a", eventId: "evt-1" })
      const provider = makeProvider({ apiKey: "" }) // no key → launch fails
      const { manager } = stubContainerManager()
      const promptLog = new Map<string, string[]>()
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
        getSettings: settingsWithModel,
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

      // Start a scheduler run first (it has a key-less provider but the
      // scheduler run itself launches with the same provider → also fails.
      // Instead, seed a live scheduler run row so the failure notifier has a
      // target to message.)
      seedRun(db, {
        id: "sched",
        scopeType: "event",
        eventId: "evt-1",
        challengeId: null,
        status: "idle",
      })
      db.insert(agents)
        .values({
          id: "a-sched",
          runId: "sched",
          slot: "orchestrator",
          role: "orchestrator",
          isEntry: true,
          model: "openai/gpt-4o-mini:off",
          systemPrompt: "sp",
          tools: "[]",
          status: "idle",
          name: "Scheduler",
          createdAt: now(),
          updatedAt: now(),
        })
        .run()

      const queue = service.queue()
      const item = queue.enqueue({
        eventId: "evt-1",
        challengeId: "ch-a",
        source: "scheduler",
        prompt: "go",
      })
      await queue.drainOnce()
      await settle()

      const failed = db
        .select()
        .from(runQueue)
        .where(eq(runQueue.id, item.id))
        .get()!
      expect(failed.status).toBe("failed")
      expect(failed.error).toBeTruthy()
      await service.close()
    } finally {
      close()
    }
  })

  test("queue prompt is appended as a Strategy section, not a replacement (W1.1)", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-a", eventId: "evt-1" })
      const provider = makeProvider()
      const { manager } = stubContainerManager()
      const promptLog = new Map<string, string[]>()
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
        getSettings: settingsWithModel,
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

      const queue = service.queue()
      queue.enqueue({
        eventId: "evt-1",
        challengeId: "ch-a",
        source: "scheduler",
        prompt: "Hit crypto first; try z3.",
      })
      await queue.drainOnce()
      const runId = queue.list("evt-1")[0]!.runId!
      const agentId = db
        .select()
        .from(agents)
        .where(eq(agents.runId, runId))
        .get()!.id
      const prime = promptLog.get(agentId)?.[0] ?? ""
      // The standard blocks are always rendered; the strategy is a section.
      expect(prime).toContain("## Challenge")
      expect(prime).toContain("## Environment")
      expect(prime).toContain("## Strategy")
      expect(prime).toContain("Hit crypto first; try z3.")
      await service.close()
    } finally {
      close()
    }
  })

  test("recoverOnBoot closes live runs, resets stuck queue items, pauses queues (W2.2)", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-a", eventId: "evt-1" })
      const { service } = makeService(db, sqlite, dir)
      const queue = service.queue()
      const item = queue.enqueue({
        eventId: "evt-1",
        challengeId: "ch-a",
        source: "scheduler",
        prompt: "go",
      })
      await queue.drainOnce()
      const runId = queue.list("evt-1").find((i) => i.id === item.id)!.runId!
      // The launched run is live (hang host) with its item linked `running`.
      expect(
        db.select().from(runs).where(eq(runs.id, runId)).get()!.status
      ).toBe("running")
      expect(
        db.select().from(runQueue).where(eq(runQueue.id, item.id)).get()!.status
      ).toBe("running")

      await service.recoverOnBoot()

      // All live runs closed (crash recovery).
      expect(
        db.select().from(runs).where(eq(runs.id, runId)).get()!.status
      ).toBe("closed")
      // The stuck `running` queue item was reset to pending (runId cleared).
      const resetItem = db
        .select()
        .from(runQueue)
        .where(eq(runQueue.id, item.id))
        .get()!
      expect(resetItem.status).toBe("pending")
      expect(resetItem.runId).toBeNull()
      // The event's queue was paused and NOT auto-drained: the item stays
      // pending (boot never schedules a drain).
      const state = db
        .select()
        .from(queueState)
        .where(eq(queueState.eventId, "evt-1"))
        .get()!
      expect(state.status).toBe("paused")
      expect(
        db.select().from(runQueue).where(eq(runQueue.id, item.id)).get()!.status
      ).toBe("pending")
      await service.close()
    } finally {
      close()
    }
  })

  test("closing the last live run on a target-capable challenge stops its target (W4.3)", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-a", eventId: "evt-1" })
      db.insert(challengeRemote)
        .values({
          challengeId: "ch-a",
          eventId: "evt-1",
          sourceKey: "src",
          remoteId: "r-a",
          available: true,
          solved: false,
          targetSupported: true,
          targetIgnored: false,
          targetCount: 1,
          targetInfo: "[]",
          syncedAt: now(),
        })
        .run()
      const provider = makeProvider()
      const { manager } = stubContainerManager()
      const targetCalls: string[] = []
      const service = createRunService({
        db,
        sqlite,
        dataDir: dir,
        containerManager: manager,
        platformService: {
          submitFlag: async () => undefined,
          targetAction: async (_challengeId: string, action: string) => {
            targetCalls.push(action)
            return { status: "running", endpoints: [], expiresAt: null }
          },
        } as never,
        configStore: stubConfigStore([provider]),
        getSettings: settingsWithModel,
        createHost: mock(async (input: { agentId: string }) =>
          stubHostAgentSession("sess-" + input.agentId.slice(0, 6))
        ),
      })

      // Last live run on the challenge closes → target stopped.
      const run1 = await service.create({
        scopeType: "challenge",
        challengeId: "ch-a",
        container: containerInput,
      })
      await settle()
      await service.closeRun(run1.id)
      await settle()
      expect(targetCalls).toContain("stop")

      // A second run on the SAME challenge → closing one must NOT stop the
      // target (the other is still active).
      const run2 = await service.create({
        scopeType: "challenge",
        challengeId: "ch-a",
        container: containerInput,
      })
      const run3 = await service.create({
        scopeType: "challenge",
        challengeId: "ch-a",
        container: containerInput,
      })
      await settle()
      targetCalls.length = 0
      await service.closeRun(run2.id)
      await settle()
      expect(targetCalls).not.toContain("stop")
      await service.closeRun(run3.id)
      await settle()
      expect(targetCalls).toContain("stop")
      await service.close()
    } finally {
      close()
    }
  })
})
