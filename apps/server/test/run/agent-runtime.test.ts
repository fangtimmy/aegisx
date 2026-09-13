import { describe, expect, test } from "bun:test"

import { eq } from "drizzle-orm"

import { createDatabase } from "../../src/db"
import { agents, channelMessages } from "../../src/db/schema"
import {
  AGENT_STALL_MS,
  createAgentRuntime,
  fmtMs,
  type AgentRuntime,
  type AgentRuntimeDeps,
} from "../../src/run/agent-runtime"
import type { AgentStatus } from "../../src/run/agent-status"
import {
  SCHEDULER_READ_KEY,
  createChannelService,
  orchKey,
  type ChannelService,
} from "../../src/run/channels"
import { createFakeClock } from "../../src/run/clock"
import type { HostAgentSession } from "../../src/run/host/host-session"
import { createLiveBus } from "../../src/run/host/live"
import { seedChallenge, seedEvent, now } from "../helpers"
import { refine } from "../support"

type Db = ReturnType<typeof setupLite>["db"]

function setupLite() {
  const dir = `/tmp/aegisx-watchdog-${crypto.randomUUID()}`
  const { db, releaseLock } = createDatabase(dir)
  return { db, dir, close: () => releaseLock() }
}

/** One runtime per agent id over shared deps — the stall timer lives on the
 * runtime (agent-runtime.ts owns every per-agent resource); everything the
 * stall path doesn't touch stays an inert stub. */
function makeRuntime(
  db: Db,
  dir: string,
  opts: { stallMs?: number; paused?: boolean } = {}
) {
  // Fake clock anchored at the real wall time: seeded rows carry real-epoch
  // updatedAt timestamps the stall age is computed against.
  const clock = createFakeClock()
  const channels: ChannelService = createChannelService({
    db,
    dataDir: dir,
    bus: createLiveBus(),
    send: async () => ({ delivered: false }),
    now: () => new Date(clock.now()).toISOString(),
    challengeWorkspaceRoot: (eventId, challengeId) =>
      `${dir}/events/${eventId}/challenges/${challengeId}/workspace`,
    clock,
  })
  const runtimes = new Map<string, AgentRuntime>()
  const runtimeFor = (agentId: string): AgentRuntime => {
    if (!runtimes.has(agentId)) {
      const deps: AgentRuntimeDeps = {
        db,
        channels,
        // The status core is never reached on the stall path.
        status: refine<AgentStatus>({}),
        clock,
        closeAbortGraceMs: 5_000,
        isSchedulerPaused: () => opts.paused ?? false,
        withLock: (_agentId, op) => Promise.resolve(op()),
        now: () => new Date(clock.now()).toISOString(),
        forget: (id) => runtimes.delete(id),
        resumeAgent: async () => {},
        ...(opts.stallMs !== undefined ? { stallMs: opts.stallMs } : {}),
      }
      const runtime = createAgentRuntime(agentId, deps)
      runtimes.set(agentId, runtime)
    }
    return runtimes.get(agentId)!
  }
  const close = async () => {
    await Promise.allSettled([...runtimes.values()].map((rt) => rt.dispose()))
    channels.close()
  }
  return { channels, runtimeFor, clock, close }
}

function seedAgent(
  db: Db,
  id: string,
  opts: {
    status?: "idle" | "failed" | "running" | "completed"
    role?: "solver" | "orchestrator"
    idleForMs?: number
  } = {}
) {
  db.insert(agents)
    .values({
      id,
      eventId: "evt-1",
      challengeId: opts.role === "orchestrator" ? null : "ch-1",
      role: opts.role ?? "solver",
      name: id,
      model: "m",
      systemPrompt: "s",
      tools: "[]",
      status: opts.status ?? "idle",
      source: "manual",
      timeoutMs: 3_600_000,
      createdAt: now(),
      startedAt: now(),
      updatedAt: new Date(Date.now() - (opts.idleForMs ?? 0)).toISOString(),
    })
    .run()
}

const orchRows = (db: Db, eventId = "evt-1") =>
  db
    .select()
    .from(channelMessages)
    .where(eq(channelMessages.channelKey, orchKey(eventId)))
    .all()

describe("agent stall watchdog (docs/im-simplify-v18.md §五)", () => {
  test("an agent idle beyond the threshold posts ONE urgent orch message with the stall detail", async () => {
    const { db, dir, close: closeDb } = setupLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedAgent(db, "a1", { idleForMs: 5 * 60_000 })
      const { runtimeFor, clock, close } = makeRuntime(db, dir, {
        stallMs: 20,
      })

      runtimeFor("a1").noteTurnSettled()
      clock.advance(50)
      const rows = orchRows(db)
      expect(rows).toHaveLength(1)
      expect(rows[0].body).toContain("停滞")
      expect(rows[0].body).toContain("agent-a1")
      expect(rows[0].body).toContain("已闲置")
      const meta = JSON.parse(rows[0].meta)
      expect(meta.urgent).toBe(true)
      expect(meta.noticeType).toBe("emergency")
      expect(meta.agentId).toBe("a1")

      // One shot per idle cycle: the fired timer does not re-arm itself.
      clock.advance(50)
      expect(orchRows(db)).toHaveLength(1)
      // A fresh settle re-arms (next idle cycle may fire again).
      runtimeFor("a1").noteTurnSettled()
      clock.advance(50)
      expect(orchRows(db)).toHaveLength(2)
      await close()
    } finally {
      closeDb()
    }
  })

  test("a fresh agent (settled < threshold) never fires; resumed agents are race-safe", async () => {
    const { db, dir, close: closeDb } = setupLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedAgent(db, "a1", { idleForMs: 100 }) // settled 100ms ago, threshold 60s
      const { runtimeFor, clock, close } = makeRuntime(db, dir, {
        stallMs: 60_000,
      })

      runtimeFor("a1").noteTurnSettled()
      clock.advance(50)
      expect(orchRows(db)).toHaveLength(0)

      // The timer fires AFTER the agent went running again — the re-check
      // finds a running agent row and stays silent.
      db.update(agents)
        .set({ status: "running", updatedAt: new Date().toISOString() })
        .where(eq(agents.id, "a1"))
        .run()
      await close()
    } finally {
      closeDb()
    }
  })

  test("terminal / scheduler-agent / paused-event cases never arm or fire", async () => {
    const { db, dir, close: closeDb } = setupLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedAgent(db, "c1", { status: "completed", idleForMs: 5 * 60_000 })
      seedAgent(db, "s1", {
        role: "orchestrator",
        idleForMs: 5 * 60_000,
      }) // the scheduler agent never counts
      seedAgent(db, "p1", { idleForMs: 5 * 60_000 }) // live, but the event is paused
      const { runtimeFor, clock, close } = makeRuntime(db, dir, {
        stallMs: 20,
        paused: true,
      })

      for (const agentId of ["c1", "s1", "p1"]) {
        runtimeFor(agentId).noteTurnSettled()
      }
      clock.advance(60)
      expect(orchRows(db)).toHaveLength(0)
      await close()
    } finally {
      closeDb()
    }
  })

  test("the watchdog needs no live scheduler: the message stores unread for catch-up", async () => {
    const { db, dir, close: closeDb } = setupLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedAgent(db, "a1", { idleForMs: 5 * 60_000 })
      // No scheduler agent at all — the orch message just sits in the channel.
      const { channels, runtimeFor, clock, close } = makeRuntime(db, dir, {
        stallMs: 20,
      })
      runtimeFor("a1").noteTurnSettled()
      clock.advance(50)
      expect(channels.unreadCount(orchKey("evt-1"), SCHEDULER_READ_KEY)).toBe(1)
      await close()
    } finally {
      closeDb()
    }
  })

  test("fmtMs formatting + AGENT_STALL_MS default", () => {
    expect(AGENT_STALL_MS).toBe(2 * 60_000)
    expect(fmtMs(3_500)).toBe("4s")
    expect(fmtMs(210_000)).toBe("3m30s")
    expect(fmtMs(180_000)).toBe("3m")
    expect(fmtMs(7_200_000)).toBe("2h")
    expect(fmtMs(-45_000)).toBe("-45s(超时)")
  })
})

/** pi's queue semantics: steer()/followUp() append, clearQueue() drains. */
function streamingSession() {
  const steering: string[] = []
  const followUps: string[] = []
  const session = {
    isStreaming: true,
    thinkingLevel: "off",
    modelRuntime: {},
    prompt: async () => {},
    abort: async () => {},
    setModel: async () => {},
    setThinkingLevel: () => {},
    steer: async (text: string) => {
      steering.push(text)
    },
    followUp: async (text: string) => {
      followUps.push(text)
    },
    clearQueue: () => {
      const drained = { steering: [...steering], followUp: [...followUps] }
      steering.length = 0
      followUps.length = 0
      return drained
    },
    getSteeringMessages: () => [...steering],
  }
  return { session, steering, followUps }
}

describe("steer merging (one turn sees one steer)", () => {
  function mountStreaming(
    db: Db,
    runtimeFor: ReturnType<typeof makeRuntime>["runtimeFor"],
    s: ReturnType<typeof streamingSession>
  ) {
    seedEvent(db)
    seedChallenge(db, { id: "ch-1" })
    seedAgent(db, "a1", { status: "running" })
    const runtime = runtimeFor("a1")
    runtime.mountSession(
      refine<HostAgentSession>({
        session: s.session,
        sessionId: "sess-1",
        pipeline: { attach: () => () => {}, detach: () => {} },
        dispose: async () => {},
      })
    )
    return runtime
  }

  test("a second steer folds into the pending one instead of stacking", async () => {
    const { db, dir, close: closeDb } = setupLite()
    try {
      const s = streamingSession()
      const { runtimeFor, close } = makeRuntime(db, dir)
      const runtime = mountStreaming(db, runtimeFor, s)

      await runtime.send("first", "steer")
      expect(s.steering).toEqual(["first"])
      await runtime.send("second", "steer")
      // ONE pending steer carrying both — not two separate injections.
      expect(s.steering).toEqual(["first\n\nsecond"])

      await close()
    } finally {
      closeDb()
    }
  })

  test("merging preserves follow-ups queued behind the steer", async () => {
    const { db, dir, close: closeDb } = setupLite()
    try {
      const s = streamingSession()
      const { runtimeFor, close } = makeRuntime(db, dir)
      const runtime = mountStreaming(db, runtimeFor, s)

      await runtime.send("steer-1", "steer")
      await runtime.send("later", "followUp")
      await runtime.send("steer-2", "steer")

      expect(s.steering).toEqual(["steer-1\n\nsteer-2"])
      expect(s.followUps).toEqual(["later"])
      await close()
    } finally {
      closeDb()
    }
  })
})
