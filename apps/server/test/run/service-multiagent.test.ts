import { describe, expect, mock, test } from "bun:test"

import { eq } from "drizzle-orm"

import { agents, runs } from "../../src/db/schema"
import { createRunService } from "../../src/run/service"
import {
  flatSettings,
  makeProvider,
  seedChallenge,
  seedEvent,
  seedRun,
  setupDb,
  stubConfigStore,
  stubContainerManager,
  stubHostAgentSession,
  toConnection,
} from "../helpers"

const containerInput = {
  image: "aegisx/solve:latest",
  cpus: 2,
  memoryMb: 1024,
  pidsLimit: 128,
  tmpfsSize: "128m",
  workspace: "/workspace",
}

const MODEL = {
  provider: "Test Provider",
  modelId: "model-1",
  thinking: "off" as const,
}

type Db = ReturnType<typeof setupDb>

function makeService(
  db: Db["db"],
  sqlite: Db["sqlite"],
  dir: string,
  provider: ReturnType<typeof makeProvider>,
  opts: { hang?: boolean; promptLog?: Map<string, string[]> } = {}
) {
  const { manager } = stubContainerManager()
  const hang = opts.hang ?? true
  const promptLog = opts.promptLog
  return createRunService({
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
    getSettings: flatSettings,
    createHost: mock(async (input: { agentId: string }) => {
      const stub = stubHostAgentSession("sess-" + input.agentId.slice(0, 6), {
        hang,
      })
      if (promptLog) {
        const list: string[] = []
        promptLog.set(input.agentId, list)
        const sdk = stub.session as unknown as {
          prompt: (text: string) => Promise<void>
        }
        sdk.prompt = async (text: string) => {
          list.push(text)
        }
      }
      return stub
    }),
  })
}

describe("multi-agent orchestration (service level)", () => {
  test("trio creates 3 agents, one entry, per-agent model snapshots, all primed", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const provider = makeProvider()
      const runService = makeService(db, sqlite, dir, provider)

      const run = await runService.create({
        scopeType: "challenge" as const,
        challengeId: "ch-1",
        orchestration: "trio",
        params: {
          models: [
            MODEL,
            { ...MODEL, thinking: "low" },
            { ...MODEL, thinking: "high" },
          ],
        },
        provider: toConnection(provider),
        modelId: "model-1",
        thinkingLevel: "off",
        container: containerInput,
      })

      const rows = db
        .select()
        .from(agents)
        .where(eq(agents.runId, run.id))
        .orderBy(agents.slot)
        .all()
      expect(rows).toHaveLength(3)
      expect(rows.map((a) => a.slot)).toEqual([
        "solver-a",
        "solver-b",
        "solver-c",
      ])
      expect(rows.filter((a) => a.isEntry)).toHaveLength(1)
      expect(rows.map((a) => a.thinkingLevel)).toEqual(["off", "low", "high"])
      // All three prime the initial prompt (hang sessions → still running).
      expect(rows.map((a) => a.status)).toEqual([
        "running",
        "running",
        "running",
      ])
      await runService.close()
    } finally {
      close()
    }
  })

  test("observer-solver creates solver (primed) + observer (own model, peer tools)", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const provider = makeProvider()
      const runService = makeService(db, sqlite, dir, provider)

      const run = await runService.create({
        scopeType: "challenge" as const,
        challengeId: "ch-1",
        orchestration: "observer-solver",
        params: { observerModel: MODEL },
        provider: toConnection(provider),
        modelId: "model-1",
        thinkingLevel: "off",
        container: containerInput,
      })

      const rows = db
        .select()
        .from(agents)
        .where(eq(agents.runId, run.id))
        .orderBy(agents.createdAt)
        .all()
      expect(rows).toHaveLength(2)
      expect(rows[0]!.slot).toBe("solver")
      expect(rows[0]!.status).toBe("running") // primed
      expect(rows[1]!.slot).toBe("observer")
      expect(rows[1]!.status).toBe("idle") // not primed
      expect(JSON.parse(rows[1]!.tools)).toEqual([
        "message_agent",
        "read_agent",
        "list_agents",
      ])
      await runService.close()
    } finally {
      close()
    }
  })

  test("bootstrap-solver primes bootstrap only; solver is the entry", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const provider = makeProvider()
      const runService = makeService(db, sqlite, dir, provider)

      const run = await runService.create({
        scopeType: "challenge" as const,
        challengeId: "ch-1",
        orchestration: "bootstrap-solver",
        provider: toConnection(provider),
        modelId: "model-1",
        thinkingLevel: "off",
        container: containerInput,
      })

      const rows = db
        .select()
        .from(agents)
        .where(eq(agents.runId, run.id))
        .orderBy(agents.slot)
        .all()
      expect(rows).toHaveLength(2)
      const bootstrap = rows[0]!
      const solver = rows[1]!
      expect(bootstrap.slot).toBe("bootstrap")
      expect(bootstrap.status).toBe("running") // primed
      expect(JSON.parse(bootstrap.tools)).not.toContain("finish_run")
      expect(solver.slot).toBe("solver")
      expect(solver.isEntry).toBe(true)
      expect(solver.status).toBe("idle")
      await runService.close()
    } finally {
      close()
    }
  })

  test("scheduler creates an event-scoped run with one orchestrator agent", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      const provider = makeProvider()
      const runService = makeService(db, sqlite, dir, provider)

      const run = await runService.create({
        scopeType: "event" as const,
        eventId: "evt-1",
        orchestration: "scheduler",
        params: { model: MODEL },
        instruction: "",
        provider: toConnection(provider),
        modelId: "model-1",
        thinkingLevel: "off",
        container: containerInput,
      })

      expect(run.scopeType).toBe("event")
      const rows = db
        .select()
        .from(agents)
        .where(eq(agents.runId, run.id))
        .all()
      expect(rows).toHaveLength(1)
      expect(rows[0]!.slot).toBe("orchestrator")
      expect(rows[0]!.role).toBe("orchestrator")
      expect(rows[0]!.isEntry).toBe(true)
      expect(JSON.parse(rows[0]!.tools)).toContain("enqueue_run")
      expect(JSON.parse(rows[0]!.tools)).toContain("start_run")
      expect(JSON.parse(rows[0]!.tools)).toContain("get_status")
      await runService.close()
    } finally {
      close()
    }
  })

  test("scheduler start replaces a previous closed scheduler run (newSession)", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedRun(db, {
        id: "old-sched",
        scopeType: "event",
        eventId: "evt-1",
        challengeId: null,
        orchestration: "scheduler",
        status: "closed",
      })
      const provider = makeProvider()
      const runService = makeService(db, sqlite, dir, provider)

      const run = await runService.create({
        scopeType: "event" as const,
        eventId: "evt-1",
        orchestration: "scheduler",
        params: { model: MODEL },
        instruction: "",
        provider: toConnection(provider),
        modelId: "model-1",
        thinkingLevel: "off",
        container: containerInput,
      })

      expect(run.id).not.toBe("old-sched")
      // The old closed row is gone; only the fresh scheduler run remains.
      const rows = db
        .select()
        .from(runs)
        .where(eq(runs.scopeType, "event"))
        .all()
      expect(rows).toHaveLength(1)
      expect(rows[0]!.id).toBe(run.id)
      await runService.close()
    } finally {
      close()
    }
  })

  test("scheduler start rejects when a live scheduler run exists", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedRun(db, {
        id: "live-sched",
        scopeType: "event",
        eventId: "evt-1",
        challengeId: null,
        orchestration: "scheduler",
        status: "running",
      })
      const provider = makeProvider()
      const runService = makeService(db, sqlite, dir, provider)

      await expect(
        runService.create({
          scopeType: "event" as const,
          eventId: "evt-1",
          orchestration: "scheduler",
          params: { model: MODEL },
          instruction: "",
          provider: toConnection(provider),
          modelId: "model-1",
          thinkingLevel: "off",
          container: containerInput,
        })
      ).rejects.toThrow(/already active/)
      await runService.close()
    } finally {
      close()
    }
  })

  test("multi-agent finish tears the whole run down (all agents idle/closed)", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const provider = makeProvider()
      const runService = makeService(db, sqlite, dir, provider)

      const run = await runService.create({
        scopeType: "challenge" as const,
        challengeId: "ch-1",
        orchestration: "trio",
        params: {
          models: [
            MODEL,
            { ...MODEL, thinking: "low" },
            { ...MODEL, thinking: "high" },
          ],
        },
        provider: toConnection(provider),
        modelId: "model-1",
        thinkingLevel: "off",
        container: containerInput,
      })

      const closed = await runService.finish(run.id, "done")
      expect(closed.status).toBe("closed")
      const rows = db
        .select()
        .from(agents)
        .where(eq(agents.runId, run.id))
        .all()
      // Streaming agents land on idle (their sessions are disposed).
      expect(rows.map((a) => a.status)).toEqual(["idle", "idle", "idle"])
      await runService.close()
    } finally {
      close()
    }
  })
})
