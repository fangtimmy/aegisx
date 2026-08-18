import { describe, expect, test } from "bun:test"

import { eq } from "drizzle-orm"

import { challengeFlags } from "../../src/db/schema"
import { createStorage } from "../../src/infrastructure/storage"
import { createPlatformService } from "../../src/platforms/service"
import {
  seedAgent,
  seedChallenge,
  seedEvent,
  setupDb,
  stubConfigStore,
} from "../helpers"

describe("platform flags → agent hook", () => {
  function makePlatform(db: ReturnType<typeof setupDb>["db"], dir: string) {
    const accepted: string[] = []
    const platform = createPlatformService(
      db,
      createStorage(dir),
      () => 1024 * 1024,
      stubConfigStore([])
    )
    platform.setAgentHooks({
      onAgentFlagAccepted: (_challengeId, agentId) => {
        if (agentId) accepted.push(agentId)
      },
    })
    return { platform, accepted }
  }

  test("non-platform accepted flag notifies the agent layer with agentId + source 'agent'", async () => {
    const { db, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      seedAgent(db, { id: "a-1", eventId: "evt-1", challengeId: "ch-1" })
      const { platform, accepted } = makePlatform(db, dir)

      const result = await platform.submitFlag("ch-1", "a-1", "flag{test}")
      expect(result.status).toBe("accepted")
      expect(accepted).toEqual(["a-1"])
      const row = db
        .select()
        .from(challengeFlags)
        .where(eq(challengeFlags.challengeId, "ch-1"))
        .get()!
      expect(row.agentId).toBe("a-1")
      expect(row.source).toBe("agent")
    } finally {
      close()
    }
  })

  test("repeat submission of an accepted flag notifies the submitting agent", async () => {
    const { db, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      seedAgent(db, { id: "a-1", eventId: "evt-1", challengeId: "ch-1" })
      seedAgent(db, { id: "a-2", eventId: "evt-1", challengeId: "ch-1" })
      const { platform, accepted } = makePlatform(db, dir)

      await platform.submitFlag("ch-1", "a-1", "flag{test}")
      // Terminal cache hit: already accepted, but the submitting agent must
      // still notify the scheduler (its own agent.flagAccepted).
      const second = await platform.submitFlag("ch-1", "a-2", "flag{test}")
      expect(second.status).toBe("accepted")
      expect(accepted).toEqual(["a-1", "a-2"])
    } finally {
      close()
    }
  })
})
