import { describe, expect, mock, test } from "bun:test"

import { eq } from "drizzle-orm"

import { agents, runs } from "../../src/db/schema"
import { createRunService } from "../../src/run/service"
import {
  flatSettingsWithDefaultModel,
  makeProvider,
  seedEvent,
  seedRun,
  setupDb,
  stubConfigStore,
  stubContainerManager,
  stubHostAgentSession,
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

function makeService(
  db: Db["db"],
  sqlite: Db["sqlite"],
  dir: string,
  provider: ReturnType<typeof makeProvider>,
  opts: { hang?: boolean; promptLog?: Map<string, string[]> } = {}
) {
  const { manager } = stubContainerManager()
  const hang = opts.hang ?? true
  const promptLog = opts.promptLog
  return createRunService({
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
      if (promptLog) {
        const list: string[] = []
        promptLog.set(input.agentId, list)
        const sdk = stub.session as unknown as {
          prompt: (text: string) => Promise<void>
        }
        sdk.prompt = async (text: string) => {
          list.push(text)
        }
      }
      return stub
    }),
  })
}

describe("multi-agent orchestration (service level)", () => {
  test("scheduler creates an event-scoped run with one orchestrator agent", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      const provider = makeProvider()
      const runService = makeService(db, sqlite, dir, provider)

      const run = await runService.create({
        scopeType: "event" as const,
        eventId: "evt-1",
        instruction: "",
        container: containerInput,
      })

      expect(run.scopeType).toBe("event")
      const rows = db
        .select()
        .from(agents)
        .where(eq(agents.runId, run.id))
        .all()
      expect(rows).toHaveLength(1)
      expect(rows[0]!.slot).toBe("orchestrator")
      expect(rows[0]!.role).toBe("orchestrator")
      expect(rows[0]!.isEntry).toBe(true)
      // SDK convergence: the orchestrator snapshot grants no management tools
      // (scheduler-python-sdk.md) — management goes through `aegisx` + bash.
      expect(JSON.parse(rows[0]!.tools)).toEqual([])
      await runService.close()
    } finally {
      close()
    }
  })

  test("scheduler start replaces a previous closed scheduler run (newSession)", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedRun(db, {
        id: "old-sched",
        scopeType: "event",
        eventId: "evt-1",
        challengeId: null,
        status: "closed",
      })
      const provider = makeProvider()
      const runService = makeService(db, sqlite, dir, provider)

      const run = await runService.create({
        scopeType: "event" as const,
        eventId: "evt-1",
        instruction: "",
        container: containerInput,
      })

      expect(run.id).not.toBe("old-sched")
      // The old closed row is gone; only the fresh scheduler run remains.
      const rows = db
        .select()
        .from(runs)
        .where(eq(runs.scopeType, "event"))
        .all()
      expect(rows).toHaveLength(1)
      expect(rows[0]!.id).toBe(run.id)
      await runService.close()
    } finally {
      close()
    }
  })

  test("scheduler start rejects when a live scheduler run exists", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedRun(db, {
        id: "live-sched",
        scopeType: "event",
        eventId: "evt-1",
        challengeId: null,
        status: "running",
      })
      const provider = makeProvider()
      const runService = makeService(db, sqlite, dir, provider)

      await expect(
        runService.create({
          scopeType: "event" as const,
          eventId: "evt-1",
          instruction: "",
          container: containerInput,
        })
      ).rejects.toThrow(/already active/)
      await runService.close()
    } finally {
      close()
    }
  })
})
