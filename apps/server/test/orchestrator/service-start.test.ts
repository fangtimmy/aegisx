import { describe, expect, mock, test } from "bun:test"

import { eq } from "drizzle-orm"

import { orchestrators } from "../../src/db/schema"
import { createOrchestratorService } from "../../src/orchestrator/service"
import {
  flatSettings,
  makeProvider,
  seedEvent,
  seedOrchestrator,
  setupDb,
  stubConfigStore,
  stubContainerManager,
  stubHostAgentSession,
} from "../helpers"

describe("orchestratorService.start", () => {
  test("creates the tool-box container (default bridge, no networkMode) and goes running", async () => {
    const { db, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedOrchestrator(db, "evt-1", { enabled: true, modelId: "model-1" })
      const provider = makeProvider()
      const { manager, created } = stubContainerManager()
      const createSession = mock(async () =>
        stubHostAgentSession("orch-sess", { hang: true })
      )

      const orch = createOrchestratorService({
        db,
        dataDir: dir,
        containerManager: manager,
        // runService is only referenced inside buildToolContext closures,
        // which start() builds but does not invoke.
        runService: {} as never,
        configStore: stubConfigStore([provider]),
        getSettings: flatSettings,
        createSession,
      })

      const detail = await orch.start("evt-1")
      await orch.close()

      expect(detail.orchestrator.status).toBe("running")
      expect(detail.orchestrator.modelId).toBe("model-1")

      // Row updated to running.
      const row = db
        .select()
        .from(orchestrators)
        .where(eq(orchestrators.eventId, "evt-1"))
        .get()
      expect(row?.status).toBe("running")

      // Tool-box container created; orchestrator uses the default bridge so
      // networkMode is not set on the create call.
      expect(created).toHaveLength(1)
      const opts = created[0] as { networkMode?: string; image: string }
      expect(opts.networkMode).toBeUndefined()
      expect(typeof opts.image).toBe("string")
      expect(opts.image.length).toBeGreaterThan(0)

      expect(createSession).toHaveBeenCalledTimes(1)
    } finally {
      close()
    }
  })

  test("refuses to start a disabled orchestrator", async () => {
    const { db, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedOrchestrator(db, "evt-1", { enabled: false, modelId: "model-1" })
      const { manager, created } = stubContainerManager()

      const orch = createOrchestratorService({
        db,
        dataDir: dir,
        containerManager: manager,
        runService: {} as never,
        configStore: stubConfigStore([makeProvider()]),
        getSettings: flatSettings,
        createSession: async () => stubHostAgentSession(),
      })

      await expect(orch.start("evt-1")).rejects.toThrow(/disabled/i)
      await orch.close()
      expect(created).toHaveLength(0)
    } finally {
      close()
    }
  })
})
