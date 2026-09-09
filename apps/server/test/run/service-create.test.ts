import { describe, expect, mock, test } from "bun:test"

import { eq } from "drizzle-orm"

import { agents } from "../../src/db/schema"
import { makeAgentService, stubHostAgentSession } from "../helpers"
import { refine } from "../support"

describe("agentService.spawn", () => {
  test("happy path: inserts the agent row, creates the tool-box container, provisions", async () => {
    const createHost = mock(async () =>
      stubHostAgentSession("sess-1", { hang: true })
    )
    const h = makeAgentService({ createHost })
    try {
      const agent = await h.service.spawn({
        eventId: "evt-1",
        challengeId: "ch-1",
      })
      await h.service.close()

      // Agent row
      const row = h.db
        .select()
        .from(agents)
        .where(eq(agents.id, agent.id))
        .get()
      expect(row).toBeDefined()
      expect(row?.challengeId).toBe("ch-1")
      expect(row?.model).toBe("aegisx-prov-1/gpt-4o-mini:off")
      expect(row?.role).toBe("solver")
      expect(row?.status).toBe("running")
      expect(row?.systemPrompt).toBeTruthy()
      expect(row?.name).toBe(`agent-${agent.id.slice(0, 8)}`)

      // Tool-box container created (bound to the challenge workspace).
      expect(h.stubs.created).toHaveLength(1)
      const opts = refine<{
        image: string
        workingDir: string
        binds: string[]
        limits: { cpus: number; memoryMb: number; pidsLimit: number }
        tmpfsSize: string
        networkMode?: string
      }>(h.stubs.created[0])
      expect(opts.workingDir).toBe("/workspace")
      expect(opts.binds[0]).toMatch(/:\/workspace$/)
      expect(opts.limits).toEqual({
        cpus: 2,
        memoryMb: 2048,
        pidsLimit: 256,
      })
      expect(createHost).toHaveBeenCalledTimes(1)
    } finally {
      await h.close()
    }
  })

  test("provision failure: agent row marked failed with the error recorded", async () => {
    const h = makeAgentService({
      createHost: mock(async () => {
        throw new Error("agent session boom")
      }),
    })
    try {
      await expect(
        h.service.spawn({ eventId: "evt-1", challengeId: "ch-1" })
      ).rejects.toThrow("agent session boom")
      await h.service.close()

      // The failed-attempt agent row survives with status failed + error.
      const row = h.db.select().from(agents).all()[0]
      expect(row.status).toBe("failed")
      expect(row.error).toContain("agent session boom")
    } finally {
      await h.close()
    }
  })

  test("rejects when the challenge does not exist", async () => {
    const h = makeAgentService({ challenge: false })
    try {
      await expect(
        h.service.spawn({ eventId: "evt-1", challengeId: "missing" })
      ).rejects.toThrow("Challenge not found")
    } finally {
      await h.close()
    }
  })

  test("two spawns on the same challenge share ONE container (never re-build it)", async () => {
    const createHost = mock(async () =>
      stubHostAgentSession(undefined, { hang: true })
    )
    const h = makeAgentService({ createHost })
    try {
      await h.service.spawn({ eventId: "evt-1", challengeId: "ch-1" })
      await h.service.spawn({ eventId: "evt-1", challengeId: "ch-1" })
      await h.service.close()

      // One container for the whole challenge; two agents share it.
      expect(h.stubs.created).toHaveLength(1)
      expect(createHost).toHaveBeenCalledTimes(2)
    } finally {
      await h.close()
    }
  })
})
