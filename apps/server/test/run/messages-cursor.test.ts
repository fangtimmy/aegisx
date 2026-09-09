import { describe, expect, mock, test } from "bun:test"

import { agents, sessionEntries, sessions } from "../../src/db/schema"
import { makeAgentService, stubHostAgentSession, now } from "../helpers"

/** A minimal service whose listMessages is the per-agent query under test. */
function makeService() {
  const h = makeAgentService({
    createHost: mock(async () => stubHostAgentSession()),
  })
  return { h, db: h.db, service: h.service }
}

let entryCounter = 0

/** Insert one user-message session entry (renderable kind). */
function insertMessage(
  db: ReturnType<typeof makeService>["db"],
  agentId: string,
  sessionId: string,
  seq: number
) {
  entryCounter += 1
  db.insert(sessionEntries)
    .values({
      id: `entry-${entryCounter}`,
      sessionId,
      agentId,
      seq,
      type: "message",
      data: JSON.stringify({
        type: "message",
        id: `m-${entryCounter}`,
        parentId: null,
        timestamp: new Date(1000 + entryCounter).toISOString(),
        message: {
          role: "user",
          timestamp: 1000 + entryCounter,
          content: [{ type: "text", text: `msg ${entryCounter}` }],
        },
      }),
      createdAt: now(),
    })
    .run()
}

function seedAgentWithSession(
  db: ReturnType<typeof makeService>["db"],
  id: string,
  sessionId: string
) {
  db.insert(agents)
    .values({
      id,
      eventId: "evt-1",
      challengeId: "ch-1",
      role: "solver",
      name: id,
      model: "aegisx-prov-1/gpt-4o-mini:off",
      systemPrompt: "sp",
      tools: "[]",
      status: "idle",
      sessionFile: sessionId,
      source: "manual",
      timeoutMs: 3_600_000,
      createdAt: now(),
      startedAt: now(),
      updatedAt: now(),
    })
    .run()
  db.insert(sessions)
    .values({ id: sessionId, agentId: id, cwd: "/workspace", createdAt: now() })
    .run()
}

describe("per-agent message cursor (v19)", () => {
  test("incremental pulls by per-session seq; agents never see each other", async () => {
    const made = makeService()
    try {
      const { db, service } = made
      seedAgentWithSession(db, "a-1", "sess-a")
      seedAgentWithSession(db, "a-2", "sess-b")

      // Interleaved writes across the two agents (seqs are per-session).
      insertMessage(db, "a-1", "sess-a", 1)
      insertMessage(db, "a-1", "sess-a", 2)
      insertMessage(db, "a-2", "sess-b", 1)
      insertMessage(db, "a-1", "sess-a", 3)
      insertMessage(db, "a-2", "sess-b", 2)

      const page1 = service.listMessages("a-1", {})
      expect(page1.items.map((i) => i.seq)).toEqual([1, 2, 3])
      expect(page1.nextAfter).toBe(3)

      // The incremental pull above the cursor: only the agent's own tail.
      insertMessage(db, "a-1", "sess-a", 4)
      const page2 = service.listMessages("a-1", {
        after: page1.nextAfter ?? 0,
      })
      expect(page2.items.map((i) => i.seq)).toEqual([4])

      // The other agent's messages are invisible (per-agent scope).
      const other = service.listMessages("a-2", {})
      expect(other.items.map((i) => i.seq)).toEqual([1, 2])

      // No session yet → empty list with the cursor preserved.
      expect(service.listMessages("ghost", { after: 7 }).items).toHaveLength(0)
    } finally {
      await made.h.close()
    }
  })

  test("sessionId override reads a non-active session", async () => {
    const made = makeService()
    try {
      const { db, service } = made
      seedAgentWithSession(db, "a-1", "sess-active")
      db.insert(sessions)
        .values({
          id: "sess-old",
          agentId: "a-1",
          cwd: "/workspace",
          createdAt: now(),
        })
        .run()
      insertMessage(db, "a-1", "sess-active", 1)
      insertMessage(db, "a-1", "sess-old", 1)

      const active = service.listMessages("a-1", {})
      expect(active.items).toHaveLength(1)
      const old = service.listMessages("a-1", { sessionId: "sess-old" })
      expect(old.items).toHaveLength(1)
      expect(old.nextAfter).toBe(1)
    } finally {
      await made.h.close()
    }
  })
})
