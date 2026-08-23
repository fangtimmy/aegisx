import { describe, expect, test } from "bun:test"

import { eq } from "drizzle-orm"

import type { Database } from "../../src/db"
import {
  challengeFlags,
  challengeRemote,
  eventPlatforms,
} from "../../src/db/schema"
import { createStorage } from "../../src/infrastructure/storage"
import {
  type CtfPlatformAdapter,
  PlatformError,
} from "../../src/platforms/core"
import { createPlatformFlags } from "../../src/platforms/flags"
import { createPlatformService } from "../../src/platforms/service"
import {
  seedAgent,
  seedChallenge,
  seedEvent,
  setupDb,
  stubConfigStore,
} from "../helpers"
import { refine } from "../support"

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

describe("platform flags → agent hook", () => {
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

/** createPlatformFlags driven by a stub adapter — the async-judge path
 * (submit → pending + remoteId, poll → verdict) ret2shell/a1ctf use. */
function integratedFixture(db: ReturnType<typeof setupDb>["db"]) {
  const sourceKey = JSON.stringify(["stub", "https://ctf.example", "37"])
  db.insert(eventPlatforms)
    .values({
      eventId: "evt-1",
      type: "ret2shell",
      baseUrl: "https://ctf.example",
      credential: "tok",
      remoteEventId: "37",
      sourceKey,
      lastSyncedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .run()
  db.insert(challengeRemote)
    .values({
      challengeId: "ch-1",
      eventId: "evt-1",
      sourceKey,
      remoteId: "1365",
      available: true,
      solved: false,
      targetSupported: false,
      targetIgnored: false,
      targetCount: 0,
      targetInfo: "[]",
      syncedAt: new Date().toISOString(),
    })
    .run()
}

function flagRows(db: ReturnType<typeof setupDb>["db"]) {
  return db.select().from(challengeFlags).all()
}

function makeFlags(
  db: Database,
  adapter: Partial<CtfPlatformAdapter>,
  hooks: {
    onAgentFlagAccepted?: (
      challengeId: string,
      agentId?: string,
      outcome?: string
    ) => void
  } = {}
): ReturnType<typeof createPlatformFlags> {
  return createPlatformFlags(
    db,
    () =>
      db
        .select()
        .from(eventPlatforms)
        .where(eq(eventPlatforms.eventId, "evt-1"))
        .get(),
    () => refine<CtfPlatformAdapter>(adapter),
    hooks
  )
}

describe("platform flags → async judge + concurrent submissions", () => {
  test("acceptance outcomes: first solve, extra value on solved, repeat of accepted", async () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedAgent(db, { id: "a-1", challengeId: "ch-1" })
      seedAgent(db, { id: "a-2", challengeId: "ch-1" })
      integratedFixture(db)
      const outcomes: Array<[string | undefined, string | undefined]> = []
      const flags = makeFlags(
        db,
        {
          submitFlag: async (_rid, value) => ({
            status: "accepted",
            remoteId: `sub-${value}`,
          }),
        },
        {
          onAgentFlagAccepted: (_challengeId, agentId, outcome) =>
            outcomes.push([agentId, outcome]),
        }
      )

      await flags.submitFlag("ch-1", "a-1", "flag{one}")
      await flags.submitFlag("ch-1", "a-2", "flag{two}")
      await flags.submitFlag("ch-1", "a-2", "flag{one}")

      expect(outcomes).toEqual([
        ["a-1", "first"],
        ["a-2", "extra"],
        ["a-2", "repeat"],
      ])
    } finally {
      close()
    }
  })

  test("pending → polled accepted persists one row without UNIQUE crash", async () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedAgent(db, { id: "a-1", challengeId: "ch-1" })
      integratedFixture(db)
      const flags = makeFlags(db, {
        submitFlag: async () => ({ status: "pending", remoteId: "sub-1" }),
        getSubmission: async () => ({
          status: "accepted",
          remoteId: "sub-1",
          message: "Correct!",
        }),
      })

      const result = await flags.submitFlag("ch-1", "a-1", "flag{ok}")
      expect(result.status).toBe("accepted")
      const rows = flagRows(db)
      expect(rows).toHaveLength(1)
      expect(rows[0].status).toBe("accepted")
      expect(rows[0].remoteId).toBe("sub-1")
      expect(rows[0].message).toBe("Correct!")
    } finally {
      close()
    }
  })

  test("two agents racing the same flag both resolve, single row stays", async () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedAgent(db, { id: "a-1", challengeId: "ch-1" })
      seedAgent(db, { id: "a-2", challengeId: "ch-1" })
      integratedFixture(db)
      let calls = 0
      const flags = makeFlags(db, {
        submitFlag: async () => {
          calls += 1
          await new Promise((resolve) => setTimeout(resolve, 20))
          return { status: "pending", remoteId: `sub-${calls}` }
        },
        getSubmission: async () => ({
          status: "accepted",
          message: "Correct!",
        }),
      })

      const [first, second] = await Promise.all([
        flags.submitFlag("ch-1", "a-1", "flag{race}"),
        flags.submitFlag("ch-1", "a-2", "flag{race}"),
      ])
      expect(first.status).toBe("accepted")
      expect(second.status).toBe("accepted")
      const rows = flagRows(db)
      expect(rows).toHaveLength(1)
      expect(rows[0].status).toBe("accepted")
    } finally {
      close()
    }
  })

  test("a failed resubmission never downgrades a sibling's accepted row", async () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedAgent(db, { id: "a-1", challengeId: "ch-1" })
      integratedFixture(db)
      // While a-1's submission is in flight, the sibling agent lands the
      // accepted verdict; a-1's own request then fails — its error persist
      // must not downgrade the terminal row.
      const flags = makeFlags(db, {
        submitFlag: async () => {
          const now = new Date().toISOString()
          db.insert(challengeFlags)
            .values({
              id: "row-sibling",
              challengeId: "ch-1",
              flag: "flag{race}",
              status: "accepted",
              source: "agent",
              agentId: "a-2",
              remoteId: "sub-fast",
              message: "Correct!",
              createdAt: now,
              updatedAt: now,
            })
            .run()
          throw new PlatformError("network down", 502)
        },
      })

      await expect(
        flags.submitFlag("ch-1", "a-1", "flag{race}")
      ).rejects.toThrow("network down")
      const rows = flagRows(db)
      expect(rows).toHaveLength(1)
      expect(rows[0].status).toBe("accepted")
      expect(rows[0].agentId).toBe("a-2")
      expect(rows[0].message).toBe("Correct!")
    } finally {
      close()
    }
  })
})
