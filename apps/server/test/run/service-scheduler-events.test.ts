import { describe, expect, mock, test } from "bun:test"

import { eq } from "drizzle-orm"

import { agents } from "../../src/db/schema"
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

const MODEL = {
  provider: "Test Provider",
  modelId: "model-1",
  thinking: "off" as const,
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

describe("scheduler event wiring (spec §3.5)", () => {
  test("challenge run going idle wakes the scheduler's orchestrator", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const provider = makeProvider()
      // Record every prompt text per agent (prime + event wake-ups).
      const promptLog = new Map<string, string[]>()
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
        getSettings: flatSettings,
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

      const sched = await runService.create({
        scopeType: "event" as const,
        eventId: "evt-1",
        orchestration: "scheduler",
        params: { model: MODEL },
        instruction: "",
        provider: toConnection(provider),
        modelId: "model-1",
        thinkingLevel: "off",
        container: containerInput,
      })
      await settle()
      const orch = db
        .select()
        .from(agents)
        .where(eq(agents.runId, sched.id))
        .get()!

      // A challenge run in the same event: its prime settle flips it to idle,
      // which must wake the scheduler's orchestrator.
      const challenge = await runService.create({
        scopeType: "challenge" as const,
        challengeId: "ch-1",
        orchestration: "classic",
        provider: toConnection(provider),
        modelId: "model-1",
        thinkingLevel: "off",
        container: containerInput,
      })
      await settle()

      const texts = promptLog.get(orch.id) ?? []
      // First prompt = scheduler prime; second = the run.idle wake-up.
      expect(texts.length).toBeGreaterThanOrEqual(2)
      expect(texts[1]).toContain("Run ")
      expect(texts[1]).toContain(challenge.id)
      expect(texts[1]).toContain("idle")
      // The orchestrator's wake-up turn settled → scheduler run is idle again.
      expect(runService.get(sched.id)!.status).toBe("idle")
      await runService.close()
    } finally {
      close()
    }
  })

  test("accepted flag notifies the scheduler (run.flagAccepted)", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const provider = makeProvider()
      const promptLog = new Map<string, string[]>()
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
        getSettings: flatSettings,
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

      const sched = await runService.create({
        scopeType: "event" as const,
        eventId: "evt-1",
        orchestration: "scheduler",
        params: { model: MODEL },
        instruction: "",
        provider: toConnection(provider),
        modelId: "model-1",
        thinkingLevel: "off",
        container: containerInput,
      })
      await settle()
      const orch = db
        .select()
        .from(agents)
        .where(eq(agents.runId, sched.id))
        .get()!

      // A real challenge run in the same event (emitRunEvent requires the run
      // row to exist; it only forwards challenge-scoped runs to the scheduler).
      const challenge = await runService.create({
        scopeType: "challenge" as const,
        challengeId: "ch-1",
        orchestration: "classic",
        provider: toConnection(provider),
        modelId: "model-1",
        thinkingLevel: "off",
        container: containerInput,
      })
      await settle()

      runService.notifyFlagAccepted(challenge.id)
      await settle()

      const texts = promptLog.get(orch.id) ?? []
      expect(
        texts.some((t) => t.includes(challenge.id) && t.includes("flag"))
      ).toBe(true)
      await runService.close()
    } finally {
      close()
    }
  })
})
