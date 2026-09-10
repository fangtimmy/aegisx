import { describe, expect, test } from "bun:test"

import { eq } from "drizzle-orm"

import type { Database } from "../../src/db"
import { challengeRemote, eventPlatforms } from "../../src/db/schema"
import type { CtfPlatformAdapter, TargetState } from "../../src/platforms/core"
import { createPlatformTargets } from "../../src/platforms/targets"
import { seedChallenge, seedEvent, setupDb } from "../helpers"
import { refine } from "../support"

const SOURCE_KEY = JSON.stringify(["stub", "https://ctf.example", "37"])

function seedPlatform(db: Database) {
  db.insert(eventPlatforms)
    .values({
      eventId: "evt-1",
      type: "ret2shell",
      baseUrl: "https://ctf.example",
      credential: "tok",
      remoteEventId: "37",
      sourceKey: SOURCE_KEY,
      lastSyncedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .run()
}

function seedTarget(db: Database, challengeId: string, remoteId: string) {
  db.insert(challengeRemote)
    .values({
      challengeId,
      eventId: "evt-1",
      sourceKey: SOURCE_KEY,
      remoteId,
      available: true,
      solved: false,
      targetSupported: true,
      targetIgnored: false,
      targetCount: 1,
      targetInfo: "[]",
      syncedAt: new Date().toISOString(),
    })
    .run()
}

function stubAdapter(states: Record<string, TargetState>, stopped: string[]) {
  return refine<CtfPlatformAdapter>({
    getTarget: async (remoteId: string) => {
      const state = states[remoteId]
      if (!state) throw new Error(`unknown target ${remoteId}`)
      return state
    },
    stopTarget: async (remoteId: string) => {
      stopped.push(remoteId)
      return { status: "absent", endpoints: [], expiresAt: null }
    },
  })
}

function makeTargets(db: Database, adapter: CtfPlatformAdapter) {
  return createPlatformTargets(
    db,
    () =>
      db
        .select()
        .from(eventPlatforms)
        .where(eq(eventPlatforms.eventId, "evt-1"))
        .get(),
    () => adapter
  )
}

const RUNNING: TargetState = {
  status: "running",
  endpoints: [{ name: "endpoint 1", address: "1.2.3.4:8080", protocol: "tcp" }],
  expiresAt: "2030-01-01T00:00:00.000Z",
}
const ABSENT: TargetState = { status: "absent", endpoints: [], expiresAt: null }

describe("event-wide target scan", () => {
  test("list returns one row per target-capable challenge", async () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1", name: "Web" })
      seedChallenge(db, { id: "ch-2", name: "Pwn" })
      // Not target-capable (no remote row) — must be excluded.
      seedChallenge(db, { id: "ch-3", name: "Misc" })
      seedPlatform(db)
      seedTarget(db, "ch-1", "101")
      seedTarget(db, "ch-2", "102")
      const targets = makeTargets(
        db,
        stubAdapter({ "101": RUNNING, "102": ABSENT }, [])
      )

      const rows = await targets.listEventTargets("evt-1")
      expect(rows).toHaveLength(2)
      const web = rows.find((row) => row.challengeId === "ch-1")
      expect(web).toEqual({
        challengeId: "ch-1",
        name: "Web",
        ok: true,
        status: "running",
        endpoints: RUNNING.endpoints,
        expiresAt: RUNNING.expiresAt,
        message: null,
      })
      const pwn = rows.find((row) => row.challengeId === "ch-2")
      expect(pwn).toEqual({
        challengeId: "ch-2",
        name: "Pwn",
        ok: true,
        status: "absent",
        endpoints: [],
        expiresAt: null,
        message: null,
      })
    } finally {
      close()
    }
  })

  test("a failing adapter get degrades to an error row, not a throw", async () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1", name: "Web" })
      seedPlatform(db)
      seedTarget(db, "ch-1", "101")
      const adapter = refine<CtfPlatformAdapter>({
        getTarget: async () => {
          throw new Error("platform 502")
        },
      })
      const rows = await makeTargets(db, adapter).listEventTargets("evt-1")
      expect(rows).toHaveLength(1)
      const row = rows[0]
      expect(row.challengeId).toBe("ch-1")
      expect(row.name).toBe("Web")
      expect(row.ok).toBe(false)
      if (!row.ok) expect(row.error.length).toBeGreaterThan(0)
    } finally {
      close()
    }
  })

  test("stop-all stops only active targets and reports per-row failures", async () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1", name: "Web" })
      seedChallenge(db, { id: "ch-2", name: "Pwn" })
      seedChallenge(db, { id: "ch-3", name: "Broken" })
      seedPlatform(db)
      seedTarget(db, "ch-1", "101")
      seedTarget(db, "ch-2", "102")
      seedTarget(db, "ch-3", "103")
      const stopped: string[] = []
      const adapter = refine<CtfPlatformAdapter>({
        getTarget: async (remoteId: string) => {
          if (remoteId === "103") throw new Error("platform down")
          return remoteId === "101" ? RUNNING : ABSENT
        },
        stopTarget: async (remoteId: string) => {
          if (remoteId === "101") throw new Error("stop rejected")
          stopped.push(remoteId)
          return ABSENT
        },
      })
      const result = await makeTargets(db, adapter).stopEventTargets("evt-1")
      // Absent targets cost no stop call; active-but-failing lands in failures.
      expect(stopped).toEqual([])
      expect(result.stopped).toBe(0)
      expect(result.failures).toHaveLength(2)
      expect(result.failures.map((f) => f.challengeId).toSorted()).toEqual([
        "ch-1",
        "ch-3",
      ])
      expect(result.failures.find((f) => f.challengeId === "ch-3")?.name).toBe(
        "Broken"
      )
    } finally {
      close()
    }
  })

  test("stop-all stops active targets and skips absent ones", async () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1", name: "Web" })
      seedChallenge(db, { id: "ch-2", name: "Pwn" })
      seedPlatform(db)
      seedTarget(db, "ch-1", "101")
      seedTarget(db, "ch-2", "102")
      const stopped: string[] = []
      const adapter = refine<CtfPlatformAdapter>({
        getTarget: async (remoteId: string) =>
          remoteId === "101" ? RUNNING : ABSENT,
        stopTarget: async (remoteId: string) => {
          stopped.push(remoteId)
          return ABSENT
        },
      })
      const result = await makeTargets(db, adapter).stopEventTargets("evt-1")
      expect(stopped).toEqual(["101"])
      expect(result).toEqual({ stopped: 1, failures: [] })
    } finally {
      close()
    }
  })
})
