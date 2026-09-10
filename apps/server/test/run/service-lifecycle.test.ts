import { describe, expect, mock, test } from "bun:test"

import { eq } from "drizzle-orm"

import { agents } from "../../src/db/schema"
import type { AgentHostInput } from "../../src/run/host/host"
import {
  makeAgentService,
  now,
  seedAgent,
  setupDb,
  stubHostAgentSession,
  USER,
} from "../helpers"
import { refine } from "../support"

/** A stub host whose prompt resolves after a tick, and whose isStreaming flips
 * true while a turn is notionally in flight (so the service observes a running
 * → idle transition through the agent status). */
function stubHostFlipping(sessionId = "sess-1") {
  const session = {
    isStreaming: false,
    thinkingLevel: "off",
    modelRuntime: {},
    prompt: async () => {
      session.isStreaming = true
      await Promise.resolve()
      session.isStreaming = false
    },
    abort: async () => {
      session.isStreaming = false
    },
    setModel: async () => {},
    setThinkingLevel: () => {},
    steer: async () => {},
    followUp: async () => {},
    clearQueue: () => {},
  }
  return refine<import("../../src/run/host/host-session").HostAgentSession>({
    session,
    sessionId,
    pipeline: { attach: () => () => {}, detach: () => {} },
    dispose: async () => {},
  })
}

describe("agent lifecycle (v19)", () => {
  test("a hanging spawn lands the agent running; a flipping spawn settles idle", async () => {
    const store = setupDb()
    try {
      const hanging = makeAgentService({
        store,
        createHost: mock(async () =>
          stubHostAgentSession("sess-1", { hang: true })
        ),
      })
      const agent = await hanging.service.spawn(
        {
          eventId: "evt-1",
          challengeId: "ch-1",
        },
        USER
      )
      expect(agent.status).toBe("running")
      expect(
        store.db.select().from(agents).where(eq(agents.id, agent.id)).get()!
          .status
      ).toBe("running")
      await hanging.close()

      const flipping = makeAgentService({
        store,
        event: false,
        challenge: false,
        createHost: mock(async () => stubHostFlipping("sess-1")),
      })
      const other = await flipping.service.spawn(
        {
          eventId: "evt-1",
          challengeId: "ch-1",
        },
        USER
      )
      await new Promise((r) => setTimeout(r, 5))
      expect(
        store.db.select().from(agents).where(eq(agents.id, other.id)).get()!
          .status
      ).toBe("idle")
      await flipping.close()
    } finally {
      store.close()
    }
  })

  test("finishAgent lands the agent completed + summary", async () => {
    const h = makeAgentService({
      createHost: mock(async () => stubHostFlipping("sess-1")),
    })
    try {
      const agent = await h.service.spawn(
        {
          eventId: "evt-1",
          challengeId: "ch-1",
        },
        USER
      )
      await new Promise((r) => setTimeout(r, 5))
      const finished = await h.service.finishAgent(
        agent.id,
        "solved it",
        "user",
        USER
      )
      expect(finished.status).toBe("completed")
      const row = h.db
        .select()
        .from(agents)
        .where(eq(agents.id, agent.id))
        .get()
      expect(row?.status).toBe("completed")
      expect(row?.summary).toBe("solved it")
      expect(row?.completedAt).not.toBeNull()
    } finally {
      await h.close()
    }
  })

  test("recoverOnBoot flips a running agent to idle; terminal states survive", async () => {
    const h = makeAgentService({
      createHost: mock(async () => stubHostAgentSession()),
    })
    try {
      seedAgent(h.db, { id: "a-1", status: "running" })
      seedAgent(h.db, { id: "a-2", status: "completed" })
      await h.service.recoverOnBoot()
      expect(
        h.db.select().from(agents).where(eq(agents.id, "a-1")).get()!.status
      ).toBe("idle")
      expect(
        h.db.select().from(agents).where(eq(agents.id, "a-2")).get()!.status
      ).toBe("completed")
    } finally {
      await h.close()
    }
  })

  test("reopen reuses the agent row's systemPrompt/model snapshot (no re-render)", async () => {
    const captured: AgentHostInput[] = []
    const h = makeAgentService({
      createHost: mock(async (input: AgentHostInput) => {
        captured.push(input)
        return stubHostFlipping(input.agentId)
      }),
    })
    try {
      seedAgent(h.db, {
        id: "a-1",
        eventId: "evt-1",
        challengeId: "ch-1",
        model: "aegisx-prov-1/gpt-4o-mini:off",
        systemPrompt: "EDITED-SNAPSHOT-PROMPT",
        tools: JSON.stringify(["finish_run", "submit_flag"]),
        status: "completed",
        sessionFile: "sess-edited",
        createdAt: now(),
        updatedAt: now(),
      })

      // Messaging a terminal agent reopens it (onResume → resumeAgent), then
      // sends — the snapshot is reused verbatim, the edited prompt survives.
      await h.service.sendMessage("a-1", { text: "ping" }, USER)
      await new Promise((r) => setTimeout(r, 5))

      expect(captured).toHaveLength(1)
      expect(captured[0].agentId).toBe("a-1")
      expect(captured[0].systemPrompt).toBe("EDITED-SNAPSHOT-PROMPT")
      expect(
        h.db.select().from(agents).where(eq(agents.id, "a-1")).get()!.status
      ).toBe("idle")
    } finally {
      await h.close()
    }
  })
})

describe("closeAgent bounded abort (solve-time sibling stop regression)", () => {
  test("closeAgent lands aborted even when session.abort never resolves", async () => {
    const disposed: string[] = []
    const h = makeAgentService({
      closeAbortGraceMs: 10,
      createHost: mock(async () => {
        const stub = stubHostAgentSession("sess-1")
        const sdk = refine<{
          isStreaming: boolean
          abort: () => Promise<void>
        }>(stub.session)
        sdk.isStreaming = true
        sdk.abort = () => new Promise<void>(() => {})
        stub.dispose = async () => {
          disposed.push("sess-1")
        }
        return stub
      }),
    })
    try {
      // A mid-tool turn: isStreaming stays true and abort() never settles —
      // the exact state that used to hang closeAgent past the deadline
      // reaper (the tsecbench a-13/a-14 siblings ran to timeout despite the
      // "stopped" notice).
      const agent = await h.service.spawn(
        {
          eventId: "evt-1",
          challengeId: "ch-1",
        },
        USER
      )
      await new Promise((r) => setTimeout(r, 5))

      const closed = await h.service.closeAgent(agent.id, USER)
      expect(closed.status).toBe("aborted")
      expect(
        h.db.select().from(agents).where(eq(agents.id, agent.id)).get()!.status
      ).toBe("aborted")
      // The force half of the fallback: the streaming session is disposed.
      expect(disposed).toEqual(["sess-1"])
    } finally {
      await h.close()
    }
  })
})
