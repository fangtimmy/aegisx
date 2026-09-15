import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { eq } from "drizzle-orm"

import { createDatabase } from "../../../src/db"
import {
  agents,
  sessionEntries,
  sessions,
  usageRollups,
  usageToolRollups,
} from "../../../src/db/schema"
import { PiSessionAdapter } from "../../../src/run/host/pi-session-adapter"
import {
  archiveSession,
  sweepSessionArchives,
} from "../../../src/run/host/session-archive"
import { listRenderableEntries } from "../../../src/run/host/session-queries"
import { createAgentQueries } from "../../../src/run/queries"
import {
  makeAgentService,
  seedAgent,
  seedChallenge,
  seedEvent,
  seedSessionEntry,
  USER,
} from "../../helpers"

/** Fresh on-disk store; FKs stay ON so the session→agent graph (and the
 * rollup cascade) is real. */
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "aegisx-archive-"))
  const { db, sqlite, releaseLock } = createDatabase(dir)
  return {
    db,
    dataDir: dir,
    close: () => {
      sqlite.close()
      releaseLock()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** Assistant message with usage (the adapter extracts the usage columns from
 * it at write time). */
function assistantMsg(
  text: string,
  input: number,
  output: number,
  cost: number
) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input,
      output,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: input + output,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
    },
    stopReason: "stop" as const,
    timestamp: Date.parse("2025-03-15T10:00:00Z"),
  }
}

function rollupOf(db: ReturnType<typeof setup>["db"], sessionId: string) {
  return db
    .select()
    .from(usageRollups)
    .where(eq(usageRollups.sessionId, sessionId))
    .get()
}

function toolCallsOf(db: ReturnType<typeof setup>["db"], sessionId: string) {
  return db
    .select()
    .from(usageToolRollups)
    .where(eq(usageToolRollups.sessionId, sessionId))
    .all()
    .map((row) => `${row.toolName}:${row.calls}`)
    .toSorted()
}

describe("usage rollups (entry-write transaction)", () => {
  test("each appended entry advances the rollups incrementally (usage, turns, toolCalls, entryCount)", () => {
    const { db, close } = setup()
    try {
      seedEvent(db)
      seedChallenge(db)
      seedAgent(db, { id: "a1" })
      const sm = PiSessionAdapter.create({ agentId: "a1", cwd: "/ws", db })
      const sid = sm.getSessionId()

      sm.appendMessage({
        role: "user",
        content: "go",
        timestamp: Date.parse("2025-03-15T10:00:00Z"),
      })
      let rollup = rollupOf(db, sid)
      expect(rollup).toBeDefined()
      expect(rollup!.agentId).toBe("a1")
      expect(rollup!.entryCount).toBe(1)
      expect(rollup!.turns).toBe(0)
      expect(rollup!.toolCalls).toBe(0)
      expect(rollup!.inputTokens).toBe(0)
      expect(rollup!.cost).toBe(0)

      sm.appendMessage(assistantMsg("working", 100, 50, 0.5))
      sm.appendMessage({
        role: "toolResult",
        toolCallId: "tc-1",
        toolName: "bash",
        content: [{ type: "text" as const, text: "ok" }],
        isError: false,
        timestamp: Date.parse("2025-03-15T10:00:05Z"),
      })
      rollup = rollupOf(db, sid)
      expect(rollup!.entryCount).toBe(3)
      expect(rollup!.turns).toBe(1) // the assistant message only
      expect(rollup!.toolCalls).toBe(1) // the toolResult only
      expect(rollup!.inputTokens).toBe(100)
      expect(rollup!.outputTokens).toBe(50)
      expect(rollup!.cost).toBeCloseTo(0.5)
      expect(toolCallsOf(db, sid)).toEqual(["bash:1"])
    } finally {
      close()
    }
  })
})

describe("backtrack keeps the rollups exact", () => {
  test("the tail delete recomputes the session's rollups from the surviving rows", async () => {
    const h = makeAgentService({})
    try {
      const agent = await h.service.spawn(
        { eventId: "evt-1", challengeId: "ch-1" },
        USER
      )
      const sid = "sess-backtrack"
      h.db
        .insert(sessions)
        .values({
          id: sid,
          agentId: agent.id,
          cwd: "/ws",
          createdAt: "2025-01-01T00:00:00Z",
        })
        .run()
      h.db
        .update(agents)
        .set({ sessionFile: sid })
        .where(eq(agents.id, agent.id))
        .run()
      seedSessionEntry(h.db, {
        sessionId: sid,
        agentId: agent.id,
        seq: 1,
        createdAt: "2025-03-15T10:00:00Z",
        message: { role: "user", content: "q", timestamp: 0 },
      })
      seedSessionEntry(h.db, {
        sessionId: sid,
        agentId: agent.id,
        seq: 2,
        createdAt: "2025-03-15T10:00:01Z",
        message: { role: "assistant", content: "a", timestamp: 0 },
        usage: { input: 500, output: 100, cost: 1.5 },
      })
      seedSessionEntry(h.db, {
        sessionId: sid,
        agentId: agent.id,
        seq: 3,
        createdAt: "2025-03-15T10:00:02Z",
        message: {
          role: "toolResult",
          toolCallId: "tc-1",
          toolName: "read",
          content: "x",
          timestamp: 0,
        },
      })

      // Pre-backtrack: 3 entries, 1 turn, 500 input tokens.
      expect(rollupOf(h.db, sid)!.entryCount).toBe(3)
      expect(rollupOf(h.db, sid)!.turns).toBe(1)
      expect(rollupOf(h.db, sid)!.inputTokens).toBe(500)

      await h.service.backtrackAgent(agent.id, 1, USER)

      const rollup = rollupOf(h.db, sid)!
      expect(rollup.entryCount).toBe(1)
      expect(rollup.turns).toBe(0)
      expect(rollup.inputTokens).toBe(0)
      expect(rollup.outputTokens).toBe(0)
      expect(rollup.cost).toBe(0)
      expect(toolCallsOf(h.db, sid)).toEqual([])
      // The session list badge reads the same projection.
      const listed = await h.service.listAgentSessions(agent.id, USER)
      expect(listed.find((s) => s.id === sid)?.messageCount).toBe(1)
    } finally {
      await h.close()
    }
  })
})

describe("session archive + transparent merged reads", () => {
  test("archiveSession moves rows to the gzip jsonl file; merged reads and cold-wake reload see the full history", () => {
    const { db, dataDir, close } = setup()
    try {
      seedEvent(db)
      seedChallenge(db)
      seedAgent(db, { id: "a1", status: "completed" })
      db.insert(sessions)
        .values({
          id: "sess-arc",
          agentId: "a1",
          cwd: "/ws",
          createdAt: "2025-03-15T10:00:00Z",
        })
        .run()
      for (let seq = 1; seq <= 4; seq += 1) {
        seedSessionEntry(db, {
          sessionId: "sess-arc",
          agentId: "a1",
          seq,
          createdAt: "2025-03-15T10:00:00Z",
          message: {
            role: seq % 2 === 1 ? "user" : "assistant",
            content: `m${seq}`,
            timestamp: 0,
          },
          ...(seq === 2 ? { usage: { input: 42, output: 7, cost: 0.25 } } : {}),
        })
      }
      expect(rollupOf(db, "sess-arc")!.entryCount).toBe(4)

      archiveSession(db, dataDir, "sess-arc")

      // The rows are gone; the file exists; the rollups (and thus every
      // stat face) are untouched.
      expect(
        db
          .select()
          .from(sessionEntries)
          .where(eq(sessionEntries.sessionId, "sess-arc"))
          .all()
      ).toHaveLength(0)
      expect(
        existsSync(join(dataDir, "archive", "sessions", "sess-arc.jsonl.gz"))
      ).toBe(true)
      expect(rollupOf(db, "sess-arc")!.entryCount).toBe(4)
      expect(rollupOf(db, "sess-arc")!.inputTokens).toBe(42)

      // Merged read: the message list serves the archived prefix.
      const listed = listRenderableEntries(db, {
        agentId: "a1",
        sessionId: "sess-arc",
        dataDir,
        after: 0,
      })
      expect(listed.items).toHaveLength(4)
      expect(listed.nextAfter).toBe(4)
      // Incremental paging past the archive reads the DB side only.
      const tail = listRenderableEntries(db, {
        agentId: "a1",
        sessionId: "sess-arc",
        dataDir,
        after: 4,
      })
      expect(tail.items).toHaveLength(0)
      expect(tail.nextAfter).toBe(4)

      // Cold wake: a revived terminal agent's session reloads the whole
      // history (archived prefix + nothing in DB) and keeps appending at
      // the right seq — the rollup advances from where it was.
      const sm = PiSessionAdapter.open("sess-arc", {
        agentId: "a1",
        db,
        dataDir,
      })
      sm.appendMessage(assistantMsg("revived", 11, 3, 0.05))
      expect(rollupOf(db, "sess-arc")!.entryCount).toBe(5)
      expect(rollupOf(db, "sess-arc")!.inputTokens).toBe(53)
      const reopened = listRenderableEntries(db, {
        agentId: "a1",
        sessionId: "sess-arc",
        dataDir,
        after: 0,
      })
      expect(reopened.items).toHaveLength(5)
      expect(reopened.nextAfter).toBe(5)
    } finally {
      close()
    }
  })

  test("the retention sweep archives eligible terminal sessions and leaves live ones", () => {
    const { db, dataDir, close } = setup()
    try {
      seedEvent(db)
      seedChallenge(db)
      seedAgent(db, { id: "a-old", status: "completed" })
      seedAgent(db, { id: "a-live", status: "running" })
      seedAgent(db, { id: "a-fresh", status: "completed" })
      for (const [sid, agentId] of [
        ["sess-old", "a-old"],
        ["sess-live", "a-live"],
        ["sess-fresh", "a-fresh"],
      ] as const) {
        db.insert(sessions)
          .values({
            id: sid,
            agentId,
            cwd: "/ws",
            createdAt: "2025-01-01T00:00:00Z",
          })
          .run()
      }
      for (const [sid, agentId, createdAt] of [
        ["sess-old", "a-old", "2025-01-01T00:00:00Z"],
        ["sess-live", "a-live", "2025-01-01T00:00:00Z"],
        ["sess-fresh", "a-fresh", "2026-09-14T00:00:00Z"],
      ] as const) {
        seedSessionEntry(db, {
          sessionId: sid,
          agentId,
          seq: 1,
          createdAt,
          message: { role: "user", content: "x", timestamp: 0 },
        })
      }

      const nowMs = Date.parse("2026-09-15T00:00:00Z")
      sweepSessionArchives(db, dataDir, 30, nowMs)

      expect(
        db
          .select()
          .from(sessionEntries)
          .where(eq(sessionEntries.sessionId, "sess-old"))
          .all()
      ).toHaveLength(0)
      expect(
        existsSync(join(dataDir, "archive", "sessions", "sess-old.jsonl.gz"))
      ).toBe(true)
      // Live agents' sessions are never archived; fresh ones stay.
      expect(
        db
          .select()
          .from(sessionEntries)
          .where(eq(sessionEntries.sessionId, "sess-live"))
          .all()
      ).toHaveLength(1)
      expect(
        db
          .select()
          .from(sessionEntries)
          .where(eq(sessionEntries.sessionId, "sess-fresh"))
          .all()
      ).toHaveLength(1)
    } finally {
      close()
    }
  })

  test("agent deletion cascades the rollup rows with the sessions and removes the archive file", async () => {
    const h = makeAgentService({})
    try {
      const agent = await h.service.spawn(
        { eventId: "evt-1", challengeId: "ch-1" },
        USER
      )
      const sid = "sess-del"
      h.db
        .insert(sessions)
        .values({
          id: sid,
          agentId: agent.id,
          cwd: "/ws",
          createdAt: "2025-01-01T00:00:00Z",
        })
        .run()
      seedSessionEntry(h.db, {
        sessionId: sid,
        agentId: agent.id,
        seq: 1,
        createdAt: "2025-01-01T00:00:00Z",
        message: { role: "user", content: "x", timestamp: 0 },
      })
      // Terminal agent, then archive its session.
      await h.service.closeAgent(agent.id, USER)
      archiveSession(h.db, h.dir, sid)
      expect(
        existsSync(join(h.dir, "archive", "sessions", `${sid}.jsonl.gz`))
      ).toBe(true)

      await h.service.delete(agent.id, USER)

      // The DB cascade took the sessions + rollups; the file sweep took the
      // archive.
      expect(
        h.db.select().from(sessions).where(eq(sessions.id, sid)).all()
      ).toHaveLength(0)
      expect(
        h.db
          .select()
          .from(usageRollups)
          .all()
          .filter((r) => r.sessionId === sid)
      ).toHaveLength(0)
      expect(
        existsSync(join(h.dir, "archive", "sessions", `${sid}.jsonl.gz`))
      ).toBe(false)
    } finally {
      await h.close()
    }
  })

  test("re-archiving after a cold-wake MERGES by seq — the archived prefix survives the second sweep", () => {
    const { db, dataDir, close } = setup()
    try {
      seedEvent(db)
      seedChallenge(db)
      seedAgent(db, { id: "a1", status: "completed" })
      db.insert(sessions)
        .values({
          id: "sess-merge",
          agentId: "a1",
          cwd: "/ws",
          createdAt: "2025-03-15T10:00:00Z",
        })
        .run()
      for (let seq = 1; seq <= 4; seq += 1) {
        seedSessionEntry(db, {
          sessionId: "sess-merge",
          agentId: "a1",
          seq,
          createdAt: "2025-03-15T10:00:00Z",
          message: {
            role: seq % 2 === 1 ? "user" : "assistant",
            content: `m${seq}`,
            timestamp: 0,
          },
        })
      }

      // Sweep #1: rows 1..4 move to the file.
      archiveSession(db, dataDir, "sess-merge")
      expect(
        db
          .select()
          .from(sessionEntries)
          .where(eq(sessionEntries.sessionId, "sess-merge"))
          .all()
      ).toHaveLength(0)

      // Cold wake: the revived agent appends seq 5 (merged read restored
      // 1..4 into the adapter, so the append continues at the right seq).
      const sm = PiSessionAdapter.open("sess-merge", {
        agentId: "a1",
        db,
        dataDir,
      })
      sm.appendMessage(assistantMsg("revived", 11, 3, 0.05))

      // Sweep #2 re-archives the session. The historical bug: the file was
      // REPLACED with the current DB rows (only seq 5), dropping 1..4.
      archiveSession(db, dataDir, "sess-merge")

      expect(
        db
          .select()
          .from(sessionEntries)
          .where(eq(sessionEntries.sessionId, "sess-merge"))
          .all()
      ).toHaveLength(0)
      const merged = listRenderableEntries(db, {
        agentId: "a1",
        sessionId: "sess-merge",
        dataDir,
        after: 0,
      })
      // The FULL history — archived prefix AND the post-wake tail.
      expect(merged.items).toHaveLength(5)
      expect(merged.items[0].seq).toBe(1)
      expect(merged.items[0].entry.id).toBe("sess-merge-e1")
      expect(merged.items[4].seq).toBe(5)
      expect(merged.nextAfter).toBe(5)
      expect(merged.sessionHeadSeq).toBe(5)
    } finally {
      close()
    }
  })

  test("the messages list carries the session's TRUE head even when it sits below the request cursor", () => {
    const { db, dataDir, close } = setup()
    try {
      seedEvent(db)
      seedChallenge(db)
      seedAgent(db, { id: "a1", status: "completed" })
      db.insert(sessions)
        .values({
          id: "sess-head",
          agentId: "a1",
          cwd: "/ws",
          createdAt: "2025-03-15T10:00:00Z",
        })
        .run()
      for (let seq = 1; seq <= 4; seq += 1) {
        seedSessionEntry(db, {
          sessionId: "sess-head",
          agentId: "a1",
          seq,
          createdAt: "2025-03-15T10:00:00Z",
          message: {
            role: seq % 2 === 1 ? "user" : "assistant",
            content: `m${seq}`,
            timestamp: 0,
          },
        })
      }
      archiveSession(db, dataDir, "sess-head")

      // A client holding cursor 10 (e.g. the session was truncated elsewhere)
      // gets an empty page whose nextAfter just echoes its cursor — the head
      // field is what exposes head(4) < cursor(10).
      const listed = listRenderableEntries(db, {
        agentId: "a1",
        sessionId: "sess-head",
        dataDir,
        after: 10,
      })
      expect(listed.items).toHaveLength(0)
      expect(listed.nextAfter).toBe(10)
      expect(listed.sessionHeadSeq).toBe(4)

      // The endpoint response builder stamps the same field.
      const queries = createAgentQueries({ db, dataDir })
      expect(
        queries.listMessages("a1", { after: 10, sessionId: "sess-head" })
          .sessionHeadSeq
      ).toBe(4)
      // A session with no rows anywhere reads head 0.
      expect(
        queries.listMessages("a1", { after: 10, sessionId: "sess-none" })
          .sessionHeadSeq
      ).toBe(0)
    } finally {
      close()
    }
  })

  test("backtracking to an entry that only exists in the archive resolves on the merged timeline", async () => {
    const h = makeAgentService({})
    try {
      const agent = await h.service.spawn(
        { eventId: "evt-1", challengeId: "ch-1" },
        USER
      )
      const sid = "sess-arc-bt"
      h.db
        .insert(sessions)
        .values({
          id: sid,
          agentId: agent.id,
          cwd: "/ws",
          createdAt: "2025-01-01T00:00:00Z",
        })
        .run()
      h.db
        .update(agents)
        .set({ sessionFile: sid })
        .where(eq(agents.id, agent.id))
        .run()
      for (let seq = 1; seq <= 4; seq += 1) {
        seedSessionEntry(h.db, {
          sessionId: sid,
          agentId: agent.id,
          seq,
          createdAt: "2025-01-01T00:00:00Z",
          message: {
            role: seq % 2 === 1 ? "user" : "assistant",
            content: `m${seq}`,
            timestamp: 0,
          },
        })
      }
      await h.service.closeAgent(agent.id, USER)
      archiveSession(h.db, h.dir, sid)
      expect(
        h.db
          .select()
          .from(sessionEntries)
          .where(eq(sessionEntries.sessionId, sid))
          .all()
      ).toHaveLength(0)

      // seq 2 lives only in the archive file — a DB-only target lookup would
      // 404 here. The merged-timeline lookup accepts it (a no-op delete: the
      // database side is already empty past it).
      await h.service.backtrackAgent(agent.id, 2, USER)

      // A seq in neither the archive nor the database is still not found.
      await expect(
        h.service.backtrackAgent(agent.id, 99, USER)
      ).rejects.toThrow("Target message not found")
    } finally {
      await h.close()
    }
  })

  test("backtracking a live row on a partially-archived session keeps the archived prefix in the rollups", async () => {
    const h = makeAgentService({})
    try {
      const agent = await h.service.spawn(
        { eventId: "evt-1", challengeId: "ch-1" },
        USER
      )
      const sid = "sess-arc-partial"
      h.db
        .insert(sessions)
        .values({
          id: sid,
          agentId: agent.id,
          cwd: "/ws",
          createdAt: "2025-01-01T00:00:00Z",
        })
        .run()
      h.db
        .update(agents)
        .set({ sessionFile: sid })
        .where(eq(agents.id, agent.id))
        .run()
      // Live rows 1..4 (usage rides on the seq-2 assistant), then the prefix
      // is archived away.
      for (let seq = 1; seq <= 4; seq += 1) {
        seedSessionEntry(h.db, {
          sessionId: sid,
          agentId: agent.id,
          seq,
          createdAt: "2025-01-01T00:00:00Z",
          message: {
            role: seq % 2 === 1 ? "user" : "assistant",
            content: `m${seq}`,
            timestamp: 0,
          },
          ...(seq === 2 ? { usage: { input: 42, output: 7, cost: 0.25 } } : {}),
        })
      }
      await h.service.closeAgent(agent.id, USER)
      archiveSession(h.db, h.dir, sid)

      // Cold wake appends a live tail (seq 5, seq 6 — both with usage).
      const sm = PiSessionAdapter.open(sid, {
        agentId: agent.id,
        db: h.db,
        dataDir: h.dir,
      })
      sm.appendMessage(assistantMsg("revived", 11, 3, 0.05))
      sm.appendMessage(assistantMsg("again", 20, 4, 0.1))
      expect(rollupOf(h.db, sid)!.entryCount).toBe(6)

      // Backtrack at the LIVE seq-5 row: seq 6 is physically deleted and the
      // rollups recompute. The recompute must read the merged history — a
      // database-only sum would deflate the projection to the lone live row.
      await h.service.backtrackAgent(agent.id, 5, USER)

      const rollup = rollupOf(h.db, sid)!
      expect(rollup.entryCount).toBe(5) // archived 1..4 + surviving seq 5
      expect(rollup.inputTokens).toBe(42 + 11)
      expect(rollup.outputTokens).toBe(7 + 3)
      expect(rollup.turns).toBe(3) // the seq-2, seq-4 and seq-5 assistants
      expect(rollup.cost).toBeCloseTo(0.25 + 0.05)
      // The session list badge reads the same projection.
      const listed = await h.service.listAgentSessions(agent.id, USER)
      expect(listed.find((s) => s.id === sid)?.messageCount).toBe(5)
    } finally {
      await h.close()
    }
  })
})
