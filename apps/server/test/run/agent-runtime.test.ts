import { describe, expect, test } from "bun:test"

import { createDatabase } from "../../src/db"
import { agents } from "../../src/db/schema"
import { createChannelService } from "../../src/run/channels"
import { createFakeClock } from "../../src/run/clock"
import type { HostAgentSession } from "../../src/run/host/host-session"
import { createLiveBus } from "../../src/run/host/live"
import {
  createAgentRuntime,
  fmtMs,
  type AgentRuntime,
  type AgentRuntimeDeps,
} from "../../src/run/kernel/agent-runtime"
import type { AgentStatus } from "../../src/run/kernel/agent-status"
import { seedChallenge, seedEvent, now } from "../helpers"
import { refine } from "../support"

type Db = ReturnType<typeof setupLite>["db"]

function setupLite() {
  const dir = `/tmp/aegisx-runtime-${crypto.randomUUID()}`
  const { db, releaseLock } = createDatabase(dir)
  return { db, dir, close: () => releaseLock() }
}

/** One runtime per agent id over shared deps — everything the deadline/turn
 * paths don't touch stays an inert stub. */
function makeRuntime(db: Db, dir: string) {
  // Fake clock anchored at the real wall time: seeded rows carry real-epoch
  // timestamps.
  const clock = createFakeClock()
  const channels = createChannelService({
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
        // The status core is never reached on the paths under test.
        status: refine<AgentStatus>({}),
        clock,
        closeAbortGraceMs: 5_000,
        withLock: (_agentId, op) => Promise.resolve(op()),
        now: () => new Date(clock.now()).toISOString(),
        forget: (id) => runtimes.delete(id),
        destroySandbox: () => {},
        resumeAgent: async () => {},
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
  return { runtimeFor, clock, close }
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

describe("runtime time formatting", () => {
  test("fmtMs formatting (shared with the digest/notice lines and the SDK)", () => {
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
