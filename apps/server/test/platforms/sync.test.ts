import { describe, expect, test } from "bun:test"

import { and, eq } from "drizzle-orm"

import {
  challengeRemote,
  challenges,
  eventPlatforms,
} from "../../src/db/schema"
import { createStorage } from "../../src/infrastructure/storage"
import type {
  CtfPlatformAdapter,
  RemoteChallenge,
  RemoteChallengeSummary,
} from "../../src/platforms/core"
import { createPlatformSync } from "../../src/platforms/sync"
import { seedEvent, setupDb } from "../helpers"
import { refine } from "../support"

const SOURCE_KEY = '["fake","https://fake.example","task"]'

/** Minimal in-memory adapter: list/get only (sync's paths under test). */
function fakeAdapter(catalog: Map<string, RemoteChallengeSummary>) {
  const adapter = {
    listChallenges: async () => [...catalog.values()],
    getChallenge: async (remoteId: string): Promise<RemoteChallenge> => {
      const summary = catalog.get(remoteId)
      if (!summary) throw new Error(`unknown ${remoteId}`)
      return {
        ...summary,
        description: "desc",
        targetSupported: false,
        targetCount: 0,
        targets: [],
        attachments: [],
      }
    },
  }
  return refine<CtfPlatformAdapter>(adapter)
}

function makeSync(db: ReturnType<typeof setupDb>["db"], dir: string) {
  const adapters = new Map<string, CtfPlatformAdapter>()
  const platformSync = createPlatformSync(
    db,
    createStorage(dir),
    () => 1024 * 1024,
    (eventId) =>
      db
        .select()
        .from(eventPlatforms)
        .where(eq(eventPlatforms.eventId, eventId))
        .get(),
    (eventId) => adapters.get(eventId)
  )
  return { platformSync, adapters }
}

function bindPlatform(
  db: ReturnType<typeof setupDb>["db"],
  eventId: string,
  adapter: CtfPlatformAdapter,
  adapters: Map<string, CtfPlatformAdapter>
) {
  db.insert(eventPlatforms)
    .values({
      eventId,
      type: "ctfd",
      baseUrl: "https://fake.example",
      credential: "token",
      remoteEventId: "task",
      sourceKey: SOURCE_KEY,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .run()
  adapters.set(eventId, adapter)
}

describe("platform sync event scoping (0007)", () => {
  test("the same remote challenge imports into two events independently", async () => {
    const { db, dir, close } = setupDb()
    try {
      const catalog = new Map([
        [
          "c-01",
          {
            id: "c-01",
            name: "c-01",
            category: "hard",
            points: 500,
            solved: false,
          },
        ],
      ])
      seedEvent(db, "evt-1")
      seedEvent(db, "evt-2")
      const { platformSync, adapters } = makeSync(db, dir)
      bindPlatform(db, "evt-1", fakeAdapter(catalog), adapters)
      bindPlatform(db, "evt-2", fakeAdapter(catalog), adapters)

      const first = await platformSync.syncChallenges("evt-1", ["c-01"])
      expect(first.results[0].status).toBe("created")
      const second = await platformSync.syncChallenges("evt-2", ["c-01"])
      // Pre-0007 this failed on the global unique index and orphaned the
      // challenge row; now both events own an independent mapping.
      expect(second.results[0].status).toBe("created")

      const rows = db
        .select({
          name: challenges.name,
          eventId: challengeRemote.eventId,
        })
        .from(challenges)
        .innerJoin(
          challengeRemote,
          eq(challenges.id, challengeRemote.challengeId)
        )
        .all()
      expect(rows).toHaveLength(2)
      expect(new Set(rows.map((r) => r.eventId))).toEqual(
        new Set(["evt-1", "evt-2"])
      )
    } finally {
      close()
    }
  })

  test("re-sync updates the existing row instead of duplicating it", async () => {
    const { db, dir, close } = setupDb()
    try {
      const catalog = new Map([
        [
          "c-01",
          {
            id: "c-01",
            name: "c-01",
            category: "hard",
            points: 500,
            solved: false,
          },
        ],
      ])
      seedEvent(db, "evt-1")
      const { platformSync, adapters } = makeSync(db, dir)
      bindPlatform(db, "evt-1", fakeAdapter(catalog), adapters)

      await platformSync.syncChallenges("evt-1", ["c-01"])
      const again = await platformSync.syncChallenges("evt-1", ["c-01"])
      expect(again.results[0].status).toBe("updated")
      expect(db.select().from(challenges).all()).toHaveLength(1)
    } finally {
      close()
    }
  })

  test("availability flip is scoped to the syncing event", async () => {
    const { db, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedEvent(db, "evt-2")
      const full = new Map([
        [
          "c-01",
          {
            id: "c-01",
            name: "c-01",
            category: "hard",
            points: 500,
            solved: false,
          },
        ],
        [
          "c-02",
          {
            id: "c-02",
            name: "c-02",
            category: "easy",
            points: 100,
            solved: false,
          },
        ],
      ])
      const { platformSync, adapters } = makeSync(db, dir)
      bindPlatform(db, "evt-1", fakeAdapter(full), adapters)
      // evt-2 sees only c-01 — c-02 disappears for it.
      const shrunk = new Map([full.get("c-01")!].map((s) => [s.id, s]))
      bindPlatform(db, "evt-2", fakeAdapter(shrunk), adapters)

      await platformSync.syncChallenges("evt-1", ["c-01", "c-02"])
      await platformSync.syncChallenges("evt-2", ["c-01"])

      const availability = (eventId: string, remoteId: string) =>
        db
          .select({ available: challengeRemote.available })
          .from(challengeRemote)
          .where(
            and(
              eq(challengeRemote.eventId, eventId),
              eq(challengeRemote.remoteId, remoteId)
            )
          )
          .get()

      // evt-2's sync flipped ONLY its own rows: evt-1 keeps both available.
      expect(availability("evt-1", "c-01")?.available).toBe(true)
      expect(availability("evt-1", "c-02")?.available).toBe(true)
      // evt-2 never had c-02, and its own row is available.
      expect(availability("evt-2", "c-01")?.available).toBe(true)

      // Cross-check via the row count: evt-2's flip must not have touched
      // evt-1's c-02 (pre-0007 the global sourceKey update would have).
      const evt2rows = db
        .select()
        .from(challengeRemote)
        .where(eq(challengeRemote.eventId, "evt-2"))
        .all()
      expect(evt2rows).toHaveLength(1)
    } finally {
      close()
    }
  })
})
