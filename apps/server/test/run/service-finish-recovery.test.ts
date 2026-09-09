import { describe, expect, mock, test } from "bun:test"

import { eq } from "drizzle-orm"

import type { AgentHostInput } from "../../src/agents/host"
import { agents } from "../../src/db/schema"
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

/** A service wired against a stub container/host (sessions hang so a reopened
 * agent stays deterministically `running`). */
function makeService(db: ReturnType<typeof setupDb>["db"], dir: string) {
  const provider = makeProvider()
  const { manager } = stubContainerManager()
  const service = createAgentService({
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
    configStore: stubConfigStore([provider]),
    getSettings: flatSettingsWithDefaultModel,
    createHost: mock(async () =>
      stubHostAgentSession("sess-1", { hang: true })
    ),
  })
  return { service, manager }
}

describe("terminal lifecycle + pendingFinish (v19, no atomic flag)", () => {
  test("recoverOnBoot flips a running agent to idle; terminal states survive", async () => {
    const { db, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      seedAgent(db, { id: "a-1", status: "running" })
      seedAgent(db, { id: "a-2", status: "completed" })
      const { service } = makeService(db, dir)
      await service.recoverOnBoot()
      expect(
        db.select().from(agents).where(eq(agents.id, "a-1")).get()!.status
      ).toBe("idle")
      expect(
        db.select().from(agents).where(eq(agents.id, "a-2")).get()!.status
      ).toBe("completed")
      await service.close()
    } finally {
      close()
    }
  })

  test("finishAgent is idempotent on an already-completed agent (no double teardown)", async () => {
    const { db, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const { service } = makeService(db, dir)
      const agent = await service.spawn({
        eventId: "evt-1",
        challengeId: "ch-1",
      })

      const first = await service.finishAgent(agent.id, "summary")
      expect(first.status).toBe("completed")
      expect(first.summary).toBe("summary")
      // A late finish_run on the same completed agent is a no-op return.
      const again = await service.finishAgent(agent.id, "second")
      expect(again.status).toBe("completed")
      expect(again.summary).toBe("summary")
      await service.close()
    } finally {
      close()
    }
  })

  test("finishAgent and closeAgent refuse a terminal agent (already closed)", async () => {
    const { db, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const { service } = makeService(db, dir)
      const agent = await service.spawn({
        eventId: "evt-1",
        challengeId: "ch-1",
      })
      const closed = await service.closeAgent(agent.id)
      expect(closed.status).toBe("aborted")
      // A late close/finish on the aborted agent rejects.
      await expect(service.closeAgent(agent.id)).rejects.toThrow(
        /already closed/
      )
      await expect(service.finishAgent(agent.id, "x")).rejects.toThrow(
        /already closed/
      )
      await service.close()
    } finally {
      close()
    }
  })

  test("a reopen drops any stale pendingFinish intent (fresh finish available)", async () => {
    const { db, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const { service } = makeService(db, dir)
      const agent = await service.spawn({
        eventId: "evt-1",
        challengeId: "ch-1",
      })
      await service.closeAgent(agent.id)
      // Reopen + finish: the completed transition works on the reopened agent
      // (pendingFinish was cleared at close; the reopen arms a fresh one).
      await service.sendMessage(agent.id, { text: "resume" })
      const finished = await service.finishAgent(agent.id, "final summary")
      expect(finished.status).toBe("completed")
      expect(finished.summary).toBe("final summary")
      await service.close()
    } finally {
      close()
    }
  })

  test("a finish_run self-settle forgets the agent's live-bus snapshots", async () => {
    const { db, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const provider = makeProvider()
      const { manager } = stubContainerManager()
      // The stub turn executes finish_run (call 1 warns — no accepted flag
      // yet; call 2 sets the pendingFinish intent), then parks until the
      // test releases it so the settle lands deterministically after the
      // snapshot assertions below.
      let releaseTurn!: () => void
      const turnReleased = new Promise<void>((r) => (releaseTurn = r))
      const service = createAgentService({
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
        configStore: stubConfigStore([provider]),
        getSettings: flatSettingsWithDefaultModel,
        createHost: mock(async (input: AgentHostInput) => {
          const finish = input.extraTools?.find(
            (tool) => tool.name === "finish_run"
          )
          if (!finish) throw new Error("finish_run tool missing")
          const execute = refine<{
            execute: (
              id: string,
              params: { summary: string }
            ) => Promise<unknown>
          }>(finish).execute
          const stub = stubHostAgentSession("sess-finish")
          const sdk = refine<{ prompt: (text: string) => Promise<void> }>(
            stub.session
          )
          sdk.prompt = async () => {
            await execute("call", { summary: "first" })
            await execute("call", { summary: "solved it" })
            await turnReleased
          }
          return stub
        }),
      })
      const agent = await service.spawn({
        eventId: "evt-1",
        challengeId: "ch-1",
      })
      // Replay snapshots a freshly connected SSE tab would receive…
      service.bus.emit(agent.id, {
        type: "context.updated",
        agentId: agent.id,
        tokens: 1,
        contextWindow: 128_000,
        percent: 0,
        cacheHitRate: null,
        totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
      })
      service.bus.emit(agent.id, {
        type: "queue.updated",
        agentId: agent.id,
        steering: ["x"],
        followUp: [],
      })
      expect(service.bus.getContext(agent.id)).toBeDefined()
      expect(service.bus.getQueue(agent.id)).toBeDefined()
      releaseTurn()

      // …the self-settle lands completed with its summary AND the snapshots
      // are forgotten — a terminal agent leaves nothing on the live bus.
      await new Promise((r) => setTimeout(r, 20))
      const row = db.select().from(agents).where(eq(agents.id, agent.id)).get()!
      expect(row.status).toBe("completed")
      expect(row.summary).toBe("solved it")
      expect(service.bus.getContext(agent.id)).toBeUndefined()
      expect(service.bus.getQueue(agent.id)).toBeUndefined()
      await service.close()
    } finally {
      close()
    }
  })
})
