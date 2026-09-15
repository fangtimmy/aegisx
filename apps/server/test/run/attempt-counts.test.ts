import { describe, expect, test } from "bun:test"

import { createCatalogReader } from "../../src/events/catalog"
import { createAgentQueries } from "../../src/run/queries"
import { seedChallenge, seedEvent, setupDb } from "../helpers"
import { refine } from "../support"

type Db = ReturnType<typeof setupDb>["db"]

function seedAttempt(
  db: Db,
  overrides: {
    id: string
    queueItemId?: string | null
    status?: "idle" | "aborted"
    createdAt: string
  }
) {
  db.insert(require("../../src/db/schema").agents)
    .values({
      id: overrides.id,
      eventId: "evt-1",
      challengeId: "ch-1",
      role: "solver",
      name: `agent-${overrides.id.slice(0, 8)}`,
      model: "m",
      systemPrompt: "s",
      tools: "[]",
      status: overrides.status ?? "aborted",
      source: "scheduler",
      timeoutMs: 3_600_000,
      deadlineAt: null,
      createdAt: overrides.createdAt,
      startedAt: overrides.createdAt,
      updatedAt: overrides.createdAt,
      queueItemId: overrides.queueItemId ?? null,
    })
    .run()
}

describe("attempt counting collapses queue-item replays (real dispatches only)", () => {
  test("listAgents + challenge agentStatusCounts count one attempt per queue item, preferring the live representative", () => {
    const { db, dir, close } = setupDb()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      // Three rows sharing queue item q1 (ghost replays): two aborted, one
      // live. The NEWEST row (mid) is aborted — the LIVE one must represent.
      seedAttempt(db, {
        id: "g1-old",
        queueItemId: "q1",
        createdAt: "2025-01-01T00:00:00.000Z",
      })
      seedAttempt(db, {
        id: "g1-mid",
        queueItemId: "q1",
        createdAt: "2025-01-03T00:00:00.000Z",
      })
      seedAttempt(db, {
        id: "g1-live",
        queueItemId: "q1",
        status: "idle",
        createdAt: "2025-01-02T00:00:00.000Z",
      })
      // A direct spawn (agents.start / manual) is its own attempt.
      seedAttempt(db, {
        id: "direct",
        queueItemId: null,
        createdAt: "2025-01-04T00:00:00.000Z",
      })

      const queries = createAgentQueries({ db, dataDir: dir })
      const listed = queries.listAgents({ challengeId: "ch-1" })
      expect(listed.map((a) => a.id).toSorted()).toEqual(["direct", "g1-live"])

      const catalog = createCatalogReader(db, refine({}))
      const challenge = catalog.getChallenge("ch-1")!
      expect(challenge.agentCount).toBe(2)
      expect(challenge.agentStatusCounts).toEqual({ idle: 1, aborted: 1 })
    } finally {
      close()
    }
  })
})
