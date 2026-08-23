import { describe, expect, mock, test } from "bun:test"

import { eq } from "drizzle-orm"

import type { AgentHostInput } from "../../src/agents/host"
import { agents } from "../../src/db/schema"
import { createAgentService } from "../../src/run/service"
import {
  flatSettingsWithDefaultModel,
  makeProvider,
  seedAgent,
  seedChallenge,
  seedEvent,
  setupDb,
  stubConfigStore,
  stubContainerManager,
  stubHostAgentSession,
  now,
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
  return refine<import("../../src/agents/host-session").HostAgentSession>({
    session,
    sessionId,
    pipeline: { attach: () => () => {}, detach: () => {} },
    dispose: async () => {},
  })
}

function makeService(
  db: ReturnType<typeof setupDb>["db"],
  dir: string,
  createHost: ReturnType<typeof mock>
) {
  const { manager } = stubContainerManager()
  return createAgentService({
    db,
    dataDir: dir,
    containerManager: manager,
    platformService: refine({
      submitFlag: async () => undefined,
      targetAction: async () => ({
        status: "running",
        endpoints: [],
        expiresAt: null,
      }),
    }),
    configStore: stubConfigStore([makeProvider()]),
    getSettings: flatSettingsWithDefaultModel,
    createHost,
  })
}

describe("agent lifecycle (v19)", () => {
  test("a hanging spawn lands the agent running; a flipping spawn settles idle", async () => {
    const { db, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const hanging = makeService(
        db,
        dir,
        mock(async () => stubHostAgentSession("sess-1", { hang: true }))
      )
      const agent = await hanging.spawn({
        eventId: "evt-1",
        challengeId: "ch-1",
      })
      expect(agent.status).toBe("running")
      expect(
        db.select().from(agents).where(eq(agents.id, agent.id)).get()!.status
      ).toBe("running")
      await hanging.close()

      const flipping = makeService(
        db,
        dir,
        mock(async () => stubHostFlipping("sess-1"))
      )
      const other = await flipping.spawn({
        eventId: "evt-1",
        challengeId: "ch-1",
      })
      await new Promise((r) => setTimeout(r, 5))
      expect(
        db.select().from(agents).where(eq(agents.id, other.id)).get()!.status
      ).toBe("idle")
      await flipping.close()
    } finally {
      close()
    }
  })

  test("finishAgent lands the agent completed + summary", async () => {
    const { db, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const service = makeService(
        db,
        dir,
        mock(async () => stubHostFlipping("sess-1"))
      )
      const agent = await service.spawn({
        eventId: "evt-1",
        challengeId: "ch-1",
      })
      await new Promise((r) => setTimeout(r, 5))
      const finished = await service.finishAgent(agent.id, "solved it")
      expect(finished.status).toBe("completed")
      const row = db.select().from(agents).where(eq(agents.id, agent.id)).get()
      expect(row?.status).toBe("completed")
      expect(row?.summary).toBe("solved it")
      expect(row?.completedAt).not.toBeNull()
      await service.close()
    } finally {
      close()
    }
  })

  test("recoverOnBoot flips a running agent to idle; terminal states survive", async () => {
    const { db, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      seedAgent(db, { id: "a-1", status: "running" })
      seedAgent(db, { id: "a-2", status: "completed" })
      const service = makeService(
        db,
        dir,
        mock(async () => stubHostAgentSession())
      )
      await service.recoverOnBoot()
      expect(
        db.select().from(agents).where(eq(agents.id, "a-1")).get()!.status
      ).toBe("idle")
      expect(
        db.select().from(agents).where(eq(agents.id, "a-2")).get()!.status
      ).toBe("completed")
      await service.close()
    } finally {
      close()
    }
  })

  test("reopen reuses the agent row's systemPrompt/model snapshot (no re-render)", async () => {
    const { db, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      seedAgent(db, {
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
      const captured: AgentHostInput[] = []
      const createHost = mock(async (input: AgentHostInput) => {
        captured.push(input)
        return stubHostFlipping(input.agentId)
      })
      const service = makeService(db, dir, createHost)

      // Messaging a terminal agent reopens it (onResume → resumeAgent), then
      // sends — the snapshot is reused verbatim, the edited prompt survives.
      await service.sendMessage("a-1", { text: "ping" })
      await new Promise((r) => setTimeout(r, 5))

      expect(captured).toHaveLength(1)
      expect(captured[0].agentId).toBe("a-1")
      expect(captured[0].systemPrompt).toBe("EDITED-SNAPSHOT-PROMPT")
      expect(
        db.select().from(agents).where(eq(agents.id, "a-1")).get()!.status
      ).toBe("idle")
      await service.close()
    } finally {
      close()
    }
  })
})
