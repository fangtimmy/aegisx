import { describe, expect, mock, test } from "bun:test"

import { and, eq } from "drizzle-orm"

import type { HostAgentSession } from "../../src/agents/host-session"
import { agents } from "../../src/db/schema"
import { orchKey } from "../../src/run/channels"
import { makeAgentService, seedAgent, stubHostAgentSession } from "../helpers"
import { refine } from "../support"

/**
 * A session that stays streaming (its prompt never settles) so the timeout
 * path sees a live agent. `abortResolves` selects the grace outcome:
 * true → abort clears streaming so the agent settles within the grace and
 * stays warm (`outcome: 'idle'`); false → abort is a no-op, the agent is
 * still streaming past the grace and gets force-disposed
 * (`outcome: 'aborted'` — the shared container is NEVER killed).
 */
function streamingSession(abortResolves: boolean): HostAgentSession {
  const session = {
    isStreaming: true,
    thinkingLevel: "off",
    modelRuntime: {},
    prompt: () => new Promise<void>(() => {}),
    abort: async () => {
      if (abortResolves) session.isStreaming = false
    },
    setModel: async () => {},
    setThinkingLevel: () => {},
    steer: async () => {},
    followUp: async () => {},
    clearQueue: () => {},
  }
  return refine<HostAgentSession>({
    session,
    sessionId: "sess-timeout",
    pipeline: { attach: () => () => {}, detach: () => {} },
    dispose: async () => {},
  })
}

/** A solver agent whose prime lands on a streaming (never-settling)
 * session, so the agent sits `running` at the deadline. */
async function createHangingAgent(abortResolves: boolean) {
  const h = makeAgentService({
    timeoutGraceMs: 40,
    createHost: mock(async () => streamingSession(abortResolves)),
  })
  const agent = await h.service.spawn({
    eventId: "evt-1",
    challengeId: "ch-1",
    timeoutMs: 30,
  })
  return { h, agent, killed: h.stubs.killed }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe("agent timeout", () => {
  test("deadline → abort → settle within grace → agent stays idle (warm), container kept", async () => {
    const { h, agent, killed } = await createHangingAgent(true)
    try {
      // deadline(30ms) fires → abort clears streaming → grace(40ms) sees
      // nothing streaming → outcome idle, no force-abort.
      await wait(150)

      const row = h.db
        .select()
        .from(agents)
        .where(eq(agents.id, agent.id))
        .get()!
      expect(row.lastTimeoutAt).toBeTruthy()
      // One-shot: the fire consumed the deadline (later turns/reopen stay
      // unbounded instead of re-arming a stale one).
      expect(row.deadlineAt).toBeNull()
      expect(row.status).toBe("idle")
      // Warm: the shared container is NEVER killed by a timeout.
      expect(killed).toEqual([])
    } finally {
      await h.close()
    }
  })

  test("deadline → still streaming past grace → session force-disposed → agent aborted; container NEVER killed", async () => {
    const { h, agent, killed } = await createHangingAgent(false)
    try {
      // A connected SSE tab's replay snapshots exist before the fire…
      h.service.bus.emit(agent.id, {
        type: "queue.updated",
        agentId: agent.id,
        steering: ["x"],
        followUp: [],
      })
      expect(h.service.bus.getQueue(agent.id)).toBeDefined()
      await wait(150)

      const row = h.db
        .select()
        .from(agents)
        .where(eq(agents.id, agent.id))
        .get()!
      expect(row.lastTimeoutAt).toBeTruthy()
      expect(row.deadlineAt).toBeNull()
      expect(row.status).toBe("aborted")
      // v19 red line: the agent is terminal, but the challenge's shared
      // container survives (only the idle sweep may reclaim it).
      expect(killed).toEqual([])
      // …and the force-abort settle forgot them (no terminal agent keeps
      // live-bus state around).
      expect(h.service.bus.getQueue(agent.id)).toBeUndefined()
    } finally {
      await h.close()
    }
  })

  test("a stale (past) deadlineAt is never armed on reopen — the new turn is not insta-aborted", async () => {
    let aborts = 0
    const h = makeAgentService({
      timeoutGraceMs: 40,
      // The reopened session's prompt resolves — the DM's turn settles idle
      // unless a stale deadline fires at delay 0 and aborts it.
      createHost: mock(async () => {
        const stub = stubHostAgentSession("sess-reopen")
        const session = refine<{
          abort: () => Promise<void>
        }>(stub.session)
        session.abort = async () => {
          aborts++
        }
        return stub
      }),
    })
    try {
      // Crash/boot leftover: an idle agent whose deadline passed while the
      // process was down (the fire never consumed it).
      const agentId = seedAgent(h.db, {
        id: "ag-stale",
        eventId: "evt-1",
        challengeId: "ch-1",
        deadlineAt: new Date(Date.now() - 60_000).toISOString(),
      })

      await h.service.sendMessage(agentId, { text: "hello" })
      await wait(150)

      expect(aborts).toBe(0)
      const row = h.db
        .select()
        .from(agents)
        .where(eq(agents.id, agentId))
        .get()!
      expect(row.lastTimeoutAt).toBeNull()
      expect(row.status).toBe("idle")
    } finally {
      await h.close()
    }
  })

  test("a deadline firing on an already-settled agent only consumes itself — no abort, no timedOut event", async () => {
    let aborts = 0
    const h = makeAgentService({
      timeoutGraceMs: 40,
      createHost: mock(async () => {
        const stub = stubHostAgentSession("sess-settled")
        const session = refine<{
          abort: () => Promise<void>
        }>(stub.session)
        session.abort = async () => {
          aborts++
        }
        return stub
      }),
    })
    try {
      // A terminal agent whose deadline lands shortly after the reopen: the
      // turn settles idle well before the fire.
      const agentId = seedAgent(h.db, {
        id: "ag-settled",
        eventId: "evt-1",
        challengeId: "ch-1",
        status: "completed",
        sessionFile: "sess-old",
        deadlineAt: new Date(Date.now() + 80).toISOString(),
      })

      await h.service.sendMessage(agentId, { text: "hello" })
      await wait(300)

      // The fire consumed the one-shot deadline…
      const row = h.db
        .select()
        .from(agents)
        .where(eq(agents.id, agentId))
        .get()!
      expect(row.lastTimeoutAt).toBeTruthy()
      expect(row.deadlineAt).toBeNull()
      // …but the settled turn was not aborted and no misleading
      // agent.timedOut reached the scheduler.
      expect(aborts).toBe(0)
      expect(row.status).toBe("idle")
      expect(
        h.service.channels
          .listMessages(orchKey("evt-1"))
          .items.some((m) => m.body.includes("超时"))
      ).toBe(false)
    } finally {
      await h.close()
    }
  })

  test("agent.timedOut wakes the event's scheduler with the outcome", async () => {
    const promptLog = new Map<string, string[]>()
    let hostCalls = 0
    const h = makeAgentService({
      timeoutGraceMs: 40,
      createHost: mock(async (input: { agentId: string }) => {
        hostCalls++
        if (hostCalls === 1) {
          const stub = stubHostAgentSession("sess-orch")
          const list: string[] = []
          promptLog.set(input.agentId, list)
          const sdk = refine<{
            prompt: (text: string) => Promise<void>
          }>(stub.session)
          sdk.prompt = async (text: string) => {
            list.push(text)
          }
          return stub
        }
        return streamingSession(false)
      }),
    })
    try {
      const sched = await h.service.startScheduler("evt-1")
      const orch = h.db
        .select()
        .from(agents)
        .where(and(eq(agents.id, sched.id), eq(agents.role, "orchestrator")))
        .get()!

      const challenge = await h.service.spawn({
        eventId: "evt-1",
        challengeId: "ch-1",
        timeoutMs: 30,
      })
      await wait(150)

      const texts = promptLog.get(orch.id) ?? []
      expect(
        texts.some((t) => t.includes("超时") && t.includes("已强制终止"))
      ).toBe(true)
      // P2 wire: the agent exposes its hard deadline.
      expect(challenge.deadlineAt).not.toBeNull()
      // The urgent orch message rides the timeline too.
      const orchPosts = h.service.channels.listMessages(orchKey("evt-1"))
      expect(orchPosts.items.some((m) => m.body.includes("超时"))).toBe(true)
    } finally {
      await h.close()
    }
  })
})
