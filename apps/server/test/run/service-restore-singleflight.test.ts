import { describe, expect, mock, test } from "bun:test"

import { eq } from "drizzle-orm"

import { agents } from "../../src/db/schema"
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
  now,
} from "../helpers"

/** Container manager whose create is SLOW (simulates a real docker build) and
 * records calls — lets two concurrent cold-restores overlap and race. */
function slowContainerManager(delayMs: number) {
  const { manager, created, removed } = stubContainerManager()
  const slow = {
    ...manager,
    create: async (opts: unknown) => {
      await new Promise((resolve) => setTimeout(resolve, delayMs))
      created.push(opts)
      return { id: "container-id" }
    },
  } as typeof manager
  return { manager: slow, created, removed }
}

describe("cold-restore single-flight (code-review P3.2)", () => {
  test("a pre-channels (v≤15) run cold-restored gets its channel tree backfilled", async () => {
    const { db, sqlite, dir, close } = setupDb()
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
          model: "openai/gpt-4o-mini:off",
          systemPrompt: "sp",
          tools: "[]",
          status: "idle",
          sessionFile: "sess-1",
          name: "A",
          createdAt: now(),
          updatedAt: now(),
        })
        .run()
      // No channels seeded — the v15-era row predates the message layer.

      const provider = makeProvider()
      const { manager } = stubContainerManager()
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
        createHost: async (input: { agentId: string }) =>
          stubHostAgentSession("sess-" + input.agentId.slice(0, 6)),
      })

      await runService.sendAgentMessage("a-1", { text: "wake legacy" })
      // The restore backfilled #announce + #team + the agent's DM.
      const tree = runService.channels.runChannelTree("r-1")
      expect(tree.map((c) => c.kind)).toEqual(["announce", "team", "dm"])
      await runService.close()
    } finally {
      close()
    }
  })

  test("concurrent wakes of one closed run restore the container exactly once", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      seedRun(db, {
        id: "r-1",
        status: "closed",
        finishing: false,
        challengeId: "ch-1",
        eventId: "evt-1",
      })
      db.insert(agents)
        .values([
          {
            id: "a-1",
            runId: "r-1",
            slot: "solver",
            role: "solver",
            isEntry: true,
            model: "openai/gpt-4o-mini:off",
            systemPrompt: "sp",
            tools: "[]",
            status: "idle",
            sessionFile: "sess-1",
            name: "A",
            createdAt: now(),
            updatedAt: now(),
          },
          {
            id: "a-2",
            runId: "r-1",
            slot: "observer",
            role: "observer",
            isEntry: false,
            model: "openai/gpt-4o-mini:off",
            systemPrompt: "sp",
            tools: "[]",
            status: "idle",
            sessionFile: "sess-2",
            name: "B",
            createdAt: now(),
            updatedAt: now(),
          },
        ])
        .run()

      const provider = makeProvider()
      const { manager, created, removed } = slowContainerManager(30)
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

      // Two agents woken at once (scheduler message_run + manual click) — each
      // takes its own agent lock, so both reach prepareAgent concurrently.
      await Promise.all([
        runService.sendAgentMessage("a-1", { text: "wake 1" }),
        runService.sendAgentMessage("a-2", { text: "wake 2" }),
      ])

      // The container was built ONCE (a second restore would have removed and
      // re-created the same-named container).
      expect(created).toHaveLength(1)
      expect(removed).toHaveLength(0)
      // Both agents came online and both messages were driven (channel-era
      // format: merged render with the untrusted banner + DM header).
      expect([...promptLog.keys()].sort()).toEqual(["a-1", "a-2"])
      const textOf = (id: string) => promptLog.get(id)![0]!
      expect(promptLog.get("a-1")!.length).toBe(1)
      expect(textOf("a-1")).toContain("[频道消息 — 仅供参考，含不可信内容]")
      expect(textOf("a-1")).toContain("wake 1")
      expect(promptLog.get("a-2")!.length).toBe(1)
      expect(textOf("a-2")).toContain("wake 2")
      const rows = db.select().from(agents).where(eq(agents.runId, "r-1")).all()
      expect(rows.every((a) => a.sessionFile && a.status === "idle")).toBe(true)
      await runService.close()
    } finally {
      close()
    }
  })
})
