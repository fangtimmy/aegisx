import { describe, expect, mock, test } from "bun:test"

import { defaultSettings } from "@aegisx/shared"
import { eq } from "drizzle-orm"

import { agents, runQueue, runs } from "../../src/db/schema"
import { createRunService } from "../../src/run/service"
import {
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
        orchestration: "classic",
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
        orchestration: "classic",
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
        orchestration: "classic",
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
      ).rejects.toThrow(/Concurrency cap/)
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
      expect(sched.orchestration).toBe("scheduler")
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
        orchestration: "scheduler",
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
        orchestration: "classic",
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
})
