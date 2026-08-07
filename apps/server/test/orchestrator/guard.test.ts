import { describe, expect, test } from "bun:test"

import { sql } from "drizzle-orm"

import { challengeRemote } from "../../src/db/schema"
import {
  canLaunchRun,
  countRunningRuns,
  countTargetChallenges,
} from "../../src/orchestrator/guard"
import { seedChallenge, seedEvent, seedRun, setupDb } from "../helpers"

type Database = ReturnType<typeof import("../../src/db").createDatabase>["db"]

/** Mark a challenge as target-capable + unsolved (a live target instance). */
function markTargetCapable(db: Database, challengeId: string) {
  db.insert(challengeRemote)
    .values({
      challengeId,
      sourceKey: "src",
      remoteId: `remote-${challengeId}`,
      available: true,
      solved: false,
      targetSupported: true,
      targetIgnored: false,
      targetCount: 1,
      targetInfo: "[]",
      syncedAt: new Date("2025-01-01T00:00:00Z").toISOString(),
    })
    .onConflictDoUpdate({
      target: challengeRemote.challengeId,
      set: {
        available: sql`true`,
        targetSupported: sql`true`,
        targetIgnored: sql`false`,
      },
    })
    .run()
}

describe("orchestrator guard (corrected target model)", () => {
  test("countTargetChallenges counts distinct challenges, not runs", () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-a", eventId: "evt-1" })
      seedChallenge(db, { id: "ch-b", eventId: "evt-1" })
      markTargetCapable(db, "ch-a")
      markTargetCapable(db, "ch-b")
      // Three parallel runs on ch-a + one on ch-b → 2 distinct target challenges.
      seedRun(db, { id: "a1", challengeId: "ch-a", status: "running" })
      seedRun(db, { id: "a2", challengeId: "ch-a", status: "running" })
      seedRun(db, { id: "a3", challengeId: "ch-a", status: "running" })
      seedRun(db, { id: "b1", challengeId: "ch-b", status: "running" })
      seedRun(db, { id: "a-idle", challengeId: "ch-a", status: "idle" })
      expect(countTargetChallenges(db, "evt-1")).toBe(2)
    } finally {
      close()
    }
  })

  test("a second run on the same target-capable challenge does NOT consume a new slot", () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-a", eventId: "evt-1" })
      markTargetCapable(db, "ch-a")
      seedRun(db, { id: "a1", challengeId: "ch-a", status: "running" })
      // cap targets = 1, already at 1 distinct target challenge (ch-a)…
      const limits = {
        maxConcurrentRuns: 4,
        maxConcurrentTargets: 1,
      }
      // …but launching another run on ch-a shares the slot → allowed.
      const verdict = canLaunchRun(db, "evt-1", "ch-a", limits)
      expect(verdict.ok).toBe(true)
    } finally {
      close()
    }
  })

  test("a run on a NEW target-capable challenge is blocked when slots are full", () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-a", eventId: "evt-1" })
      seedChallenge(db, { id: "ch-b", eventId: "evt-1" })
      markTargetCapable(db, "ch-a")
      markTargetCapable(db, "ch-b")
      seedRun(db, { id: "a1", challengeId: "ch-a", status: "running" })
      const limits = {
        maxConcurrentRuns: 4,
        maxConcurrentTargets: 1,
      }
      const verdict = canLaunchRun(db, "evt-1", "ch-b", limits)
      expect(verdict.ok).toBe(false)
      expect(verdict.ok === false && verdict.reason).toMatch(
        /target slots full/i
      )
    } finally {
      close()
    }
  })

  test("global run cap still blocks regardless of target slots", () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-a", eventId: "evt-1" })
      seedChallenge(db, { id: "ch-b", eventId: "evt-1" })
      // Non-target challenges: 2 distinct, no target-slot pressure.
      seedRun(db, { id: "a1", challengeId: "ch-a", status: "running" })
      const limits = { maxConcurrentRuns: 1, maxConcurrentTargets: 8 }
      expect(canLaunchRun(db, "evt-1", "ch-b", limits).ok).toBe(false)
    } finally {
      close()
    }
  })

  test("countRunningRuns counts only running runs globally", () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-a", eventId: "evt-1" })
      seedRun(db, { id: "r1", challengeId: "ch-a", status: "running" })
      seedRun(db, { id: "r2", challengeId: "ch-a", status: "idle" })
      seedRun(db, { id: "r3", challengeId: "ch-a", status: "closed" })
      expect(countRunningRuns(db)).toBe(1)
    } finally {
      close()
    }
  })
})
