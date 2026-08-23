import { describe, expect, mock, test } from "bun:test"

import { and, eq } from "drizzle-orm"

import { agents, channelMessages, channelReads } from "../../src/db/schema"
import { teamKey } from "../../src/run/channels"
import { createAgentService } from "../../src/run/service"
import {
  flatSettingsWithDefaultModel,
  makeProvider,
  seedAgent,
  seedChallenge,
  seedEvent,
  setupDb,
  stubConfigStore,
  stubContainerManager,
  stubHostAgentSession,
  TEST_MODEL_REF,
  now,
} from "../helpers"
import { refine } from "../support"

type Db = ReturnType<typeof setupDb>

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Seed #team history WITHOUT triggering delivery (non-urgent posts; the
 * agents stay hanging/primed) — prior-attempt knowledge sitting in #team. */
function seedChallengeHistory(
  agentService: ReturnType<typeof makeService>["agentService"],
  priorAgentId: string
) {
  agentService.channels.post({
    channelKey: teamKey("ch-1"),
    author: { type: "agent", agentId: priorAgentId },
    body: "prior finding: heap overflow in edit()",
  })
  agentService.channels.post({
    channelKey: teamKey("ch-1"),
    author: { type: "system" },
    body: "remote libc 2.35 — trust the target",
  })
}

/** Service whose createHost stub records every prompt text per agent id. */
function makeService(
  db: Db["db"],
  dir: string,
  provider: ReturnType<typeof makeProvider>,
  opts: { hang?: boolean; getSettings?: () => Record<string, unknown> } = {}
) {
  const hang = opts.hang ?? true
  const { manager } = stubContainerManager()
  const promptLog = new Map<string, string[]>()
  const agentService = createAgentService({
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
    getSettings: refine(opts.getSettings ?? flatSettingsWithDefaultModel),
    createHost: mock(async (input: { agentId: string }) => {
      const stub = stubHostAgentSession("sess-" + input.agentId.slice(0, 6), {
        hang,
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
  return { agentService, promptLog }
}

describe("v19 multi-spawn on one challenge", () => {
  test("three spawns create 3 solver agents, each primed with its own initial", async () => {
    const { db, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const provider = makeProvider()
      const { agentService, promptLog } = makeService(db, dir, provider)

      const spawned = await Promise.all(
        [
          `${TEST_MODEL_REF}:off`,
          `${TEST_MODEL_REF}:low`,
          `${TEST_MODEL_REF}:high`,
        ].map((model) =>
          agentService.spawn({ eventId: "evt-1", challengeId: "ch-1", model })
        )
      )
      await agentService.close()

      expect(spawned).toHaveLength(3)
      const rows = db
        .select()
        .from(agents)
        .where(eq(agents.challengeId, "ch-1"))
        .orderBy(agents.createdAt)
        .all()
      expect(rows).toHaveLength(3)
      expect(new Set(rows.map((a) => a.model))).toEqual(
        new Set([
          `${TEST_MODEL_REF}:off`,
          `${TEST_MODEL_REF}:low`,
          `${TEST_MODEL_REF}:high`,
        ])
      )
      // All three prime and settle (the stub prompt resolves immediately).
      expect(rows.map((a) => a.status)).toEqual(["idle", "idle", "idle"])
      // Three distinct prime deliveries arrived, one per agent session.
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

  test("the system prompt carries the channel section for every solver", async () => {
    const { db, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const provider = makeProvider()
      const { agentService } = makeService(db, dir, provider)

      await agentService.spawn({ eventId: "evt-1", challengeId: "ch-1" })
      await agentService.close()

      const row = db
        .select()
        .from(agents)
        .where(eq(agents.challengeId, "ch-1"))
        .get()!
      expect(row.systemPrompt).toContain("## Channels（团队频道）")
      expect(row.systemPrompt).not.toContain("## Co-solvers")
      expect(row.systemPrompt).toContain("/opt/aegisx-sdk/GUIDE.md")
    } finally {
      close()
    }
  })

  test("override mode primes the raw prompt; strategy mode appends the strategy section", async () => {
    const { db, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const provider = makeProvider()
      const { agentService, promptLog } = makeService(db, dir, provider)

      const [overrideAgent, strategyAgent] = await Promise.all([
        agentService.spawn({
          eventId: "evt-1",
          challengeId: "ch-1",
          prompt: "OVERRIDE-BODY",
          promptMode: "override",
        }),
        agentService.spawn({
          eventId: "evt-1",
          challengeId: "ch-1",
          prompt: "spawn strategy text",
        }),
      ])
      await agentService.close()

      // override = the raw prompt is the whole first turn.
      const overrideTexts = promptLog.get(overrideAgent.id) ?? []
      expect(overrideTexts.join("\n")).toBe("OVERRIDE-BODY")
      // strategy mode = standard blocks + a Strategy section.
      const strategyTexts = (promptLog.get(strategyAgent.id) ?? []).join("\n")
      expect(strategyTexts).toContain("## Challenge")
      expect(strategyTexts).toContain("## Strategy")
      expect(strategyTexts).toContain("spawn strategy text")
    } finally {
      close()
    }
  })

  test("no per-challenge cap: 5 spawns on one challenge under a raised global cap; unresolvable refs reject", async () => {
    const { db, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const provider = makeProvider()
      const { agentService } = makeService(db, dir, provider, {
        getSettings: () => ({
          ...flatSettingsWithDefaultModel(),
          "scheduler.maxConcurrentAgents": 6,
        }),
      })

      // v19 decision: parallel attempts on one challenge are legal — with
      // the global cap raised, 5 agents on ONE challenge all spawn.
      const spawned = []
      for (let i = 0; i < 5; i += 1) {
        spawned.push(
          await agentService.spawn({ eventId: "evt-1", challengeId: "ch-1" })
        )
      }
      expect(spawned).toHaveLength(5)
      await agentService.close()

      // An unresolvable model ref fails the spawn with the ref in the error.
      const fresh = makeService(db, dir, provider)
      await expect(
        fresh.agentService.spawn({
          eventId: "evt-1",
          challengeId: "ch-1",
          model: "nope/hallucinated:off",
        })
      ).rejects.toThrow(/hallucinated/)
      await fresh.agentService.close()
    } finally {
      close()
    }
  })

  test("no atomic flag: each spawned agent finishes independently with its own summary", async () => {
    const { db, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const provider = makeProvider()
      const { agentService } = makeService(db, dir, provider)

      const [a, b] = await Promise.all([
        agentService.spawn({ eventId: "evt-1", challengeId: "ch-1" }),
        agentService.spawn({ eventId: "evt-1", challengeId: "ch-1" }),
      ])
      const first = await agentService.finishAgent(a.id, "summary A")
      const second = await agentService.finishAgent(b.id, "summary B")
      await agentService.close()

      expect(first.status).toBe("completed")
      expect(first.summary).toBe("summary A")
      expect(second.status).toBe("completed")
      expect(second.summary).toBe("summary B")
    } finally {
      close()
    }
  })

  test("onboarding: a second spawn on the challenge sweeps the whole #team history into the first turn, exactly once", async () => {
    const { db, dir, close } = setupDb()
    let service: ReturnType<typeof makeService>["agentService"] | undefined
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const provider = makeProvider()
      const made = makeService(db, dir, provider)
      const { agentService, promptLog } = made
      service = agentService

      // A prior attempt leaves knowledge in the challenge's #team.
      const prior = await agentService.spawn({
        eventId: "evt-1",
        challengeId: "ch-1",
      })
      await settle()
      seedChallengeHistory(agentService, prior.id)

      // The prior agent's own prime saw nothing (fresh challenge, no history
      // at creation time).
      expect(promptLog.get(prior.id)).toHaveLength(1)

      // A second spawn on the SAME challenge shares team:ch-1…
      const newcomer = await agentService.spawn({
        eventId: "evt-1",
        challengeId: "ch-1",
      })
      await wait(150)
      const tree = agentService.channels.challengeChannelTree("ch-1")
      expect(tree.find((c) => c.kind === "team")!.key).toBe(teamKey("ch-1"))

      // …and the newcomer onboarded: prime + exactly ONE merged steer
      // carrying BOTH knowledge posts.
      const prompts = promptLog.get(newcomer.id) ?? []
      expect(prompts).toHaveLength(2)
      expect(prompts[0]).toContain("## Challenge")
      expect(prompts[1]).toContain("[频道消息]")
      expect(prompts[1]).toContain("prior finding: heap overflow in edit()")
      expect(prompts[1]).toContain("remote libc 2.35 — trust the target")

      // Exactly once: a manual re-deliver finds nothing new (the cursor
      // advanced to the snapshot max on the sweep).
      agentService.channels.deliver(newcomer.id)
      await wait(100)
      expect(promptLog.get(newcomer.id)).toHaveLength(2)
      expect(
        db
          .select()
          .from(channelReads)
          .where(
            and(
              eq(channelReads.channelKey, teamKey("ch-1")),
              eq(channelReads.readerKey, newcomer.id)
            )
          )
          .get()!.lastReadMsgId
      ).toBe(
        Math.max(
          ...db
            .select({ id: channelMessages.id })
            .from(channelMessages)
            .where(eq(channelMessages.channelKey, teamKey("ch-1")))
            .all()
            .map((r) => r.id)
        )
      )

      await agentService.close()
    } finally {
      await service?.close().catch(() => undefined)
      close()
    }
  })

  test("cold reopen does NOT onboard: a direct wake delivers only the message; the #team backlog stays unread", async () => {
    const { db, dir, close } = setupDb()
    let service: ReturnType<typeof makeService>["agentService"] | undefined
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      seedAgent(db, {
        id: "a-1",
        eventId: "evt-1",
        challengeId: "ch-1",
        model: `${TEST_MODEL_REF}:off`,
        status: "completed",
        sessionFile: "sess-1",
        name: "A",
        createdAt: now(),
        updatedAt: now(),
      })
      // #team with unread history (another attempt's knowledge) — a reopen
      // must NOT sweep it (§11.3 red line; user input is direct).
      const provider = makeProvider()
      const { manager } = stubContainerManager()
      const promptLog = new Map<string, string[]>()
      const agentService = createAgentService({
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
        getSettings: flatSettingsWithDefaultModel,
        createHost: mock(async (input: { agentId: string }) => {
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
      service = agentService

      // Unread challenge history on the #team.
      agentService.channels.post({
        channelKey: teamKey("ch-1"),
        author: { type: "system" },
        body: "old knowledge: libc 2.35",
      })

      await agentService.sendMessage("a-1", { text: "wake" })
      await wait(100)

      // Exactly the direct message — no group-history sweep.
      const prompts = promptLog.get("a-1") ?? []
      expect(prompts).toHaveLength(1)
      expect(prompts[0]).toContain("wake")
      expect(prompts[0]).not.toContain("libc 2.35")
      // The agent is live again (reopened) and the backlog stays unread.
      expect(
        db.select().from(agents).where(eq(agents.id, "a-1")).get()!.status
      ).toBe("idle")
      expect(
        agentService.channels
          .agentChannels("a-1")
          .find((c) => c.kind === "team")!.unread
      ).toBe(1)

      await agentService.close()
    } finally {
      await service?.close().catch(() => undefined)
      close()
    }
  })
})
