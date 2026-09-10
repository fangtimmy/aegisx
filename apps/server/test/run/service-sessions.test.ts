import { describe, expect, mock, test } from "bun:test"

import { eq } from "drizzle-orm"

import { agents, sessionEntries, sessions } from "../../src/db/schema"
import {
  makeAgentService,
  makeModel,
  makeProvider,
  stubHostAgentSession,
} from "../helpers"

/** Stub service: every createHost call records the prepared agent and returns
 * a stub session (no real pi / DbSessionManager). Session rows/entries are
 * seeded directly via the DB in the tests below. */
function makeService() {
  const prepared: string[] = []
  const h = makeAgentService({
    providers: [makeProvider({ models: [makeModel()] })],
    createHost: mock(
      async (input: {
        agentId: string
        resumeFrom?: { sessionId: string }
      }) => {
        prepared.push(input.agentId)
        // Honor the resume pointer like DbSessionManager.open would.
        const id =
          input.resumeFrom?.sessionId ?? "sess-" + input.agentId.slice(0, 6)
        return stubHostAgentSession(id)
      }
    ),
  })
  return { h, db: h.db, service: h.service, prepared }
}

/** A minimal message session_entries row (valid SessionEntry JSON). */
function entryData(role: string, text: string, id: string): string {
  return JSON.stringify({
    type: "message",
    id,
    parentId: null,
    timestamp: new Date().toISOString(),
    message: { role, content: text, timestamp: Date.now() },
  })
}

/** Seed one session for the agent with `n` entries (seq 1..n). */
function seedSession(
  db: ReturnType<typeof makeService>["db"],
  sessionId: string,
  agentId: string,
  n: number,
  createdAt = new Date().toISOString()
) {
  db.insert(sessions)
    .values({ id: sessionId, agentId, cwd: "/ws", createdAt })
    .run()
  for (let seq = 1; seq <= n; seq += 1) {
    db.insert(sessionEntries)
      .values({
        id: `${sessionId}-e${seq}`,
        sessionId,
        agentId,
        seq,
        type: "message",
        data: entryData(
          seq % 2 === 1 ? "user" : "assistant",
          `m${seq}`,
          `${sessionId}-e${seq}`
        ),
        createdAt: new Date().toISOString(),
      })
      .run()
  }
}

function remainingSeqs(
  db: ReturnType<typeof makeService>["db"],
  sessionId: string
): number[] {
  return db
    .select({ seq: sessionEntries.seq })
    .from(sessionEntries)
    .where(eq(sessionEntries.sessionId, sessionId))
    .orderBy(sessionEntries.seq)
    .all()
    .map((row) => row.seq)
}

async function spawnAgent(service: ReturnType<typeof makeService>["service"]) {
  return service.spawn({ eventId: "evt-1", challengeId: "ch-1" })
}

describe("multi-session + flat backtrack (v12)", () => {
  test("listAgentSessions returns sessions with counts + active flag", async () => {
    const made = makeService()
    try {
      const { db, service } = made
      const agent = await spawnAgent(service)

      seedSession(db, "sess-1", agent.id, 3, "2025-01-01T00:00:00.000Z")
      seedSession(db, "sess-2", agent.id, 1, "2025-01-01T00:00:01.000Z")
      db.update(agents)
        .set({ sessionFile: "sess-2" })
        .where(eq(agents.id, agent.id))
        .run()

      const list = service.listAgentSessions(agent.id)
      expect(list.map((s) => s.id)).toEqual(["sess-1", "sess-2"])
      expect(list[0]).toMatchObject({ messageCount: 3, isActive: false })
      expect(list[1]).toMatchObject({ messageCount: 1, isActive: true })
    } finally {
      await made.h.close()
    }
  })

  test("listMessages filters to the agent's active session", async () => {
    const made = makeService()
    try {
      const { db, service } = made
      const agent = await spawnAgent(service)

      seedSession(db, "sess-1", agent.id, 3)
      seedSession(db, "sess-2", agent.id, 2)
      db.update(agents)
        .set({ sessionFile: "sess-1" })
        .where(eq(agents.id, agent.id))
        .run()

      // Per-agent: only the active session's entries.
      const perAgent = service.listMessages(agent.id)
      expect(perAgent.items).toHaveLength(3)
      expect(perAgent.items.every((i) => i.entry.id.startsWith("sess-1"))).toBe(
        true
      )

      // Explicit session override can still reach the inactive session.
      const override = service.listMessages(agent.id, { sessionId: "sess-2" })
      expect(override.items).toHaveLength(2)
    } finally {
      await made.h.close()
    }
  })

  test("createAgentSession (/new) resets the pointer and rebuilds the live session", async () => {
    const made = makeService()
    try {
      const { db, service, prepared } = made
      const agent = await spawnAgent(service)
      expect(prepared).toHaveLength(1)

      const stubSessionId = "sess-" + agent.id.slice(0, 6)
      expect(
        db.select().from(agents).where(eq(agents.id, agent.id)).get()!
          .sessionFile
      ).toBe(stubSessionId)

      const result = await service.createAgentSession(agent.id)
      expect(result.id).toBe(agent.id)
      // The live session was disposed + re-prepared (pointer nulled first).
      expect(prepared).toHaveLength(2)
      const row = db.select().from(agents).where(eq(agents.id, agent.id)).get()!
      expect(row.sessionFile).toBe(stubSessionId) // fresh stub id written back
    } finally {
      await made.h.close()
    }
  })

  test("activateAgentSession switches the pointer and rebuilds; no-op when already active", async () => {
    const made = makeService()
    try {
      const { db, service, prepared } = made
      const agent = await spawnAgent(service)

      seedSession(db, "sess-1", agent.id, 1)
      seedSession(db, "sess-2", agent.id, 1)
      db.update(agents)
        .set({ sessionFile: "sess-1" })
        .where(eq(agents.id, agent.id))
        .run()

      // Activating the already-active live session is a no-op (no rebuild).
      await service.activateAgentSession(agent.id, "sess-1")
      expect(prepared).toHaveLength(1)

      await service.activateAgentSession(agent.id, "sess-2")
      expect(prepared).toHaveLength(2)
      expect(
        db.select().from(agents).where(eq(agents.id, agent.id)).get()!
          .sessionFile
      ).toBe("sess-2")

      // Foreign session ids are rejected.
      await expect(
        service.activateAgentSession(agent.id, "sess-ghost")
      ).rejects.toThrow("Session not found")
    } finally {
      await made.h.close()
    }
  })

  test("activating another session on a terminal agent reopens it (idle flip)", async () => {
    const made = makeService()
    try {
      const { db, service, prepared } = made
      const agent = await spawnAgent(service)

      seedSession(db, "sess-1", agent.id, 1)
      seedSession(db, "sess-2", agent.id, 1)
      const finished = await service.finishAgent(agent.id, "done")
      expect(finished.status).toBe("completed")

      // Switching sessions on a closed agent is a reopen: the live session
      // is rebuilt AND the status converges idle (same as a cold resume).
      const result = await service.activateAgentSession(agent.id, "sess-2")
      expect(prepared).toHaveLength(2)
      expect(result.status).toBe("idle")
      expect(
        db.select().from(agents).where(eq(agents.id, agent.id)).get()!.status
      ).toBe("idle")
    } finally {
      await made.h.close()
    }
  })

  test("backtrackAgent deletes entries after the target and rebuilds the live session", async () => {
    const made = makeService()
    try {
      const { db, service, prepared } = made
      const agent = await spawnAgent(service)

      seedSession(db, "sess-1", agent.id, 4)
      db.update(agents)
        .set({ sessionFile: "sess-1" })
        .where(eq(agents.id, agent.id))
        .run()

      await service.backtrackAgent(agent.id, 2)
      expect(remainingSeqs(db, "sess-1")).toEqual([1, 2])
      // Live session disposed + re-prepared from the truncated history.
      expect(prepared).toHaveLength(2)
      expect(
        db.select().from(agents).where(eq(agents.id, agent.id)).get()!
          .sessionFile
      ).toBe("sess-1")

      // Unknown target seq is rejected and changes nothing.
      await expect(service.backtrackAgent(agent.id, 99)).rejects.toThrow(
        "Target message not found"
      )
      expect(remainingSeqs(db, "sess-1")).toEqual([1, 2])
    } finally {
      await made.h.close()
    }
  })

  test("session ops reject unknown agents", async () => {
    const made = makeService()
    try {
      const { service } = made
      await spawnAgent(service)

      // listAgentSessions is synchronous (read-only query).
      expect(() => service.listAgentSessions("ghost")).toThrow(
        "Agent not found"
      )
      await expect(service.createAgentSession("ghost")).rejects.toThrow(
        "Agent not found"
      )
      await expect(
        service.activateAgentSession("ghost", "sess-1")
      ).rejects.toThrow(/not found/)
      await expect(service.backtrackAgent("ghost", 1)).rejects.toThrow(
        /not found|no session/
      )
    } finally {
      await made.h.close()
    }
  })
})
