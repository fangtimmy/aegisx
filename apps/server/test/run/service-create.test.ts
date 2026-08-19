import { describe, expect, mock, test } from "bun:test"

import { eq } from "drizzle-orm"

import { agents } from "../../src/db/schema"
import { createAgentService } from "../../src/run/service"
import {
  flatSettingsWithDefaultModel,
  makeProvider,
  seedChallenge,
  seedEvent,
  setupDb,
  stubConfigStore,
  stubContainerManager,
  stubHostAgentSession,
} from "../helpers"

describe("agentService.spawn", () => {
  test("happy path: inserts the agent row, creates the tool-box container, provisions", async () => {
    const { db, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const provider = makeProvider()
      const { manager, created } = stubContainerManager()
      const createHost = mock(async () =>
        stubHostAgentSession("sess-1", { hang: true })
      )

      const agentService = createAgentService({
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
        createHost,
      })

      const agent = await agentService.spawn({
        eventId: "evt-1",
        challengeId: "ch-1",
      })
      await agentService.close()

      // Agent row
      const row = db.select().from(agents).where(eq(agents.id, agent.id)).get()
      expect(row).toBeDefined()
      expect(row?.challengeId).toBe("ch-1")
      expect(row?.model).toBe("aegisx-prov-1/gpt-4o-mini:off")
      expect(row?.role).toBe("solver")
      expect(row?.status).toBe("running")
      expect(row?.systemPrompt).toBeTruthy()
      expect(row?.name).toBe(`agent-${agent.id.slice(0, 8)}`)

      // Tool-box container created (bound to the challenge workspace).
      expect(created).toHaveLength(1)
      const opts = created[0] as {
        image: string
        workingDir: string
        binds: string[]
        limits: { cpus: number; memoryMb: number; pidsLimit: number }
        tmpfsSize: string
        networkMode?: string
      }
      expect(opts.workingDir).toBe("/workspace")
      expect(opts.binds[0]).toMatch(/:\/workspace$/)
      expect(opts.limits).toEqual({
        cpus: 2,
        memoryMb: 2048,
        pidsLimit: 256,
      })
      expect(createHost).toHaveBeenCalledTimes(1)
    } finally {
      close()
    }
  })

  test("provision failure: agent row marked failed with the error recorded", async () => {
    const { db, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const provider = makeProvider()
      const { manager } = stubContainerManager()
      const createHost = mock(async () => {
        throw new Error("agent session boom")
      })

      const agentService = createAgentService({
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
        createHost,
      })

      await expect(
        agentService.spawn({ eventId: "evt-1", challengeId: "ch-1" })
      ).rejects.toThrow("agent session boom")
      await agentService.close()

      // The failed-attempt agent row survives with status failed + error.
      const row = db.select().from(agents).all()[0]
      expect(row.status).toBe("failed")
      expect(row.error).toContain("agent session boom")
    } finally {
      close()
    }
  })

  test("rejects when the challenge does not exist", async () => {
    const { db, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      const provider = makeProvider()
      const { manager } = stubContainerManager()
      const agentService = createAgentService({
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
        createHost: async () => stubHostAgentSession(),
      })
      await expect(
        agentService.spawn({ eventId: "evt-1", challengeId: "missing" })
      ).rejects.toThrow("Challenge not found")
      await agentService.close()
    } finally {
      close()
    }
  })

  test("two spawns on the same challenge share ONE container (never re-build it)", async () => {
    const { db, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const provider = makeProvider()
      const { manager, created } = stubContainerManager()
      const createHost = mock(async () =>
        stubHostAgentSession(undefined, { hang: true })
      )
      const agentService = createAgentService({
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
        createHost,
      })

      await agentService.spawn({ eventId: "evt-1", challengeId: "ch-1" })
      await agentService.spawn({ eventId: "evt-1", challengeId: "ch-1" })
      await agentService.close()

      // One container for the whole challenge; two agents share it.
      expect(created).toHaveLength(1)
      expect(createHost).toHaveBeenCalledTimes(2)
    } finally {
      close()
    }
  })
})
