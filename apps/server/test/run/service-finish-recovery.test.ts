import { describe, expect, mock, test } from "bun:test"

import { eq } from "drizzle-orm"

import { agents } from "../../src/db/schema"
import type { AgentHostInput } from "../../src/run/host/host"
import {
  makeAgentService,
  seedAgent,
  stubHostAgentSession,
  USER,
} from "../helpers"
import { refine } from "../support"

/** A service wired against a stub container/host (sessions hang so a reopened
 * agent stays deterministically `running`). */
function makeService() {
  const h = makeAgentService({
    createHost: mock(async () =>
      stubHostAgentSession("sess-1", { hang: true })
    ),
  })
  return { h, db: h.db, service: h.service }
}

describe("terminal lifecycle + pendingFinish (v19, no atomic flag)", () => {
  test("recoverOnBoot flips a running agent to idle; terminal states survive", async () => {
    const made = makeService()
    try {
      const { db, service } = made
      seedAgent(db, { id: "a-1", status: "running" })
      seedAgent(db, { id: "a-2", status: "completed" })
      await service.recoverOnBoot()
      expect(
        db.select().from(agents).where(eq(agents.id, "a-1")).get()!.status
      ).toBe("idle")
      expect(
        db.select().from(agents).where(eq(agents.id, "a-2")).get()!.status
      ).toBe("completed")
    } finally {
      await made.h.close()
    }
  })

  test("finishAgent is idempotent on an already-completed agent (no double teardown)", async () => {
    const made = makeService()
    try {
      const { service } = made
      const agent = await service.spawn(
        {
          eventId: "evt-1",
          challengeId: "ch-1",
        },
        USER
      )

      const first = await service.finishAgent(agent.id, "summary", "user", USER)
      expect(first.status).toBe("completed")
      expect(first.summary).toBe("summary")
      // A late finish_run on the same completed agent is a no-op return.
      const again = await service.finishAgent(agent.id, "second", "user", USER)
      expect(again.status).toBe("completed")
      expect(again.summary).toBe("summary")
    } finally {
      await made.h.close()
    }
  })

  test("finishAgent and closeAgent refuse a terminal agent (already closed)", async () => {
    const made = makeService()
    try {
      const { service } = made
      const agent = await service.spawn(
        {
          eventId: "evt-1",
          challengeId: "ch-1",
        },
        USER
      )
      const closed = await service.closeAgent(agent.id, USER)
      expect(closed.status).toBe("aborted")
      // A late close/finish on the aborted agent rejects.
      await expect(service.closeAgent(agent.id, USER)).rejects.toThrow(
        /already closed/
      )
      await expect(
        service.finishAgent(agent.id, "x", "user", USER)
      ).rejects.toThrow(/already closed/)
    } finally {
      await made.h.close()
    }
  })

  test("a reopen drops any stale pendingFinish intent (fresh finish available)", async () => {
    const made = makeService()
    try {
      const { service } = made
      const agent = await service.spawn(
        {
          eventId: "evt-1",
          challengeId: "ch-1",
        },
        USER
      )
      await service.closeAgent(agent.id, USER)
      // Reopen + finish: the completed transition works on the reopened agent
      // (pendingFinish was cleared at close; the reopen arms a fresh one).
      await service.sendMessage(agent.id, { text: "resume" }, USER)
      const finished = await service.finishAgent(
        agent.id,
        "final summary",
        "user",
        USER
      )
      expect(finished.status).toBe("completed")
      expect(finished.summary).toBe("final summary")
    } finally {
      await made.h.close()
    }
  })

  test("a finish_run self-settle forgets the agent's live-bus snapshots", async () => {
    // The stub turn executes finish_run (call 1 warns — no accepted flag
    // yet; call 2 sets the pendingFinish intent), then parks until the
    // test releases it so the settle lands deterministically after the
    // snapshot assertions below.
    let releaseTurn!: () => void
    const turnReleased = new Promise<void>((r) => (releaseTurn = r))
    const h = makeAgentService({
      createHost: mock(async (input: AgentHostInput) => {
        const finish = input.extraTools?.find(
          (tool) => tool.name === "finish_run"
        )
        if (!finish) throw new Error("finish_run tool missing")
        const execute = refine<{
          execute: (id: string, params: { summary: string }) => Promise<unknown>
        }>(finish).execute
        const stub = stubHostAgentSession("sess-finish")
        const sdk = refine<{ prompt: (text: string) => Promise<void> }>(
          stub.session
        )
        sdk.prompt = async () => {
          await execute("call", { summary: "first" })
          await execute("call", { summary: "solved it" })
          await turnReleased
        }
        return stub
      }),
    })
    try {
      const agent = await h.service.spawn(
        {
          eventId: "evt-1",
          challengeId: "ch-1",
        },
        USER
      )
      // Replay snapshots a freshly connected SSE tab would receive…
      h.service.bus.emit(agent.id, {
        type: "context.updated",
        agentId: agent.id,
        tokens: 1,
        contextWindow: 128_000,
        percent: 0,
        cacheHitRate: null,
        totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
      })
      h.service.bus.emit(agent.id, {
        type: "queue.updated",
        agentId: agent.id,
        steering: ["x"],
        followUp: [],
      })
      expect(h.service.bus.getContext(agent.id)).toBeDefined()
      expect(h.service.bus.getQueue(agent.id)).toBeDefined()
      releaseTurn()

      // …the self-settle lands completed with its summary AND the snapshots
      // are forgotten — a terminal agent leaves nothing on the live bus.
      await new Promise((r) => setTimeout(r, 20))
      const row = h.db
        .select()
        .from(agents)
        .where(eq(agents.id, agent.id))
        .get()!
      expect(row.status).toBe("completed")
      expect(row.summary).toBe("solved it")
      expect(h.service.bus.getContext(agent.id)).toBeUndefined()
      expect(h.service.bus.getQueue(agent.id)).toBeUndefined()
    } finally {
      await h.close()
    }
  })
})
