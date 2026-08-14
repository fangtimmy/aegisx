import { describe, expect, mock, test } from "bun:test"

import { and, eq, or } from "drizzle-orm"

import { listRenderableEntries } from "../../src/agents/session-queries"
import { agents, sessionEntries, sessions } from "../../src/db/schema"
import { createRunService } from "../../src/run/service"
import {
  flatSettingsWithDefaultModel,
  makeProvider,
  seedChallenge,
  seedEvent,
  seedRun,
  setupDb,
  stubConfigStore,
  stubContainerManager,
  stubHostAgentSession,
  now,
} from "../helpers"

/** A minimal service whose listMessages is the run-level query under test. */
function makeService(
  db: ReturnType<typeof setupDb>["db"],
  sqlite: ReturnType<typeof setupDb>["sqlite"],
  dir: string
) {
  const provider = makeProvider()
  const { manager } = stubContainerManager()
  return createRunService({
    db,
    sqlite,
    dataDir: dir,
    containerManager: manager,
    platformService: {
      submitFlag: async () => undefined,
      targetAction: async () => ({
        status: "running",
        endpoints: [],
        expiresAt: null,
      }),
    } as never,
    configStore: stubConfigStore([provider]),
    getSettings: flatSettingsWithDefaultModel,
    createHost: mock(async () => stubHostAgentSession()),
  })
}

let entryCounter = 0

/** Insert one user-message session entry (renderable kind). */
function insertMessage(
  db: ReturnType<typeof setupDb>["db"],
  runId: string,
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
      runId,
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

describe("run-level message cursor (code-review P2)", () => {
  test("incremental pulls across two interleaved sessions lose nothing", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      seedRun(db, { id: "run-1", status: "closed", challengeId: "ch-1" })
      db.insert(agents)
        .values([
          {
            id: "a-1",
            runId: "run-1",
            slot: "solver",
            role: "solver",
            isEntry: true,
            model: "openai/gpt-4o-mini:off",
            systemPrompt: "sp",
            tools: "[]",
            status: "idle",
            sessionFile: "sess-a",
            name: "A",
            createdAt: now(),
            updatedAt: now(),
          },
          {
            id: "a-2",
            runId: "run-1",
            slot: "observer",
            role: "observer",
            isEntry: false,
            model: "openai/gpt-4o-mini:off",
            systemPrompt: "sp",
            tools: "[]",
            status: "idle",
            sessionFile: "sess-b",
            name: "B",
            createdAt: now(),
            updatedAt: now(),
          },
        ])
        .run()
      db.insert(sessions)
        .values([
          { id: "sess-a", agentId: "a-1", cwd: "/workspace", createdAt: now() },
          { id: "sess-b", agentId: "a-2", cwd: "/workspace", createdAt: now() },
        ])
        .run()

      const service = makeService(db, sqlite, dir)

      // Interleaved writes: A 3, B 2, A 2 (insertion order = write order).
      insertMessage(db, "run-1", "a-1", "sess-a", 1)
      insertMessage(db, "run-1", "a-1", "sess-a", 2)
      insertMessage(db, "run-1", "a-1", "sess-a", 3)
      insertMessage(db, "run-1", "a-2", "sess-b", 1)
      insertMessage(db, "run-1", "a-2", "sess-b", 2)
      insertMessage(db, "run-1", "a-1", "sess-a", 4)
      insertMessage(db, "run-1", "a-1", "sess-a", 5)

      const page1 = service.listMessages("run-1", {})
      expect(page1.items).toHaveLength(7)
      // Write order, not seq order (seq would interleave B1,B2 between A3/A4).
      expect(page1.items.map((i) => i.agentId)).toEqual([
        "a-1",
        "a-1",
        "a-1",
        "a-2",
        "a-2",
        "a-1",
        "a-1",
      ])

      // B writes more afterwards (seqs 3,4 — below A's 4,5).
      insertMessage(db, "run-1", "a-2", "sess-b", 3)
      insertMessage(db, "run-1", "a-2", "sess-b", 4)

      const page2 = service.listMessages("run-1", {
        after: page1.nextAfter ?? 0,
      })
      expect(page2.items).toHaveLength(2)
      expect(page2.items.map((i) => i.agentId)).toEqual(["a-2", "a-2"])
      expect(page2.items.map((i) => i.seq)).toEqual([3, 4])
      await service.close()
    } finally {
      close()
    }
  })

  test("the old per-session seq cursor silently drops later entries (regression guard)", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      seedRun(db, { id: "run-1", status: "closed", challengeId: "ch-1" })
      db.insert(agents)
        .values([
          {
            id: "a-1",
            runId: "run-1",
            slot: "solver",
            role: "solver",
            isEntry: true,
            model: "openai/gpt-4o-mini:off",
            systemPrompt: "sp",
            tools: "[]",
            status: "idle",
            sessionFile: "sess-a",
            name: "A",
            createdAt: now(),
            updatedAt: now(),
          },
          {
            id: "a-2",
            runId: "run-1",
            slot: "observer",
            role: "observer",
            isEntry: false,
            model: "openai/gpt-4o-mini:off",
            systemPrompt: "sp",
            tools: "[]",
            status: "idle",
            sessionFile: "sess-b",
            name: "B",
            createdAt: now(),
            updatedAt: now(),
          },
        ])
        .run()
      db.insert(sessions)
        .values([
          { id: "sess-a", agentId: "a-1", cwd: "/workspace", createdAt: now() },
          { id: "sess-b", agentId: "a-2", cwd: "/workspace", createdAt: now() },
        ])
        .run()

      const service = makeService(db, sqlite, dir)
      insertMessage(db, "run-1", "a-1", "sess-a", 1)
      insertMessage(db, "run-1", "a-1", "sess-a", 2)
      insertMessage(db, "run-1", "a-1", "sess-a", 3)
      insertMessage(db, "run-1", "a-2", "sess-b", 1)
      insertMessage(db, "run-1", "a-2", "sess-b", 2)
      insertMessage(db, "run-1", "a-1", "sess-a", 4)
      insertMessage(db, "run-1", "a-1", "sess-a", 5)
      insertMessage(db, "run-1", "a-2", "sess-b", 3)
      insertMessage(db, "run-1", "a-2", "sess-b", 4)

      // The NEW rowid-cursor run-level query sees every entry.
      const all = service.listMessages("run-1", {})
      expect(all.items).toHaveLength(9)

      // Same run-level scope, but with the OLD seq cursor positioned after the
      // first page's last item (seq 5): B's seqs 3,4 are below it, so the
      // incremental pull would return nothing and silently drop them.
      const oldScope = and(
        eq(sessionEntries.runId, "run-1"),
        or(
          and(
            eq(sessionEntries.agentId, "a-1"),
            eq(sessionEntries.sessionId, "sess-a")
          ),
          and(
            eq(sessionEntries.agentId, "a-2"),
            eq(sessionEntries.sessionId, "sess-b")
          )
        )
      )
      const oldBehavior = listRenderableEntries(db, oldScope, {
        after: 5,
        cursor: { column: "seq" },
      })
      expect(oldBehavior.items).toHaveLength(0)
      await service.close()
    } finally {
      close()
    }
  })
})
