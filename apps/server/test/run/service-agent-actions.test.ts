import { describe, expect, mock, test } from "bun:test"

import { eq } from "drizzle-orm"

import { agents } from "../../src/db/schema"
import type { CreateRunInput } from "../../src/run/service"
import { createRunService } from "../../src/run/service"
import {
  flatSettingsWithDefaultModel,
  makeProvider,
  seedChallenge,
  seedEvent,
  setupDb,
  stubConfigStore,
  stubContainerManager,
  stubHostAgentSession,
  TEST_MODEL_REF,
} from "../helpers"

const containerInput = {
  image: "aegisx/solve:latest",
  cpus: 2,
  memoryMb: 1024,
  pidsLimit: 128,
  tmpfsSize: "128m",
  workspace: "/workspace",
}

function baseCreateInput(challengeId: string): CreateRunInput {
  return {
    scopeType: "challenge" as const,
    challengeId,
    container: containerInput,
  }
}

/** Two-model provider so a per-agent switch to a *different* model is real
 * (both piBound so the live runtime resolves them offline). */
function twoModelProvider() {
  return makeProvider({
    models: [
      {
        id: "model-1",
        modelId: "gpt-4o-mini",
        label: "Test Model",
        enabled: true,
        metadata: "{}",
        piProviderId: "openai",
        piModelId: "gpt-4o-mini",
      },
      {
        id: "model-2",
        modelId: "gpt-4o",
        label: "Bigger Model",
        enabled: true,
        metadata: "{}",
        piProviderId: "openai",
        piModelId: "gpt-4o",
      },
    ],
  })
}

/** Canonical model refs for the two test models (pi-bound openai/*). */
const MODEL_1_REF = `${TEST_MODEL_REF}:off` // openai/gpt-4o-mini:off
const MODEL_2_REF = "openai/gpt-4o:high" // openai/gpt-4o:high

/** Records host-session calls: which agents were prepared (createHost) and
 * which were aborted, and wires the real run-level model runtime into the stub
 * session so applyModelSwitch can resolve pi models offline. */
function makeService(
  db: ReturnType<typeof setupDb>["db"],
  sqlite: ReturnType<typeof setupDb>["sqlite"],
  dir: string,
  provider: ReturnType<typeof makeProvider>
) {
  const { manager } = stubContainerManager()
  const prepared: string[] = []
  const aborted: string[] = []
  const service = createRunService({
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
    createHost: mock(
      async (input: { agentId: string; modelRuntime: unknown }) => {
        prepared.push(input.agentId)
        const stub = stubHostAgentSession("sess-" + input.agentId.slice(0, 6), {
          hang: true,
        })
        const sdk = stub.session as unknown as {
          modelRuntime: unknown
          thinkingLevel: string
          setThinkingLevel: (level: string) => void
          abort: () => Promise<void>
        }
        sdk.modelRuntime = input.modelRuntime
        sdk.thinkingLevel = "off"
        sdk.setThinkingLevel = (level: string) => {
          sdk.thinkingLevel = level
        }
        sdk.abort = async () => {
          aborted.push(input.agentId)
        }
        return stub
      }
    ),
  })
  return { service, prepared, aborted }
}

describe("per-agent actions (spec §10)", () => {
  test("sendAgentMessage cold-restores a closed run's agent and drives a fresh turn", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const provider = twoModelProvider()
      const { service, prepared } = makeService(db, sqlite, dir, provider)

      const run = await service.create(baseCreateInput("ch-1"))
      const [agent] = service.listAgents(run.id)
      expect(prepared).toHaveLength(1)

      // Warm run: per-agent message steers/follows-up (or drives) — no error.
      await service.sendAgentMessage(agent.id, { text: "warm ping" })
      // Close the run (container + sessions released, agents → idle).
      const closed = await service.closeRun(run.id)
      expect(closed.status).toBe("closed")

      // Cold restore: messaging the same agent rebuilds the run context +
      // session (fence → container → setup → prepare) and drives a fresh turn.
      const resumed = await service.sendAgentMessage(agent.id, {
        text: "cold ping",
      })
      expect(prepared).toHaveLength(2) // create + restore
      expect(resumed.status).toBe("running")
      const row = db.select().from(agents).where(eq(agents.id, agent.id)).get()!
      expect(row.status).toBe("running")
      await service.close()
    } finally {
      close()
    }
  })

  test("switchAgentModel updates the named agent's own snapshot (not just entry)", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const provider = twoModelProvider()
      const { service } = makeService(db, sqlite, dir, provider)

      const run = await service.create(baseCreateInput("ch-1"))
      const [agent] = service.listAgents(run.id)
      expect(
        db.select().from(agents).where(eq(agents.id, agent.id)).get()!.model
      ).toBe(MODEL_1_REF)

      const switched = await service.switchAgentModel(agent.id, {
        model: MODEL_2_REF,
      })
      expect(switched.id).toBe(run.id)
      const row = db.select().from(agents).where(eq(agents.id, agent.id)).get()!
      expect(row.model).toBe(MODEL_2_REF)
      await service.close()
    } finally {
      close()
    }
  })

  test("stopAgent aborts the named agent's current turn", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const provider = twoModelProvider()
      const { service, aborted } = makeService(db, sqlite, dir, provider)

      const run = await service.create(baseCreateInput("ch-1"))
      const [agent] = service.listAgents(run.id)
      expect(run.status).toBe("running") // prime hangs → turn in flight

      const stopped = await service.stopAgent(agent.id)
      expect(stopped.id).toBe(run.id)
      expect(aborted).toContain(agent.id)
      await service.close()
    } finally {
      close()
    }
  })

  test("unknown agentId rejects with not_found on all three actions", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const provider = twoModelProvider()
      const { service } = makeService(db, sqlite, dir, provider)

      await expect(
        service.sendAgentMessage("ghost", { text: "hi" })
      ).rejects.toThrow("Agent not found")
      await expect(
        service.switchAgentModel("ghost", { model: MODEL_2_REF })
      ).rejects.toThrow("Agent not found")
      await expect(service.stopAgent("ghost")).rejects.toThrow(
        "Agent not found"
      )
      await service.close()
    } finally {
      close()
    }
  })
})
