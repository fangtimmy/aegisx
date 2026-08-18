import { describe, expect, mock, test } from "bun:test"

import { eq } from "drizzle-orm"

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

/** A service wired against a stub container/host (sessions hang so a reopened
 * agent stays deterministically `running`). */
function makeService(db: ReturnType<typeof setupDb>["db"], dir: string) {
  const provider = makeProvider()
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
})
