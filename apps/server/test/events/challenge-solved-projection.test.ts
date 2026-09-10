import { describe, expect, test } from "bun:test"

import type { Database } from "../../src/db"
import {
  challengeFlags,
  challengeRemote,
  eventPlatforms,
} from "../../src/db/schema"
import { createCatalogReader } from "../../src/events/catalog"
import type { createPlatformService } from "../../src/platforms/service"
import { now, seedChallenge, seedEvent, setupDb } from "../helpers"
import { refine } from "../support"

type PlatformService = ReturnType<typeof createPlatformService>

/** A platform-integrated challenge (the `remoteId && available` shape the
 * fully-solved rule keys on): binding row + remote mirror. `flags` is the
 * challenge's `requiredFlags` — a multi-flag chain when > 1. */
function seedIntegrated(
  db: Database,
  opts: { solved: boolean; flags: number | null }
) {
  seedEvent(db, "evt-1")
  seedChallenge(db, {
    id: "ch-1",
    eventId: "evt-1",
    requiredFlags: opts.flags,
  })
  db.insert(eventPlatforms)
    .values({
      eventId: "evt-1",
      type: "tsecbench",
      baseUrl: "https://example.test",
      credential: "tok",
      remoteEventId: "remote-evt",
      sourceKey: "src-1",
      createdAt: now(),
      updatedAt: now(),
    })
    .run()
  db.insert(challengeRemote)
    .values({
      challengeId: "ch-1",
      eventId: "evt-1",
      sourceKey: "src-1",
      remoteId: "1789",
      available: true,
      solved: opts.solved,
      syncedAt: now(),
    })
    .run()
}

function seedAcceptedFlag(db: Database, flag: string) {
  db.insert(challengeFlags)
    .values({
      id: `f-${flag}`,
      challengeId: "ch-1",
      flag,
      status: "accepted",
      source: "agent",
      agentId: "a-1",
      remoteId: null,
      message: null,
      createdAt: now(),
      updatedAt: now(),
    })
    .run()
}

function catalogOf(db: Database) {
  return createCatalogReader(db, refine<PlatformService>({}))
}

describe("challenge solved projection", () => {
  test("integrated multi-flag partial reads partial, not solved", () => {
    const store = setupDb()
    try {
      // 1/6 flags accepted on the platform: the chain is NOT solved.
      seedIntegrated(store.db, { solved: false, flags: 6 })
      seedAcceptedFlag(store.db, "flag{one}")
      const challenge = catalogOf(store.db).getChallenge("ch-1")!
      expect(challenge.progress.state).toBe("partial")
      expect(challenge.progress.confirmed).toBe(1)
      expect(challenge.progress.required).toBe(6)
      expect(challenge.solved.local).toBe("partial")
      expect(challenge.solved.remote).toBe("unsolved")
      // The scheduler's planning predicate must not read this as done.
      expect(challenge.progress.state).not.toBe("solved")
    } finally {
      store.close()
    }
  })

  test("integrated chain completes when the platform verdict lands", () => {
    const store = setupDb()
    try {
      seedIntegrated(store.db, { solved: true, flags: 6 })
      seedAcceptedFlag(store.db, "flag{six}")
      const challenge = catalogOf(store.db).getChallenge("ch-1")!
      expect(challenge.progress.state).toBe("solved")
      expect(challenge.progress.source).toBe("remote")
      expect(challenge.solved.remote).toBe("solved")
      // The local record alone only proves the flags it collected — the
      // platform's verdict is what completes the chain.
      expect(challenge.solved.local).toBe("partial")
    } finally {
      store.close()
    }
  })

  test("non-integrated challenge: an accepted flag IS the local verdict", () => {
    const store = setupDb()
    try {
      seedEvent(store.db, "evt-1")
      seedChallenge(store.db, { id: "ch-1", eventId: "evt-1" })
      seedAcceptedFlag(store.db, "flag{only}")
      const challenge = catalogOf(store.db).getChallenge("ch-1")!
      expect(challenge.progress.state).toBe("solved")
      expect(challenge.solved.local).toBe("solved")
    } finally {
      store.close()
    }
  })

  test("an unknown multi-flag count cannot claim solved from the count", () => {
    const store = setupDb()
    try {
      // Integrated, one flag accepted, and the platform never reported how
      // many flags the challenge needs.
      seedIntegrated(store.db, { solved: false, flags: null })
      seedAcceptedFlag(store.db, "flag{one}")
      const challenge = catalogOf(store.db).getChallenge("ch-1")!
      expect(challenge.progress.state).toBe("partial")
    } finally {
      store.close()
    }
  })
})
