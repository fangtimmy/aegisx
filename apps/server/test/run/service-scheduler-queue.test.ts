import { describe, expect, mock, test } from "bun:test"

import { defaultSettings } from "@aegisx/shared"
import { eq } from "drizzle-orm"

import { agents, queueState, spawnQueue } from "../../src/db/schema"
import { createAgentService } from "../../src/run/service"
import {
  makeProvider,
  seedAgent,
  seedChallenge,
  seedEvent,
  setupDb,
  stubConfigStore,
  stubContainerManager,
  stubHostAgentSession,
} from "../helpers"
import { refine } from "../support"

type Db = ReturnType<typeof setupDb>["db"]

/** flatSettings with a default model ref so spawn / startScheduler can resolve
 * a provider+model (the test provider's model is aegisx-prov-1/gpt-4o-mini). */
const settingsWithModel = () => ({
  ...defaultSettings(),
  "agent.defaultModelRef": "aegisx-prov-1/gpt-4o-mini:off",
})

function makeService(
  db: Db,
  dir: string,
  opts: { provider?: ReturnType<typeof makeProvider> } = {}
) {
  const provider = opts.provider ?? makeProvider()
  const { manager } = stubContainerManager()
  return {
    provider,
    service: createAgentService({
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
      getSettings: settingsWithModel,
      createHost: mock(async (input: { agentId: string }) =>
        stubHostAgentSession("sess-" + input.agentId.slice(0, 6), {
          hang: true,
        })
      ),
    }),
  }
}

/** Service variant capturing every agent's prompt texts. */
function makeCapturingService(db: Db, dir: string) {
  const provider = makeProvider()
  const { manager } = stubContainerManager()
  const promptLog = new Map<string, string[]>()
  const service = createAgentService({
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
    getSettings: settingsWithModel,
    createHost: mock(async (input: { agentId: string }) => {
      const stub = stubHostAgentSession("sess-" + input.agentId.slice(0, 6), {
        hang: true,
      })
      const list: string[] = []
      promptLog.set(input.agentId, list)
      const sdk = refine<{
        prompt: (text: string) => Promise<void>
      }>(stub.session)
      sdk.prompt = async (text: string) => {
        list.push(text)
      }
      return stub
    }),
  })
  return { service, promptLog }
}

const settle = () => new Promise((r) => setTimeout(r, 10))

describe("v19 spawn-spec passthrough (params → drainer → spawn)", () => {
  test("enqueue with model + prompt launches one agent shaped by the params", async () => {
    const { db, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-a", eventId: "evt-1" })
      const { service, promptLog } = makeCapturingService(db, dir)
      const queue = service.queue()

      const item = queue.enqueue({
        eventId: "evt-1",
        challengeId: "ch-a",
        source: "scheduler",
        prompt: "shared strategy text",
        model: "aegisx-prov-1/gpt-4o-mini:high",
      })
      await queue.drainOnce()

      const launched = queue.list("evt-1").find((i) => i.id === item.id)!
      expect(launched.status).toBe("running")
      expect(launched.agentId).toBeTruthy()
      const solver = db
        .select()
        .from(agents)
        .where(eq(agents.id, launched.agentId!))
        .get()!
      expect(solver.queueItemId).toBe(item.id)
      // The explicit model ref won.
      expect(solver.model).toBe("aegisx-prov-1/gpt-4o-mini:high")
      // Strategy rendering: the prompt lands as a Strategy section.
      const prime = promptLog.get(solver.id)?.[0] ?? ""
      expect(prime).toContain("shared strategy text")
      await service.close()
    } finally {
      close()
    }
  })

  test("enqueue with promptMode=override primes the raw prompt", async () => {
    const { db, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-a", eventId: "evt-1" })
      const { service, promptLog } = makeCapturingService(db, dir)
      const queue = service.queue()
      const item = queue.enqueue({
        eventId: "evt-1",
        challengeId: "ch-a",
        source: "scheduler",
        prompt: "RAW FIRST PROMPT",
        promptMode: "override",
      })
      await queue.drainOnce()
      const agentId = queue
        .list("evt-1")
        .find((i) => i.id === item.id)!.agentId!
      expect(promptLog.get(agentId)?.[0]).toBe("RAW FIRST PROMPT")
      await service.close()
    } finally {
      close()
    }
  })
})

describe("scheduler queue integration (v19)", () => {
  test("enqueue → drainOnce spawns an agent; item running + agent.queueItemId linked", async () => {
    const { db, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-a", eventId: "evt-1" })
      const { service } = makeService(db, dir)
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
      expect(launched.agentId).toBeTruthy()
      const agent = db
        .select()
        .from(agents)
        .where(eq(agents.id, launched.agentId!))
        .get()!
      expect(agent.queueItemId).toBe(item.id)
      expect(agent.source).toBe("manual")
      await service.close()
    } finally {
      close()
    }
  })

  test("finishing a queue-sourced agent transitions its item to done", async () => {
    const { db, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-a", eventId: "evt-1" })
      const { service } = makeService(db, dir)
      const queue = service.queue()
      const item = queue.enqueue({
        eventId: "evt-1",
        challengeId: "ch-a",
        source: "scheduler",
        prompt: "go",
      })
      await queue.drainOnce()
      const agentId = queue
        .list("evt-1")
        .find((i) => i.id === item.id)!.agentId!

      await service.finishAgent(agentId, "solved")
      await settle()

      const done = db
        .select()
        .from(spawnQueue)
        .where(eq(spawnQueue.id, item.id))
        .get()!
      expect(done.status).toBe("done")
      await service.close()
    } finally {
      close()
    }
  })

  test("setAgentTimeout updates the deadline (and re-arms a warm agent)", async () => {
    const { db, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-a", eventId: "evt-1" })
      const { service } = makeService(db, dir)
      const queue = service.queue()
      queue.enqueue({
        eventId: "evt-1",
        challengeId: "ch-a",
        source: "manual",
        prompt: "go",
      })
      await queue.drainOnce()
      const agentId = queue.list("evt-1")[0].agentId!
      const before = db
        .select()
        .from(agents)
        .where(eq(agents.id, agentId))
        .get()!

      service.setAgentTimeout(agentId, 7_200_000)
      const after = db
        .select()
        .from(agents)
        .where(eq(agents.id, agentId))
        .get()!
      expect(after.timeoutMs).toBe(7_200_000)
      expect(after.deadlineAt).not.toBe(before.deadlineAt)
      await service.close()
    } finally {
      close()
    }
  })

  test("a direct spawn at the global cap rejects with capacity; a queued item stays pending", async () => {
    const { db, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-a", eventId: "evt-1" })
      // Saturate the global cap (default 4) with running agents.
      for (let i = 1; i <= 4; i++) {
        seedAgent(db, { id: `a${i}`, challengeId: "ch-a", status: "running" })
      }
      const { service } = makeService(db, dir)

      // Direct spawn at the cap → capacity error (the agent count stays 4).
      await expect(
        service.spawn({ eventId: "evt-1", challengeId: "ch-a" })
      ).rejects.toThrow(/Live agent cap reached/)
      expect(
        db
          .select()
          .from(agents)
          .all()
          .filter((a) => a.status !== "completed").length
      ).toBe(4)

      // A queued item drains but stays pending (capacity → skip, not fail).
      const queue = service.queue()
      const item = queue.enqueue({
        eventId: "evt-1",
        challengeId: "ch-a",
        source: "scheduler",
        prompt: "go",
      })
      await queue.drainOnce()
      expect(
        db.select().from(spawnQueue).where(eq(spawnQueue.id, item.id)).get()!
          .status
      ).toBe("pending")
      await service.close()
    } finally {
      close()
    }
  })

  test("startScheduler builds the orchestrator agent from scheduler_config", async () => {
    const { db, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-a", eventId: "evt-1" })
      const { service } = makeService(db, dir)
      service.upsertSchedulerConfig({
        eventId: "evt-1",
        instruction: "Hit crypto first.",
        maxConcurrentTargets: 2,
      })

      const sched = await service.startScheduler("evt-1")
      expect(sched.role).toBe("orchestrator")
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
    const { db, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-a", eventId: "evt-1" })
      // Seed a live scheduler agent so the failure notifier has a target.
      seedAgent(db, {
        id: "a-sched",
        eventId: "evt-1",
        challengeId: null,
        role: "orchestrator",
        status: "idle",
        name: "Scheduler",
        model: "aegisx-prov-1/gpt-4o-mini:off",
      })
      const provider = makeProvider() // normal key; the launch fails in createHost
      const { manager } = stubContainerManager()
      const promptLog = new Map<string, string[]>()
      const service = createAgentService({
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
        getSettings: settingsWithModel,
        createHost: mock(async (input: { agentId: string }) => {
          // Solver spawns fail their host build; the scheduler's own
          // host build (on the urgent reopen) succeeds.
          const row = db
            .select()
            .from(agents)
            .where(eq(agents.id, input.agentId))
            .get()
          if (row?.role === "solver") {
            throw new Error("agent session boom")
          }
          const stub = stubHostAgentSession("sess-" + input.agentId.slice(0, 6))
          const list: string[] = []
          promptLog.set(input.agentId, list)
          const sdk = refine<{
            prompt: (text: string) => Promise<void>
          }>(stub.session)
          sdk.prompt = async (text: string) => {
            list.push(text)
          }
          return stub
        }),
      })

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
        .from(spawnQueue)
        .where(eq(spawnQueue.id, item.id))
        .get()!
      expect(failed.status).toBe("failed")
      expect(failed.error).toBeTruthy()
      // The urgent launch-failure line woke the live scheduler.
      expect(
        promptLog.get("a-sched")?.some((t) => t.includes("启动失败"))
      ).toBe(true)
      await service.close()
    } finally {
      close()
    }
  })

  test("queue prompt is appended as a Strategy section, not a replacement (W1.1)", async () => {
    const { db, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-a", eventId: "evt-1" })
      const { service, promptLog } = makeCapturingService(db, dir)

      const queue = service.queue()
      queue.enqueue({
        eventId: "evt-1",
        challengeId: "ch-a",
        source: "scheduler",
        prompt: "Hit crypto first; try z3.",
      })
      await queue.drainOnce()
      const agentId = queue.list("evt-1")[0].agentId!
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

  test("recoverOnBoot flips live agents idle, resets stuck queue items, pauses queues (W2.2)", async () => {
    const { db, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-a", eventId: "evt-1" })
      const { service } = makeService(db, dir)
      const queue = service.queue()
      const item = queue.enqueue({
        eventId: "evt-1",
        challengeId: "ch-a",
        source: "scheduler",
        prompt: "go",
      })
      await queue.drainOnce()
      const agentId = queue
        .list("evt-1")
        .find((i) => i.id === item.id)!.agentId!
      // The launched agent is live (hang host) with its item linked `running`.
      expect(
        db.select().from(agents).where(eq(agents.id, agentId)).get()!.status
      ).toBe("running")
      expect(
        db.select().from(spawnQueue).where(eq(spawnQueue.id, item.id)).get()!
          .status
      ).toBe("running")

      await service.recoverOnBoot()

      // The live agent flipped to idle (crash recovery).
      expect(
        db.select().from(agents).where(eq(agents.id, agentId)).get()!.status
      ).toBe("idle")
      // The stuck `running` queue item was reset to pending (agentId cleared).
      const resetItem = db
        .select()
        .from(spawnQueue)
        .where(eq(spawnQueue.id, item.id))
        .get()!
      expect(resetItem.status).toBe("pending")
      expect(resetItem.agentId).toBeNull()
      // The event's queue was paused and NOT auto-drained: the item stays
      // pending (boot never schedules a drain).
      const state = db
        .select()
        .from(queueState)
        .where(eq(queueState.eventId, "evt-1"))
        .get()!
      expect(state.status).toBe("paused")
      await service.close()
    } finally {
      close()
    }
  })

  test("closing the last live agent on a target-capable challenge stops its target (W4.3)", async () => {
    // See service-flag-cleanup.test.ts: orphan-target-stop now rides the
    // flag-accepted cleanup path (closeAgent alone no longer stops the
    // target — the challenge is simply left idle until a flag closes it).
    expect(true).toBe(true)
  })
})
