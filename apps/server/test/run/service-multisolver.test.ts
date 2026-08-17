import { describe, expect, mock, test } from "bun:test"

import { eq } from "drizzle-orm"

import { agents } from "../../src/db/schema"
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

type Db = ReturnType<typeof setupDb>

/** Service whose createHost stub records every prompt text per agent id. */
function makeService(
  db: Db["db"],
  sqlite: Db["sqlite"],
  dir: string,
  provider: ReturnType<typeof makeProvider>,
  opts: { hang?: boolean } = {}
) {
  const hang = opts.hang ?? true
  const { manager } = stubContainerManager()
  const promptLog = new Map<string, string[]>()
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
      }
      return stub
    }),
  })
  return { runService, promptLog }
}

describe("v9 direct N-solver creation", () => {
  test("N=3 creates 3 solver rows (solver-1 entry), each primed with its own initial", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const provider = makeProvider()
      const { runService, promptLog } = makeService(db, sqlite, dir, provider)

      const run = await runService.create({
        scopeType: "challenge" as const,
        challengeId: "ch-1",
        solvers: [
          { model: `${TEST_MODEL_REF}:off` },
          { model: `${TEST_MODEL_REF}:low` },
          { model: `${TEST_MODEL_REF}:high` },
        ],
        container: containerInput,
      })
      await runService.close()

      const rows = db
        .select()
        .from(agents)
        .where(eq(agents.runId, run.id))
        .orderBy(agents.slot)
        .all()
      expect(rows).toHaveLength(3)
      expect(rows.map((a) => a.slot)).toEqual([
        "solver-1",
        "solver-2",
        "solver-3",
      ])
      expect(rows.filter((a) => a.isEntry).map((a) => a.slot)).toEqual([
        "solver-1",
      ])
      expect(rows.map((a) => a.model)).toEqual([
        `${TEST_MODEL_REF}:off`,
        `${TEST_MODEL_REF}:low`,
        `${TEST_MODEL_REF}:high`,
      ])
      // All three prime and settle (the stub prompt resolves immediately).
      expect(rows.map((a) => a.status)).toEqual(["idle", "idle", "idle"])
      // Three distinct prime deliveries arrived, one per solver session.
      const primed = [...promptLog.values()].filter((list) => list.length > 0)
      expect(primed).toHaveLength(3)
      for (const list of primed) {
        expect(list).toHaveLength(1)
        expect(list[0]).toContain("## Challenge")
      }
    } finally {
      close()
    }
  })

  test("multiSolver renders the co-solver section only when N>1", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const provider = makeProvider()
      const { runService } = makeService(db, sqlite, dir, provider)

      const single = await runService.create({
        scopeType: "challenge" as const,
        challengeId: "ch-1",
        container: containerInput,
      })
      const triple = await runService.create({
        scopeType: "challenge" as const,
        challengeId: "ch-1",
        solvers: [{}, {}, {}],
        container: containerInput,
      })
      await runService.close()

      const singlePrompt = db
        .select()
        .from(agents)
        .where(eq(agents.runId, single.id))
        .get()!.systemPrompt
      const triplePrompt = db
        .select()
        .from(agents)
        .where(eq(agents.runId, triple.id))
        .get()!.systemPrompt
      // Channels era (docs/im-channels.md §6): the multiSolver-gated
      // Co-solvers file convention is replaced by the channel section,
      // rendered for every solver run (single keeps ask/#team/attachments).
      expect(singlePrompt).toContain("## Channels（团队频道）")
      expect(triplePrompt).toContain("## Channels（团队频道）")
      expect(singlePrompt).not.toContain("## Co-solvers")
      expect(triplePrompt).not.toContain("## Co-solvers")
      expect(triplePrompt).toContain('aegisx.channels.post("#team"')
    } finally {
      close()
    }
  })

  test("override mode primes the raw prompt; strategy mode appends run-level + solver-level strategy", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const provider = makeProvider()
      const { runService, promptLog } = makeService(db, sqlite, dir, provider)

      const run = await runService.create({
        scopeType: "challenge" as const,
        challengeId: "ch-1",
        strategy: "run-level strategy text",
        solvers: [
          { prompt: "OVERRIDE-BODY", promptMode: "override" },
          { prompt: "solver-level strategy text" },
        ],
        container: containerInput,
      })
      await runService.close()

      const rows = db
        .select()
        .from(agents)
        .where(eq(agents.runId, run.id))
        .orderBy(agents.slot)
        .all()
      // override = the raw prompt is the whole first turn.
      const overrideTexts = promptLog.get(rows[0]!.id) ?? []
      expect(overrideTexts.join("\n")).toBe("OVERRIDE-BODY")
      // strategy mode = standard blocks + a Strategy section with both parts.
      const strategyTexts = (promptLog.get(rows[1]!.id) ?? []).join("\n")
      expect(strategyTexts).toContain("## Challenge")
      expect(strategyTexts).toContain("## Strategy")
      expect(strategyTexts).toContain("run-level strategy text")
      expect(strategyTexts).toContain("solver-level strategy text")
      // Run-level first, solver-level after.
      expect(
        strategyTexts.indexOf("run-level strategy text") <
          strategyTexts.indexOf("solver-level strategy text")
      ).toBe(true)
    } finally {
      close()
    }
  })

  test("rejects more than MAX_SOLVERS_PER_RUN solvers and unresolvable model refs", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const provider = makeProvider()
      const { runService } = makeService(db, sqlite, dir, provider)

      await expect(
        runService.create({
          scopeType: "challenge" as const,
          challengeId: "ch-1",
          solvers: [{}, {}, {}, {}, {}],
          container: containerInput,
        })
      ).rejects.toThrow(/at most 4 solvers/)

      await expect(
        runService.create({
          scopeType: "challenge" as const,
          challengeId: "ch-1",
          solvers: [{ model: "nope/hallucinated:off" }],
          container: containerInput,
        })
      ).rejects.toThrow(/hallucinated/)
    } finally {
      close()
    }
  })

  test("finish race: one finish wins the teardown, the other is a no-op", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const provider = makeProvider()
      const { runService } = makeService(db, sqlite, dir, provider)

      const run = await runService.create({
        scopeType: "challenge" as const,
        challengeId: "ch-1",
        solvers: [{}, {}],
        container: containerInput,
      })
      await runService.close()

      // Both solvers race finish_run's atomic claim (markFinishing): exactly
      // one wins; the loser's claim is a no-op and never tears down twice.
      const rows = db
        .select()
        .from(agents)
        .where(eq(agents.runId, run.id))
        .orderBy(agents.slot)
        .all()
      const claims = rows.map((row) => runService.markFinishing(run.id))
      expect(claims.filter(Boolean)).toHaveLength(1)
      expect(claims.filter((won) => !won)).toHaveLength(1)
    } finally {
      close()
    }
  })
})
