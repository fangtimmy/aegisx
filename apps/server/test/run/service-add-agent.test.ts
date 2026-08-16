import { describe, expect, mock, test } from "bun:test"

import { and, eq } from "drizzle-orm"

import { agents, runs } from "../../src/db/schema"
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
  TEST_MODEL_REF,
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

/** Service whose createHost stub records per-agent prompt texts + how many
 * times each agent's host was built (a cold-restore re-prepares an agent only
 * by building its host again — the "old agents stay dormant" observable). */
function makeService(
  db: Db,
  sqlite: ReturnType<typeof setupDb>["sqlite"],
  dir: string,
  provider: ReturnType<typeof makeProvider>,
  opts: { hang?: boolean } = {}
) {
  const hang = opts.hang ?? true
  const { manager, created } = stubContainerManager()
  const promptLog = new Map<string, string[]>()
  const hostCalls = new Map<string, number>()
  const runService = createRunService({
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
      hostCalls.set(input.agentId, (hostCalls.get(input.agentId) ?? 0) + 1)
      const stub = stubHostAgentSession("sess-" + input.agentId.slice(0, 6), {
        hang,
      })
      const list: string[] = []
      promptLog.set(input.agentId, list)
      const sdk = stub.session as unknown as {
        prompt: (text: string) => Promise<void>
      }
      sdk.prompt = async (text: string) => {
        list.push(text)
        if (hang) await new Promise(() => {})
      }
      return stub
    }),
  })
  return { runService, promptLog, hostCalls, containersCreated: created }
}

function solverRows(db: Db, runId: string) {
  return db
    .select()
    .from(agents)
    .where(and(eq(agents.runId, runId), eq(agents.role, "solver")))
    .orderBy(agents.slot)
    .all()
}

const settle = () => new Promise((r) => setTimeout(r, 10))

describe("add_agent", () => {
  test("on a running run: new solver primes in parallel, the old solver gets no new turn", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const provider = makeProvider()
      const { runService, promptLog, hostCalls } = makeService(
        db,
        sqlite,
        dir,
        provider,
        { hang: true }
      )

      const run = await runService.create({
        scopeType: "challenge" as const,
        challengeId: "ch-1",
        container: containerInput,
      })
      const first = solverRows(db, run.id)[0]!
      expect(hostCalls.get(first.id)).toBe(1)

      const after = await runService.addAgent(run.id, {
        prompt: "second angle: fuzz the parser",
        model: `${TEST_MODEL_REF}:low`,
      })
      expect(after.status).toBe("running")

      const rows = solverRows(db, run.id)
      expect(rows.map((a) => a.slot)).toEqual(["solver-1", "solver-2"])
      expect(rows[1]!.isEntry).toBe(false)
      // The explicit model wins; run.model (solver-1's ref) is untouched.
      expect(rows[1]!.model).toBe(`${TEST_MODEL_REF}:low`)
      expect(
        db
          .select({ model: runs.model })
          .from(runs)
          .where(eq(runs.id, run.id))
          .get()!.model
      ).toBe(`${TEST_MODEL_REF}:off`)

      // New solver primed with the rendered prompt; old solver untouched.
      expect(promptLog.get(rows[1]!.id)).toHaveLength(1)
      expect(promptLog.get(rows[1]!.id)![0]).toContain(
        "second angle: fuzz the parser"
      )
      expect(promptLog.get(rows[0]!.id)).toHaveLength(1)
      // Only the new agent's host was built — no re-prepare of the old one.
      expect(hostCalls.get(rows[0]!.id)).toBe(1)
      expect(hostCalls.get(rows[1]!.id)).toBe(1)
      await runService.close()
    } finally {
      close()
    }
  })

  test("on an idle run: the added solver primes and the run runs again", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const provider = makeProvider()
      const { runService, promptLog } = makeService(db, sqlite, dir, provider, {
        hang: false,
      })

      const run = await runService.create({
        scopeType: "challenge" as const,
        challengeId: "ch-1",
        container: containerInput,
      })
      await settle()
      expect(runService.get(run.id)!.status).toBe("idle")

      await runService.addAgent(run.id, { prompt: "try the remote angle" })
      const rows = solverRows(db, run.id)
      expect(rows.map((a) => a.slot)).toEqual(["solver-1", "solver-2"])
      expect(promptLog.get(rows[1]!.id)![0]).toContain("try the remote angle")
      await settle()
      expect(runService.get(run.id)!.status).toBe("idle")
      await runService.close()
    } finally {
      close()
    }
  })

  test("on a closed run: cold-restores the container, wakes ONLY the new solver", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const provider = makeProvider()
      const { runService, promptLog, hostCalls, containersCreated } =
        makeService(db, sqlite, dir, provider, { hang: true })

      const run = await runService.create({
        scopeType: "challenge" as const,
        challengeId: "ch-1",
        container: containerInput,
      })
      const first = solverRows(db, run.id)[0]!
      expect(containersCreated).toHaveLength(1)
      await runService.closeRun(run.id)
      expect(runService.get(run.id)!.status).toBe("closed")

      const after = await runService.addAgent(run.id, {
        prompt: "fresh eyes on the heap bug",
      })
      expect(after.status).toBe("running")

      const rows = solverRows(db, run.id)
      expect(rows.map((a) => a.slot)).toEqual(["solver-1", "solver-2"])
      // Container rebuilt by the cold-restore...
      expect(containersCreated).toHaveLength(2)
      // ...but the old solver's host was NOT rebuilt (session stays closed)
      // and it received no new turn.
      expect(hostCalls.get(rows[0]!.id)).toBe(1)
      expect(hostCalls.get(rows[1]!.id)).toBe(1)
      expect(promptLog.get(rows[0]!.id)).toHaveLength(1)
      expect(promptLog.get(rows[1]!.id)![0]).toContain(
        "fresh eyes on the heap bug"
      )
      // No model spec → the run's stored ref (solver-1's) is the baseline.
      expect(rows[1]!.model).toBe(`${TEST_MODEL_REF}:off`)
      await runService.close()
    } finally {
      close()
    }
  })

  test("rejects beyond MAX_SOLVERS_PER_RUN and on non-challenge runs", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const provider = makeProvider()
      const { runService } = makeService(db, sqlite, dir, provider, {
        hang: false,
      })

      const full = await runService.create({
        scopeType: "challenge" as const,
        challengeId: "ch-1",
        solvers: [{}, {}, {}, {}],
        container: containerInput,
      })
      await settle()
      await expect(
        runService.addAgent(full.id, { prompt: "one too many" })
      ).rejects.toThrow(/at most 4 solvers/)
      expect(solverRows(db, full.id)).toHaveLength(4)

      const schedulerRun = await runService.create({
        scopeType: "event" as const,
        eventId: "evt-1",
        instruction: "",
        container: containerInput,
      })
      await expect(
        runService.addAgent(schedulerRun.id, { prompt: "no solvers here" })
      ).rejects.toThrow(/Only challenge runs/)
      await runService.close()
    } finally {
      close()
    }
  })

  test("prompt modes: override primes the raw prompt; strategy renders the brief + Strategy section", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const provider = makeProvider()
      const { runService, promptLog } = makeService(db, sqlite, dir, provider, {
        hang: false,
      })

      const run = await runService.create({
        scopeType: "challenge" as const,
        challengeId: "ch-1",
        container: containerInput,
      })
      await settle()

      await runService.addAgent(run.id, {
        prompt: "RAW-OVERRIDE-BODY",
        promptMode: "override",
      })
      await runService.addAgent(run.id, { prompt: "STRATEGY-BODY" })
      const rows = solverRows(db, run.id)
      expect(rows.map((a) => a.slot)).toEqual([
        "solver-1",
        "solver-2",
        "solver-3",
      ])

      const overrideText = promptLog.get(rows[1]!.id)![0]!
      expect(overrideText).toBe("RAW-OVERRIDE-BODY")
      expect(overrideText).not.toContain("## Challenge")

      const strategyText = promptLog.get(rows[2]!.id)![0]!
      expect(strategyText).toContain("## Challenge")
      expect(strategyText).toContain("## Strategy")
      expect(strategyText).toContain("STRATEGY-BODY")
      await runService.close()
    } finally {
      close()
    }
  })
})
