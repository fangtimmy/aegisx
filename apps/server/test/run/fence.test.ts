import { describe, expect, test } from "bun:test"

import { eq } from "drizzle-orm"

import {
  challengeRemote,
  challenges,
  runs,
  schedulerConfig,
} from "../../src/db/schema"
import { checkLaunchFence, maxConcurrentRunsSetting } from "../../src/run/fence"
import {
  flatSettings,
  seedChallenge,
  seedEvent,
  seedRun,
  setupDb,
  now,
} from "../helpers"

type Db = ReturnType<typeof setupDb>["db"]

/** Insert a target-capable, unsolved remote row for a challenge. */
function seedTarget(
  db: Db,
  challengeId: string,
  opts: {
    solved?: boolean
    targetSupported?: boolean
    targetIgnored?: boolean
  } = {}
) {
  db.insert(challengeRemote)
    .values({
      challengeId,
      eventId: db
        .select({ eventId: challenges.eventId })
        .from(challenges)
        .where(eq(challenges.id, challengeId))
        .get()!.eventId,
      sourceKey: "src",
      remoteId: `remote-${challengeId}`,
      available: true,
      solved: opts.solved ?? false,
      targetSupported: opts.targetSupported ?? true,
      targetIgnored: opts.targetIgnored ?? false,
      targetCount: 1,
      targetInfo: "[]",
      syncedAt: now(),
    })
    .run()
}

const challenge = (eventId: string, id: string) => ({
  scopeType: "challenge" as const,
  eventId,
  challengeId: id,
})

describe("launch fence", () => {
  test("admits when under the global cap; rejects at the cap", () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const settings = flatSettings()
      expect(maxConcurrentRunsSetting(settings)).toBe(4)

      // 3 running runs → 4th admitted.
      seedRun(db, { id: "r1", status: "running", challengeId: "ch-1" })
      seedRun(db, { id: "r2", status: "running", challengeId: "ch-1" })
      seedRun(db, { id: "r3", status: "running", challengeId: "ch-1" })
      expect(
        checkLaunchFence(db, settings, challenge("evt-1", "ch-1")).ok
      ).toBe(true)

      // 4 running → 5th rejected (global_capacity).
      seedRun(db, { id: "r4", status: "running", challengeId: "ch-1" })
      const decision = checkLaunchFence(
        db,
        settings,
        challenge("evt-1", "ch-1")
      )
      expect(decision.ok).toBe(false)
      if (!decision.ok) {
        expect(decision.code).toBe("global_capacity")
        expect(decision.message).toMatch(/Live container cap reached/)
      }
    } finally {
      close()
    }
  })

  test("idle runs count toward the live container cap (W4.1)", () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      // 4 idle runs (warm containers — still live, still consuming a slot) →
      // a new launch is REJECTED.
      for (let i = 1; i <= 4; i++) {
        seedRun(db, { id: `r${i}`, status: "idle", challengeId: "ch-1" })
      }
      const decision = checkLaunchFence(
        db,
        flatSettings(),
        challenge("evt-1", "ch-1")
      )
      expect(decision.ok).toBe(false)
      if (!decision.ok) expect(decision.code).toBe("global_capacity")
      // Closing one frees the slot.
      seedRun(db, { id: "r5", status: "closed", challengeId: "ch-1" })
      db.update(runs).set({ status: "closed" }).where(eq(runs.id, "r4")).run()
      expect(
        checkLaunchFence(db, flatSettings(), challenge("evt-1", "ch-1")).ok
      ).toBe(true)
    } finally {
      close()
    }
  })

  test("scheduler (event-scope) runs never count and are never blocked", () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      // An event-scope scheduler run is invisible to the fence.
      db.insert(runs)
        .values({
          id: "sched",
          scopeType: "event",
          eventId: "evt-1",
          challengeId: null,
          status: "running",
          model: "openai/gpt-4o-mini:off",
          image: "i",
          cpus: 1,
          memoryMb: 1,
          pidsLimit: 1,
          containerName: "c",
          workspacePath: "w",
          sessionDir: "s",
          source: "manual",
          createdAt: now(),
          updatedAt: now(),
        })
        .run()
      const decision = checkLaunchFence(db, flatSettings(), {
        scopeType: "event",
        eventId: "evt-1",
      })
      expect(decision.ok).toBe(true)
    } finally {
      close()
    }
  })

  test("per-event target slots: a second distinct target is rejected", () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-a", eventId: "evt-1" })
      seedChallenge(db, { id: "ch-b", eventId: "evt-1" })
      seedTarget(db, "ch-a")
      seedTarget(db, "ch-b")
      // One run attacking ch-a (default maxConcurrentTargets = 1).
      seedRun(db, { id: "ra", status: "running", challengeId: "ch-a" })
      const decision = checkLaunchFence(
        db,
        flatSettings(),
        challenge("evt-1", "ch-b")
      )
      expect(decision.ok).toBe(false)
      if (!decision.ok) expect(decision.code).toBe("target_slots")
    } finally {
      close()
    }
  })

  test("same target-capable challenge shares one slot (no new slot)", () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-a", eventId: "evt-1" })
      seedTarget(db, "ch-a")
      seedRun(db, { id: "ra", status: "running", challengeId: "ch-a" })
      // Another run on the SAME challenge reuses the slot.
      expect(
        checkLaunchFence(db, flatSettings(), challenge("evt-1", "ch-a")).ok
      ).toBe(true)
    } finally {
      close()
    }
  })

  test("an idle run on a target-capable challenge occupies its slot (W4.2)", () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-a", eventId: "evt-1" })
      seedChallenge(db, { id: "ch-b", eventId: "evt-1" })
      seedTarget(db, "ch-a")
      seedTarget(db, "ch-b")
      // An IDLE run attacking ch-a still holds the slot (its target is very
      // likely still running on the platform).
      seedRun(db, { id: "ra", status: "idle", challengeId: "ch-a" })
      const decision = checkLaunchFence(
        db,
        flatSettings(),
        challenge("evt-1", "ch-b")
      )
      expect(decision.ok).toBe(false)
      if (!decision.ok) expect(decision.code).toBe("target_slots")
    } finally {
      close()
    }
  })

  test("an ignored target-capable challenge occupies no slot", () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-a", eventId: "evt-1" })
      seedChallenge(db, { id: "ch-b", eventId: "evt-1" })
      seedTarget(db, "ch-a", { targetIgnored: true })
      seedTarget(db, "ch-b")
      seedRun(db, { id: "ra", status: "running", challengeId: "ch-a" })
      // ch-a's target is ignored → not under attack → ch-b may launch.
      expect(
        checkLaunchFence(db, flatSettings(), challenge("evt-1", "ch-b")).ok
      ).toBe(true)
    } finally {
      close()
    }
  })

  test("a solved target-capable challenge frees its slot", () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-a", eventId: "evt-1" })
      seedChallenge(db, { id: "ch-b", eventId: "evt-1" })
      seedTarget(db, "ch-a", { solved: true })
      seedTarget(db, "ch-b")
      seedRun(db, { id: "ra", status: "running", challengeId: "ch-a" })
      // ch-a is solved → not under attack → ch-b may launch.
      expect(
        checkLaunchFence(db, flatSettings(), challenge("evt-1", "ch-b")).ok
      ).toBe(true)
    } finally {
      close()
    }
  })

  test("scheduler_config.maxConcurrentTargets raises the per-event cap", () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-a", eventId: "evt-1" })
      seedChallenge(db, { id: "ch-b", eventId: "evt-1" })
      seedChallenge(db, { id: "ch-c", eventId: "evt-1" })
      seedTarget(db, "ch-a")
      seedTarget(db, "ch-b")
      seedTarget(db, "ch-c")
      db.insert(schedulerConfig)
        .values({
          eventId: "evt-1",
          modelId: null,
          instruction: "",
          maxConcurrentTargets: 2,
          createdAt: now(),
          updatedAt: now(),
        })
        .run()
      seedRun(db, { id: "ra", status: "running", challengeId: "ch-a" })
      seedRun(db, { id: "rb", status: "running", challengeId: "ch-b" })
      // 2/2 slots used → ch-c rejected.
      expect(
        checkLaunchFence(db, flatSettings(), challenge("evt-1", "ch-c")).ok
      ).toBe(false)
    } finally {
      close()
    }
  })
})
