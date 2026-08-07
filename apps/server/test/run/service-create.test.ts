import { describe, expect, mock, test } from "bun:test"

import { eq } from "drizzle-orm"

import { agents, runs } from "../../src/db/schema"
import type { CreateRunInput } from "../../src/run/service"
import { createRunService } from "../../src/run/service"
import {
  flatSettings,
  makeProvider,
  seedChallenge,
  seedEvent,
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

function baseCreateInput(
  challengeId: string,
  provider: CreateRunInput["provider"]
) {
  return {
    challengeId,
    provider,
    modelId: "model-1",
    thinkingLevel: "off" as const,
    container: containerInput,
  }
}

describe("runService.create", () => {
  test("happy path: inserts run + main agent, creates the tool-box container, provisions", async () => {
    const { db, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const provider = makeProvider()
      const { manager, created } = stubContainerManager()
      const provision = mock(async () =>
        stubHostAgentSession("sess-1", { hang: true })
      )

      const runService = createRunService({
        db,
        dataDir: dir,
        containerManager: manager,
        // buildMainToolContext (the only platformService reader) never runs
        // with a stubbed provision; opaque internal type → cast.
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
        provisionSession: provision,
      })

      const run = await runService.create(
        baseCreateInput("ch-1", toConnection(provider))
      )
      await runService.close()

      // Run row
      expect(run.status).toBe("running")
      const row = db.select().from(runs).where(eq(runs.id, run.id)).get()
      expect(row).toBeDefined()
      expect(row?.challengeId).toBe("ch-1")
      expect(row?.modelId).toBe("gpt-4o-mini")
      expect(row?.image).toBe(containerInput.image)
      expect(row?.containerName).toBe(`aegisx-run-${run.id}`)

      // Main agent row
      const agent = db
        .select()
        .from(agents)
        .where(eq(agents.runId, run.id))
        .get()
      expect(agent?.role).toBe("main")
      expect(agent?.status).toBe("running")

      // Tool-box container created with the resolved config
      expect(created).toHaveLength(1)
      const opts = created[0] as {
        image: string
        workingDir: string
        binds: string[]
        limits: { cpus: number; memoryMb: number; pidsLimit: number }
        tmpfsSize: string
        networkMode?: string
      }
      expect(opts.image).toBe(containerInput.image)
      expect(opts.workingDir).toBe("/workspace")
      expect(opts.binds[0]).toMatch(/:\/workspace$/)
      expect(opts.limits).toEqual({
        cpus: containerInput.cpus,
        memoryMb: containerInput.memoryMb,
        pidsLimit: containerInput.pidsLimit,
      })
      expect(opts.tmpfsSize).toBe(containerInput.tmpfsSize)

      expect(provision).toHaveBeenCalledTimes(1)
    } finally {
      close()
    }
  })

  test("provision failure: run is closed, main agent failed, container reclaimed", async () => {
    const { db, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const provider = makeProvider()
      const { manager, created, killed } = stubContainerManager()
      const provision = mock(async () => {
        throw new Error("agent session boom")
      })

      const runService = createRunService({
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
        getSettings: flatSettings,
        provisionSession: provision,
      })

      await expect(
        runService.create(baseCreateInput("ch-1", toConnection(provider)))
      ).rejects.toThrow("agent session boom")
      await runService.close()

      // The run row exists but is closed with the failure recorded.
      const row = db.select().from(runs).all()[0]
      expect(row.status).toBe("closed")
      expect(row.error).toContain("agent session boom")

      // Main agent marked failed.
      const agent = db
        .select()
        .from(agents)
        .where(eq(agents.runId, row.id))
        .get()
      expect(agent?.status).toBe("failed")
      expect(agent?.error).toContain("agent session boom")

      // Container was created then terminated (SIGTERM) on cleanup.
      expect(created).toHaveLength(1)
      expect(killed).toContain(row.containerName)
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
      const runService = createRunService({
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
        getSettings: flatSettings,
        provisionSession: async () => stubHostAgentSession(),
      })
      await expect(
        runService.create(baseCreateInput("missing", toConnection(provider)))
      ).rejects.toThrow("Challenge not found")
      await runService.close()
    } finally {
      close()
    }
  })
})
