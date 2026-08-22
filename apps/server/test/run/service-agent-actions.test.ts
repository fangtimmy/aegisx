import { describe, expect, mock, test } from "bun:test"

import { eq } from "drizzle-orm"

import { agents, spawnQueue } from "../../src/db/schema"
import { builtinModelProfile } from "../../src/providers/builtin-models"
import { createAgentService } from "../../src/run/service"
import {
  flatSettingsWithDefaultModel,
  makeModel,
  makeProvider,
  seedChallenge,
  seedEvent,
  setupDb,
  stubConfigStore,
  stubContainerManager,
  stubHostAgentSession,
  TEST_MODEL_REF,
} from "../helpers"

/** Two-model provider so a per-agent switch to a *different* model is real
 * (both carry real pi-builtin metadata so the live runtime resolves them
 * offline). */
function twoModelProvider() {
  return makeProvider({
    models: [
      makeModel(),
      makeModel({
        id: "model-2",
        modelId: "gpt-4o",
        label: "Bigger Model",
        metadataSource: "pi:openai/gpt-4o",
      }),
    ],
  })
}

const MODEL_1_REF = `${TEST_MODEL_REF}:off`
const MODEL_2_REF = "aegisx-prov-1/gpt-4o:high"

/** Records host-session calls: which agents were prepared (createHost) and
 * which were aborted, and wires the real model runtime into the stub session
 * so applyModelSwitch can resolve pi models offline. */
function makeService(
  db: ReturnType<typeof setupDb>["db"],
  dir: string,
  providers: ReturnType<typeof makeProvider>[]
) {
  const { manager } = stubContainerManager()
  const prepared: string[] = []
  const aborted: string[] = []
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
    configStore: stubConfigStore(providers),
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

async function spawnAgent(
  service: ReturnType<typeof makeService>["service"],
  model = MODEL_1_REF
) {
  return service.spawn({ eventId: "evt-1", challengeId: "ch-1", model })
}

describe("per-agent actions (v19)", () => {
  test("sendMessage cold-reopens a terminal agent and drives a fresh turn", async () => {
    const { db, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const provider = twoModelProvider()
      const { service, prepared } = makeService(db, dir, [provider])

      const agent = await spawnAgent(service)
      expect(prepared).toHaveLength(1)

      // Warm agent: per-agent message drives the turn — no error.
      await service.sendMessage(agent.id, { text: "warm ping" })
      // Close the agent (session released, agent → aborted).
      const closed = await service.closeAgent(agent.id)
      expect(closed.status).toBe("aborted")

      // Cold reopen: messaging the same agent rebuilds its session (prepare)
      // and drives a fresh turn.
      const resumed = await service.sendMessage(agent.id, {
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

  test("switchAgentModel updates the named agent's own snapshot", async () => {
    const { db, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const provider = twoModelProvider()
      const { service } = makeService(db, dir, [provider])

      const agent = await spawnAgent(service)
      expect(
        db.select().from(agents).where(eq(agents.id, agent.id)).get()!.model
      ).toBe(MODEL_1_REF)

      const switched = await service.switchAgentModel(agent.id, {
        model: MODEL_2_REF,
      })
      expect(switched.id).toBe(agent.id)
      const row = db.select().from(agents).where(eq(agents.id, agent.id)).get()!
      expect(row.model).toBe(MODEL_2_REF)
      await service.close()
    } finally {
      close()
    }
  })

  test("stopAgent aborts the named agent's current turn", async () => {
    const { db, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const provider = twoModelProvider()
      const { service, aborted } = makeService(db, dir, [provider])

      const agent = await spawnAgent(service)
      expect(agent.status).toBe("running") // prime hangs → turn in flight

      const stopped = await service.stopAgent(agent.id)
      expect(stopped.id).toBe(agent.id)
      expect(aborted).toContain(agent.id)
      await service.close()
    } finally {
      close()
    }
  })

  test("haltChallenge closes the challenge's live agents + cancels its pending items, scoped to one challenge", async () => {
    const { db, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      seedChallenge(db, { id: "ch-2", eventId: "evt-1" })
      const provider = twoModelProvider()
      const { service } = makeService(db, dir, [provider])
      const queue = service.queue()

      const one = await spawnAgent(service)
      const two = await spawnAgent(service)
      const bystander = await service.spawn({
        eventId: "evt-1",
        challengeId: "ch-2",
        model: MODEL_1_REF,
      })
      // Paused queue → the enqueued item stays pending (no launch race).
      queue.pause("evt-1")
      const item = queue.enqueue({
        eventId: "evt-1",
        challengeId: "ch-1",
        source: "manual",
      })

      const result = await service.haltChallenge("ch-1")
      expect(result).toEqual({ closed: 2, cancelled: 1 })
      expect(
        db.select().from(agents).where(eq(agents.id, one.id)).get()!.status
      ).toBe("aborted")
      expect(
        db.select().from(agents).where(eq(agents.id, two.id)).get()!.status
      ).toBe("aborted")
      expect(
        db.select().from(agents).where(eq(agents.id, bystander.id)).get()!
          .status
      ).not.toBe("aborted")
      // queue.list() shows actionable items only — read the row directly.
      expect(
        db.select().from(spawnQueue).where(eq(spawnQueue.id, item.id)).get()!
          .status
      ).toBe("cancelled")
      await service.close()
    } finally {
      close()
    }
  })

  test("unknown agentId rejects with not_found on all three actions", async () => {
    const { db, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const provider = twoModelProvider()
      const { service } = makeService(db, dir, [provider])

      await expect(
        service.sendMessage("ghost", { text: "hi" })
      ).rejects.toThrow("Agent not found")
      await expect(
        service.switchAgentModel("ghost", { model: MODEL_2_REF })
      ).rejects.toThrow(/not found|no live session/)
      await expect(service.stopAgent("ghost")).rejects.toThrow(
        "Agent not found"
      )
      await service.close()
    } finally {
      close()
    }
  })

  test("switchAgentModel lazy-refreshes the workspace runtime for providers added while live", async () => {
    const { db, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const providers = [twoModelProvider()]
      const { service, prepared } = makeService(db, dir, providers)

      const agent = await spawnAgent(service)
      expect(prepared).toHaveLength(1)

      // Simulate adding a brand-new custom provider while the agent is live.
      providers.push({
        id: "prov-2",
        label: "New Provider",
        type: "openai-compatible",
        baseUrl: "https://new.example.com/v1",
        apiKey: "new-key",
        enabled: true,
        models: [
          {
            id: "model-3",
            modelId: "new-model",
            label: "New Model",
            enabled: true,
            metadata: JSON.stringify(
              builtinModelProfile("openai", "gpt-4o-mini")?.metadata ?? {}
            ),
            metadataSource: null,
          },
        ],
      })

      await service.switchAgentModel(agent.id, {
        model: "aegisx-prov-2/new-model:off",
      })
      const row = db.select().from(agents).where(eq(agents.id, agent.id)).get()!
      expect(row.model).toBe("aegisx-prov-2/new-model:off")
      await service.close()
    } finally {
      close()
    }
  })

  test("switchAgentModel persists the SDK-clamped thinking level", async () => {
    const { db, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const provider = twoModelProvider()
      const { manager } = stubContainerManager()
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
        createHost: mock(
          async (input: { agentId: string; modelRuntime: unknown }) => {
            const stub = stubHostAgentSession(
              "sess-" + input.agentId.slice(0, 6),
              { hang: true }
            )
            const sdk = stub.session as unknown as {
              modelRuntime: unknown
              thinkingLevel: string
              setThinkingLevel: (level: string) => void
              abort: () => Promise<void>
            }
            sdk.modelRuntime = input.modelRuntime
            sdk.thinkingLevel = "off"
            // Simulate the SDK clamping: high → medium on the target model.
            sdk.setThinkingLevel = (level: string) => {
              sdk.thinkingLevel = level === "high" ? "medium" : level
            }
            sdk.abort = async () => {}
            return stub
          }
        ),
      })

      const agent = await spawnAgent(service)
      await service.switchAgentModel(agent.id, { model: MODEL_2_REF })
      const row = db.select().from(agents).where(eq(agents.id, agent.id)).get()!
      expect(row.model).toBe("aegisx-prov-1/gpt-4o:medium")
      await service.close()
    } finally {
      close()
    }
  })

  test("switchAgentModel surfaces diagnosable resolution errors", async () => {
    const { db, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const provider = twoModelProvider()
      const { service } = makeService(db, dir, [provider])

      const agent = await spawnAgent(service)
      await expect(
        service.switchAgentModel(agent.id, { model: "garbage" })
      ).rejects.toThrow("Invalid model ref")
      await expect(
        service.switchAgentModel(agent.id, {
          model: "aegisx-prov-1/no-such:off",
        })
      ).rejects.toThrow("is unavailable")
      // alias refs no longer exist — they parse as an invalid ref.
      await expect(
        service.switchAgentModel(agent.id, { model: "alias:nope" })
      ).rejects.toThrow("Invalid model ref")
      await service.close()
    } finally {
      close()
    }
  })
})
