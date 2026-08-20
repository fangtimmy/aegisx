import { describe, expect, test } from "bun:test"

import { eq } from "drizzle-orm"

import {
  agents,
  challengeRemote,
  challenges,
  schedulerConfig,
} from "../../src/db/schema"
import {
  checkSpawnFence,
  fenceSnapshot,
  maxConcurrentAgentsSetting,
} from "../../src/run/fence"
import {
  flatSettings,
  seedAgent,
  seedChallenge,
  seedEvent,
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

const candidate = (eventId: string, challengeId: string) => ({
  eventId,
  challengeId,
})

describe("spawn fence", () => {
  test("admits when under the global cap; rejects at the cap", () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const settings = flatSettings()
      expect(maxConcurrentAgentsSetting(settings)).toBe(4)

      // 3 live agents → 4th admitted.
      seedAgent(db, { id: "a1", challengeId: "ch-1", status: "running" })
      seedAgent(db, { id: "a2", challengeId: "ch-1", status: "running" })
      seedAgent(db, { id: "a3", challengeId: "ch-1", status: "running" })
      expect(checkSpawnFence(db, settings, candidate("evt-1", "ch-1")).ok).toBe(
        true
      )

      // 4 live → 5th rejected (global_capacity).
      seedAgent(db, { id: "a4", challengeId: "ch-1", status: "running" })
      const decision = checkSpawnFence(db, settings, candidate("evt-1", "ch-1"))
      expect(decision.ok).toBe(false)
      if (!decision.ok) {
        expect(decision.code).toBe("global_capacity")
        expect(decision.message).toMatch(/Live agent cap reached/)
      }
    } finally {
      close()
    }
  })

  test("idle agents count toward the live cap; terminal agents free their slot", () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      // 4 idle agents (warm sessions — still live, still consuming a slot) →
      // a new spawn is REJECTED.
      for (let i = 1; i <= 4; i++) {
        seedAgent(db, { id: `a${i}`, challengeId: "ch-1", status: "idle" })
      }
      const decision = checkSpawnFence(
        db,
        flatSettings(),
        candidate("evt-1", "ch-1")
      )
      expect(decision.ok).toBe(false)
      if (!decision.ok) expect(decision.code).toBe("global_capacity")
      // A terminal agent frees the slot.
      db.update(agents)
        .set({ status: "aborted" })
        .where(eq(agents.id, "a4"))
        .run()
      expect(
        checkSpawnFence(db, flatSettings(), candidate("evt-1", "ch-1")).ok
      ).toBe(true)
    } finally {
      close()
    }
  })

  test("the scheduler agent (orchestrator) never counts toward the cap", () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      seedAgent(db, {
        id: "sched",
        eventId: "evt-1",
        challengeId: null,
        role: "orchestrator",
        status: "running",
      })
      const decision = checkSpawnFence(
        db,
        flatSettings(),
        candidate("evt-1", "ch-1")
      )
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
      // One live agent attacking ch-a (default maxConcurrentTargets = 1).
      seedAgent(db, { id: "ra", challengeId: "ch-a", status: "running" })
      const decision = checkSpawnFence(
        db,
        flatSettings(),
        candidate("evt-1", "ch-b")
      )
      expect(decision.ok).toBe(false)
      if (!decision.ok) expect(decision.code).toBe("target_slots")
    } finally {
      close()
    }
  })

  test("agents on the same target-capable challenge share one slot", () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-a", eventId: "evt-1" })
      seedTarget(db, "ch-a")
      seedAgent(db, { id: "ra", challengeId: "ch-a", status: "running" })
      // Another agent on the SAME challenge reuses the slot.
      expect(
        checkSpawnFence(db, flatSettings(), candidate("evt-1", "ch-a")).ok
      ).toBe(true)
    } finally {
      close()
    }
  })

  test("an idle agent on a target-capable challenge occupies its slot", () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-a", eventId: "evt-1" })
      seedChallenge(db, { id: "ch-b", eventId: "evt-1" })
      seedTarget(db, "ch-a")
      seedTarget(db, "ch-b")
      // An IDLE agent attacking ch-a still holds the slot (its target is
      // very likely still running on the platform).
      seedAgent(db, { id: "ra", challengeId: "ch-a", status: "idle" })
      const decision = checkSpawnFence(
        db,
        flatSettings(),
        candidate("evt-1", "ch-b")
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
      seedAgent(db, { id: "ra", challengeId: "ch-a", status: "running" })
      // ch-a's target is ignored → not under attack → ch-b may spawn.
      expect(
        checkSpawnFence(db, flatSettings(), candidate("evt-1", "ch-b")).ok
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
      seedAgent(db, { id: "ra", challengeId: "ch-a", status: "running" })
      // ch-a is solved → not under attack → ch-b may spawn.
      expect(
        checkSpawnFence(db, flatSettings(), candidate("evt-1", "ch-b")).ok
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
      seedAgent(db, { id: "ra", challengeId: "ch-a", status: "running" })
      seedAgent(db, { id: "rb", challengeId: "ch-b", status: "running" })
      // 2/2 slots used → ch-c rejected.
      expect(
        checkSpawnFence(db, flatSettings(), candidate("evt-1", "ch-c")).ok
      ).toBe(false)
    } finally {
      close()
    }
  })

  test("drained: a solved challenge with a live agent holds its slot until its agents finish", () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-a", eventId: "evt-1" })
      seedChallenge(db, { id: "ch-b", eventId: "evt-1" })
      seedTarget(db, "ch-a", { solved: true })
      seedTarget(db, "ch-b")
      db.insert(schedulerConfig)
        .values({
          eventId: "evt-1",
          nextTaskPolicy: "drained",
          createdAt: now(),
          updatedAt: now(),
        })
        .run()
      seedAgent(db, { id: "ra", challengeId: "ch-a", status: "idle" })
      // ch-a solved but its agent is still wrapping up → slot held → ch-b
      // cannot launch (the eager default admits it in this exact setup).
      const decision = checkSpawnFence(
        db,
        flatSettings(),
        candidate("evt-1", "ch-b")
      )
      expect(decision.ok).toBe(false)
      if (!decision.ok) expect(decision.code).toBe("target_slots")
      // Last agent terminal → slot released → ch-b admitted.
      db.update(agents)
        .set({ status: "completed" })
        .where(eq(agents.id, "ra"))
        .run()
      expect(
        checkSpawnFence(db, flatSettings(), candidate("evt-1", "ch-b")).ok
      ).toBe(true)
    } finally {
      close()
    }
  })

  test("fenceSnapshot reports the event's nextTaskPolicy", () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-a", eventId: "evt-1" })
      const settings = flatSettings()
      expect(fenceSnapshot(db, settings, "evt-1").nextTaskPolicy).toBe("eager")
      db.insert(schedulerConfig)
        .values({
          eventId: "evt-1",
          nextTaskPolicy: "drained",
          createdAt: now(),
          updatedAt: now(),
        })
        .run()
      expect(fenceSnapshot(db, settings, "evt-1").nextTaskPolicy).toBe(
        "drained"
      )
    } finally {
      close()
    }
  })
})
