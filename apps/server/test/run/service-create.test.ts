import { describe, expect, mock, test } from "bun:test"

import { eq } from "drizzle-orm"

import { agents } from "../../src/db/schema"
import type { HostAgentSession } from "../../src/run/host/host-session"
import {
  makeAgentService,
  statefulContainerManager,
  stubHostAgentSession,
  USER,
} from "../helpers"
import { refine } from "../support"

describe("agentService.spawn", () => {
  test("happy path: inserts the agent row, creates the tool-box container, provisions", async () => {
    const createHost = mock(async () =>
      stubHostAgentSession("sess-1", { hang: true })
    )
    const { manager, created } = statefulContainerManager()
    const h = makeAgentService({ containerManager: manager, createHost })
    try {
      const agent = await h.service.spawn(
        {
          eventId: "evt-1",
          challengeId: "ch-1",
        },
        USER
      )
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

      // Tool-box sandbox created (bound to the challenge workspace).
      expect(created).toHaveLength(1)
      const opts = refine<{
        image: string
        workingDir: string
        binds: string[]
        limits: { cpus: number; memoryMb: number; pidsLimit: number }
        tmpfsSize: string
        networkMode?: string
      }>(created[0])
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
        h.service.spawn({ eventId: "evt-1", challengeId: "ch-1" }, USER)
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

  test("failure after the session is mounted: settles through the runtime (no stranded session/runtime)", async () => {
    let hostCalls = 0
    let disposed = 0
    const createHost = mock(async () => {
      hostCalls += 1
      const stub = stubHostAgentSession(`sess-${hostCalls}`, { hang: true })
      if (hostCalls > 1) return stub
      // The first host fails on the send path (after prepare mounted it):
      // reading the streaming flag throws, which rejects the runtime send.
      const session = refine<HostAgentSession>({
        ...stub,
        dispose: async () => {
          disposed += 1
        },
      })
      Object.defineProperty(session.session, "isStreaming", {
        get() {
          throw new Error("send path boom")
        },
      })
      return session
    })
    const h = makeAgentService({ createHost })
    try {
      await expect(
        h.service.spawn({ eventId: "evt-1", challengeId: "ch-1" }, USER)
      ).rejects.toThrow("send path boom")

      const row = h.db.select().from(agents).all()[0]
      expect(row.status).toBe("failed")
      expect(row.error).toContain("send path boom")
      expect(row.completedAt).toBeNull()
      // The mounted session was disposed by the terminal settle.
      expect(disposed).toBe(1)

      // No runtime/session survived the failure: a message reopens the agent
      // (a fresh host session is built) instead of reusing the dead one.
      await h.service.sendMessage(row.id, { text: "ping" }, USER)
      expect(hostCalls).toBe(2)
      expect(disposed).toBe(1)
    } finally {
      await h.close()
    }
  })

  test("rejects when the challenge does not exist", async () => {
    const h = makeAgentService({ challenge: false })
    try {
      await expect(
        h.service.spawn({ eventId: "evt-1", challengeId: "missing" }, USER)
      ).rejects.toThrow("Challenge not found")
    } finally {
      await h.close()
    }
  })

  test("two spawns on the same challenge each get their own sandbox (per-agent containers)", async () => {
    const createHost = mock(async () =>
      stubHostAgentSession(undefined, { hang: true })
    )
    const { manager, created } = statefulContainerManager()
    const h = makeAgentService({ containerManager: manager, createHost })
    try {
      await h.service.spawn({ eventId: "evt-1", challengeId: "ch-1" }, USER)
      await h.service.spawn({ eventId: "evt-1", challengeId: "ch-1" }, USER)
      await h.service.close()

      // One sandbox per agent, both bound to the same challenge workspace.
      expect(created).toHaveLength(2)
      expect(createHost).toHaveBeenCalledTimes(2)
      const names = created.map((opts) => refine<{ name: string }>(opts).name)
      expect(new Set(names).size).toBe(2)
      for (const opts of created) {
        expect(refine<{ binds: string[] }>(opts).binds[0]).toMatch(
          /:\/workspace$/
        )
      }
    } finally {
      await h.close()
    }
  })
})
