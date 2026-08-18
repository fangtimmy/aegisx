import { describe, expect, mock, test } from "bun:test"

import { eq } from "drizzle-orm"

import { agents, channelMessages } from "../../src/db/schema"
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
  now,
} from "../helpers"

/** Container manager whose create is SLOW (simulates a real docker build) and
 * records calls — lets two concurrent reopens overlap and race the shared
 * challenge container. */
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

describe("reopen single-flight (v19)", () => {
  test("concurrent reopens of terminal agents on the same challenge restore the shared container exactly once", async () => {
    const { db, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      seedAgent(db, {
        id: "a-1",
        eventId: "evt-1",
        challengeId: "ch-1",
        status: "completed",
        sessionFile: "sess-1",
        name: "A",
        createdAt: now(),
        updatedAt: now(),
      })
      seedAgent(db, {
        id: "a-2",
        eventId: "evt-1",
        challengeId: "ch-1",
        status: "completed",
        sessionFile: "sess-2",
        name: "B",
        createdAt: now(),
        updatedAt: now(),
      })

      const provider = makeProvider()
      const { manager, created, removed } = slowContainerManager(30)
      const promptLog = new Map<string, string[]>()
      const service = createAgentService({
        db,
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

      // Two agents woken at once — each takes its own agent lock, so both
      // reach prepareAgent concurrently and race the shared challenge
      // container build.
      await Promise.all([
        service.sendMessage("a-1", { text: "wake 1" }),
        service.sendMessage("a-2", { text: "wake 2" }),
      ])

      // The shared challenge container was built ONCE.
      expect(created).toHaveLength(1)
      expect(removed).toHaveLength(0)
      // Both agents came online and both messages were driven.
      expect([...promptLog.keys()].sort()).toEqual(["a-1", "a-2"])
      expect(promptLog.get("a-1")![0]).toContain("wake 1")
      expect(promptLog.get("a-2")![0]).toContain("wake 2")
      // No channel rows were produced by the direct messages (a reopen only
      // emits an agent.reopened orch notice, not a dm row).
      expect(
        db
          .select()
          .from(channelMessages)
          .where(eq(channelMessages.channelKey, "dm:a-1"))
          .all()
      ).toHaveLength(0)
      const rows = db.select().from(agents).all()
      expect(rows.every((a) => a.status === "idle")).toBe(true)
      await service.close()
    } finally {
      close()
    }
  })
})
