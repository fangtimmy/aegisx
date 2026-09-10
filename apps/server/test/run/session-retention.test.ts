import { describe, expect, test } from "bun:test"

import { eq } from "drizzle-orm"

import { sessionEntries, sessions } from "../../src/db/schema"
import { createFakeClock } from "../../src/run/clock"
import {
  SESSION_RETENTION_INTERVAL_MS,
  SESSION_RETENTION_MS,
  createSessionRetention,
} from "../../src/run/session-retention"
import { seedAgent, seedChallenge, seedEvent, setupDb } from "../helpers"
type Db = ReturnType<typeof setupDb>["db"]

const DAY = 24 * 60 * 60_000

function seedSession(
  db: Db,
  id: string,
  agentId: string,
  createdAt: string
): void {
  db.insert(sessions)
    .values({ id, agentId, cwd: "/workspace", createdAt })
    .run()
  db.insert(sessionEntries)
    .values({
      id: `entry-${id}`,
      sessionId: id,
      agentId,
      parentId: null,
      seq: 1,
      type: "message",
      data: "{}",
      meta: null,
      createdAt,
    })
    .run()
}

const sessionIds = (db: Db) =>
  db
    .select({ id: sessions.id })
    .from(sessions)
    .all()
    .map((row) => row.id)
    .toSorted()

const entryCount = (db: Db, sessionId: string) =>
  db
    .select()
    .from(sessionEntries)
    .where(eq(sessionEntries.sessionId, sessionId))
    .all().length

describe("session_entries retention", () => {
  test("deletes only terminal agents' non-active sessions outside the window", () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      const clock = createFakeClock()
      const old = new Date(clock.now() - 20 * DAY).toISOString()
      const inWindow = new Date(clock.now() - 1 * DAY).toISOString()

      // Live agent: old session stays.
      seedAgent(db, { id: "live", status: "idle" })
      seedSession(db, "s-live-old", "live", old)

      // Terminal agent with an old active session: stays.
      seedAgent(db, {
        id: "active",
        status: "completed",
        sessionFile: "s-active-old",
      })
      seedSession(db, "s-active-old", "active", old)

      // Terminal agent with a recent session: stays.
      seedAgent(db, { id: "recent", status: "failed", sessionFile: null })
      seedSession(db, "s-recent", "recent", inWindow)

      // Terminal agent with an old non-active session: pruned.
      seedAgent(db, {
        id: "stale",
        status: "aborted",
        sessionFile: "s-stale-active",
      })
      seedSession(db, "s-stale-active", "stale", old)
      seedSession(db, "s-stale-old", "stale", old)

      const retention = createSessionRetention({ db, clock })
      expect(retention.runOnce()).toBe(1)

      expect(sessionIds(db)).toEqual([
        "s-active-old",
        "s-live-old",
        "s-recent",
        "s-stale-active",
      ])
      expect(entryCount(db, "s-stale-old")).toBe(0)
      retention.close()
    } finally {
      close()
    }
  })

  test("batch cap bounds each pass (oldest first)", () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      const clock = createFakeClock()
      seedAgent(db, { id: "dead", status: "completed", sessionFile: null })
      for (let i = 1; i <= 5; i++) {
        seedSession(
          db,
          `s-${i}`,
          "dead",
          new Date(clock.now() - (30 - i) * DAY).toISOString()
        )
      }

      const retention = createSessionRetention({ db, clock, batchSize: 2 })
      expect(retention.runOnce()).toBe(2)
      expect(entryCount(db, "s-1")).toBe(0)
      expect(entryCount(db, "s-2")).toBe(0)
      expect(entryCount(db, "s-3")).toBe(1)
      expect(retention.runOnce()).toBe(2)
      expect(retention.runOnce()).toBe(1)
      expect(retention.runOnce()).toBe(0)
      retention.close()
    } finally {
      close()
    }
  })

  test("start() prunes at boot and on every interval", () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      const clock = createFakeClock()
      seedAgent(db, { id: "dead", status: "completed", sessionFile: null })
      seedSession(
        db,
        "s-boot",
        "dead",
        new Date(clock.now() - 20 * DAY).toISOString()
      )

      const retention = createSessionRetention({
        db,
        clock,
        intervalMs: 1_000,
      })
      retention.start()
      // Boot run: gone synchronously.
      expect(sessionIds(db)).toEqual([])

      seedSession(
        db,
        "s-tick",
        "dead",
        new Date(clock.now() - 20 * DAY).toISOString()
      )
      clock.advance(1_000)
      expect(sessionIds(db)).toEqual([])
      retention.close()
    } finally {
      close()
    }
  })

  test("window constants stay put", () => {
    expect(SESSION_RETENTION_MS).toBe(14 * DAY)
    expect(SESSION_RETENTION_INTERVAL_MS).toBe(6 * 60 * 60_000)
  })
})
