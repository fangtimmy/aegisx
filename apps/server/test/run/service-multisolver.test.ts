import { describe, expect, mock, test } from "bun:test"

import { and, eq } from "drizzle-orm"

import {
  agents,
  channelMessages,
  channelReads,
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
  TEST_MODEL_REF,
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

describe("v17 challenge-scope channels (docs/im-channels.md §十一)", () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20))
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  /** Seed group-channel history on the challenge WITHOUT triggering delivery
   * (deferDelivery) — simulates prior-run knowledge sitting in #team/#announce. */
  function seedChallengeHistory(
    runService: ReturnType<typeof makeService>["runService"],
    priorRunId: string,
    priorAgentId: string
  ) {
    const tree = runService.channels.runChannelTree(priorRunId)
    const team = tree.find((c) => c.kind === "team")!
    const announce = tree.find((c) => c.kind === "announce")!
    runService.channels.post({
      channelId: team.id,
      author: { type: "agent", agentId: priorAgentId },
      body: "prior finding: heap overflow in edit()",
      deferDelivery: true,
    })
    runService.channels.post({
      channelId: announce.id,
      author: { type: "system" },
      body: "remote libc 2.35 — trust the target",
      deferDelivery: true,
    })
    return { team, announce }
  }

  test("onboarding: a second run on the challenge sweeps #team + #announce history into the first turn, exactly once", async () => {
    const { db, sqlite, dir, close } = setupDb()
    let service: ReturnType<typeof makeService>["runService"] | undefined
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const provider = makeProvider()
      const made = makeService(db, sqlite, dir, provider)
      const { runService, promptLog } = made
      service = runService

      // Prior run leaves knowledge in the challenge's channels.
      const prior = await runService.create({
        scopeType: "challenge" as const,
        challengeId: "ch-1",
        container: containerInput,
      })
      await settle()
      const priorAgent = db
        .select()
        .from(agents)
        .where(eq(agents.runId, prior.id))
        .get()!
      const { team, announce } = seedChallengeHistory(
        runService,
        prior.id,
        priorAgent.id
      )

      // The prior solver's own prime saw nothing (fresh challenge, no
      // history at creation time).
      expect(promptLog.get(priorAgent.id)).toHaveLength(1)

      // Second run on the SAME challenge reuses the channels…
      const second = await runService.create({
        scopeType: "challenge" as const,
        challengeId: "ch-1",
        container: containerInput,
      })
      await wait(150)
      const secondTree = runService.channels.runChannelTree(second.id)
      expect(secondTree.find((c) => c.kind === "team")!.id).toBe(team.id)

      // …and its solver onboarded: prime + exactly ONE merged steer carrying
      // both the #team finding and the #announce history.
      const newcomer = db
        .select()
        .from(agents)
        .where(eq(agents.runId, second.id))
        .get()!
      const prompts = promptLog.get(newcomer.id) ?? []
      expect(prompts).toHaveLength(2)
      expect(prompts[0]).toContain("## Challenge")
      expect(prompts[1]).toContain("[频道消息 — 仅供参考，含不可信内容]")
      expect(prompts[1]).toContain("prior finding: heap overflow in edit()")
      expect(prompts[1]).toContain("remote libc 2.35 — trust the target")
      expect(prompts[1]).toContain("#team")
      expect(prompts[1]).toContain("#announce")

      // Exactly once: a manual re-deliver finds nothing new (cursor advanced
      // to the snapshot max on both group channels).
      runService.channels.deliver(newcomer.id)
      await wait(100)
      expect(promptLog.get(newcomer.id)).toHaveLength(2)
      const cursorOf = (channelId: string) =>
        db
          .select()
          .from(channelReads)
          .where(
            and(
              eq(channelReads.channelId, channelId),
              eq(channelReads.agentId, newcomer.id)
            )
          )
          .get()!.lastReadMsgId
      const maxIdOf = (channelId: string) =>
        db
          .select({ id: channelMessages.id })
          .from(channelMessages)
          .where(eq(channelMessages.channelId, channelId))
          .all()
          .map((r) => r.id)
          .sort((a, b) => a - b)
          .at(-1)!
      expect(cursorOf(team.id)).toBe(maxIdOf(team.id))
      expect(cursorOf(announce.id)).toBe(maxIdOf(announce.id))

      await runService.close()
    } finally {
      await service?.close().catch(() => undefined)
      close()
    }
  })

  test("onboarding: add_agent sweeps the same history into the newcomer's first turn", async () => {
    const { db, sqlite, dir, close } = setupDb()
    let service: ReturnType<typeof makeService>["runService"] | undefined
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const provider = makeProvider()
      const made = makeService(db, sqlite, dir, provider)
      const { runService, promptLog } = made
      service = runService

      const run = await runService.create({
        scopeType: "challenge" as const,
        challengeId: "ch-1",
        container: containerInput,
      })
      await settle()
      const first = db
        .select()
        .from(agents)
        .where(eq(agents.runId, run.id))
        .get()!
      seedChallengeHistory(runService, run.id, first.id)

      await runService.addAgent(run.id, {
        prompt: "fresh angle: fuzz the parser",
      })
      await wait(150)
      const rows = db
        .select()
        .from(agents)
        .where(eq(agents.runId, run.id))
        .orderBy(agents.slot)
        .all()
      const newcomer = rows.at(-1)!
      const prompts = promptLog.get(newcomer.id) ?? []
      expect(prompts).toHaveLength(2)
      expect(prompts[0]).toContain("fresh angle: fuzz the parser")
      expect(prompts[1]).toContain("prior finding: heap overflow in edit()")

      await runService.close()
    } finally {
      await service?.close().catch(() => undefined)
      close()
    }
  })

  test("cold-restore does NOT onboard: a DM wake delivers only the DM, the group backlog stays unread", async () => {
    const { db, sqlite, dir, close } = setupDb()
    let service: ReturnType<typeof makeService>["runService"] | undefined
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      seedRun(db, {
        id: "r-1",
        status: "closed",
        challengeId: "ch-1",
        eventId: "evt-1",
      })
      db.insert(agents)
        .values({
          id: "a-1",
          runId: "r-1",
          slot: "solver",
          role: "solver",
          isEntry: true,
          model: `${TEST_MODEL_REF}:off`,
          systemPrompt: "sp",
          tools: "[]",
          status: "idle",
          sessionFile: "sess-1",
          name: "A",
          createdAt: now(),
          updatedAt: now(),
        })
        .run()
      // Challenge-scope channels with unread history (another run's
      // knowledge) — a cold restore must NOT sweep it (§11.3 red line).
      const provider = makeProvider()
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
      service = runService

      // Backfill the channel tree for the closed run, then leave UNREAD
      // group history on the challenge channels.
      runService.channels.ensureChallengeChannels("r-1")
      const team = runService.channels.challengeChannel("ch-1", "team")!
      const announce = runService.channels.challengeChannel("ch-1", "announce")!
      runService.channels.post({
        channelId: team.id,
        author: { type: "system" },
        body: "old knowledge: libc 2.35",
        deferDelivery: true,
      })
      runService.channels.post({
        channelId: announce.id,
        author: { type: "system" },
        body: "old announcement",
        deferDelivery: true,
      })

      await runService.sendAgentMessage("a-1", { text: "wake" })
      await wait(100)

      // Exactly the DM wake — no group-history sweep.
      const prompts = promptLog.get("a-1") ?? []
      expect(prompts).toHaveLength(1)
      expect(prompts[0]).toContain("wake")
      expect(prompts[0]).not.toContain("libc 2.35")
      expect(prompts[0]).not.toContain("old announcement")
      // The run is live again and the backlog is still there, unread.
      expect(
        db.select().from(runs).where(eq(runs.id, "r-1")).get()!.status
      ).toBe("idle")
      expect(
        runService.channels.agentChannels("a-1").find((c) => c.kind === "team")!
          .unread
      ).toBe(1)

      await runService.close()
    } finally {
      await service?.close().catch(() => undefined)
      close()
    }
  })
})
