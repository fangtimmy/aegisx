import { describe, expect, mock, test } from "bun:test"

import { eq } from "drizzle-orm"

import { agents, spawnQueue } from "../../src/db/schema"
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
} from "../helpers"
import { refine } from "../support"

const now = () => new Date().toISOString()

function makeService(db: ReturnType<typeof setupDb>["db"], dir: string) {
  const { manager } = stubContainerManager()
  return createAgentService({
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
    configStore: stubConfigStore([makeProvider()]),
    getSettings: flatSettingsWithDefaultModel,
    createHost: mock(async () => stubHostAgentSession()),
  })
}

describe("deleteAgent", () => {
  test("a queue-launched agent's running item settles done — nothing sticks in the visible queue", async () => {
    const { db, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const service = makeService(db, dir)
      seedAgent(db, {
        id: "ag-q",
        eventId: "evt-1",
        challengeId: "ch-1",
        status: "running",
        queueItemId: "q-1",
      })
      db.insert(spawnQueue)
        .values({
          id: "q-1",
          eventId: "evt-1",
          ord: 1,
          challengeId: "ch-1",
          params: "{}",
          prompt: "",
          source: "manual",
          status: "running",
          agentId: "ag-q",
          createdAt: now(),
          updatedAt: now(),
        })
        .run()

      await service.delete("ag-q")

      expect(
        db.select().from(agents).where(eq(agents.id, "ag-q")).get()
      ).toBeUndefined()
      // The item went through the terminal funnel (terminalize → markDone)
      // instead of sticking running forever.
      expect(service.queue()?.list("evt-1")).toEqual([])
      await service.close()
    } finally {
      close()
    }
  })

  test("deleting a manual agent leaves queue items untouched", async () => {
    const { db, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const service = makeService(db, dir)
      seedAgent(db, {
        id: "ag-m",
        eventId: "evt-1",
        challengeId: "ch-1",
        status: "idle",
      })

      await service.delete("ag-m")

      expect(
        db.select().from(agents).where(eq(agents.id, "ag-m")).get()
      ).toBeUndefined()
      expect(service.queue()?.list("evt-1")).toEqual([])
      await service.close()
    } finally {
      close()
    }
  })
})
