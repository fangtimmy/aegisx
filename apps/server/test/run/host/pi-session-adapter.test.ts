import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { SessionEntryView } from "@aegisx/shared"
import type { SessionEntry } from "@earendil-works/pi-coding-agent"
import { SessionManager } from "@earendil-works/pi-coding-agent"
import { and, asc, eq, gt } from "drizzle-orm"

import { createDatabase } from "../../../src/db"
import { sessionEntries, sessions } from "../../../src/db/schema"
import { PiSessionAdapter } from "../../../src/run/host/pi-session-adapter"
import {
  entryFromRow,
  toCanonicalBody,
} from "../../../src/run/host/session-entry-codec"

/** Minimal AgentMessage factories (shapes match pi-ai Message). */
function userMsg(text: string) {
  return { role: "user" as const, content: text, timestamp: Date.now() }
}
function assistantMsg(text: string) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  }
}
function toolResultMsg(text: string, toolName: string) {
  return {
    role: "toolResult" as const,
    toolCallId: `tc-${toolName}`,
    toolName,
    content: [{ type: "text" as const, text }],
    isError: false,
    timestamp: Date.now(),
  }
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "aegisx-adapter-"))
  const { db, sqlite, releaseLock } = createDatabase(dir)
  // The sessions/session_entries tables carry FK references to agents. These
  // tests exercise adapter logic in isolation, so disable FK enforcement to
  // avoid seeding the full run/event/challenge chain.
  sqlite.run("PRAGMA foreign_keys = OFF")
  return {
    db,
    close: () => {
      sqlite.close()
      releaseLock()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

const role = (m: { role: string }) => m.role

/** Full in-memory state snapshot for replay comparison (entry ids are
 * preserved by the bulk load, so deep equality is expected). */
function snapshot(sm: PiSessionAdapter) {
  return {
    entries: sm.getEntries(),
    leafId: sm.getLeafId(),
    branchTypes: sm.getBranch().map((e) => e.type),
    contextRoles: sm.buildSessionContext().messages.map(role),
    contextEntryIds: sm.buildContextEntries().map((e) => e.id),
    name: sm.getSessionName(),
    tree: JSON.parse(JSON.stringify(sm.getTree())),
  }
}

/** Drive one adapter through every entry kind + leaf moves. */
function exerciseAllKinds(sm: PiSessionAdapter) {
  const firstId = sm.appendMessage(userMsg("a"))
  sm.appendMessage(assistantMsg("b"))
  sm.appendMessage(toolResultMsg("done", "bash"))
  sm.appendThinkingLevelChange("high")
  sm.appendModelChange("prov", "model-1")
  sm.appendCompaction("summary", firstId, 1000, { structured: true })
  sm.appendCustomEntry("myext", { state: 1 })
  sm.appendCustomMessageEntry(
    "myextmsg",
    [{ type: "text", text: "note" }],
    true,
    { d: 1 }
  )
  sm.appendSessionInfo("My session")
  sm.appendLabelChange(firstId, "important")
  sm.branch(firstId)
  sm.appendMessage(userMsg("branch"))
  sm.branchWithSummary(firstId, "back from branch", undefined, false)
  sm.resetLeaf()
  sm.appendMessage(userMsg("fresh root"))
  return firstId
}

describe("PiSessionAdapter", () => {
  test("create inserts a session row and starts empty", () => {
    const { db, close } = setup()
    try {
      const sm = PiSessionAdapter.create({ cwd: "/ws", agentId: "a1", db })
      const row = db
        .select()
        .from(sessions)
        .where(eq(sessions.id, sm.getSessionId()))
        .get()
      expect(row).toBeDefined()
      expect(row?.cwd).toBe("/ws")
      expect(row?.activeLeafId).toBeNull()
      expect(sm.getEntries()).toEqual([])
      expect(sm.getLeafId()).toBeNull()
      expect(sm.getSessionFile()).toBe(sm.getSessionId())
      expect(sm.getHeader()?.type).toBe("session")
    } finally {
      close()
    }
  })

  test("appendMessage persists one canonical row and advances the leaf", () => {
    const { db, close } = setup()
    try {
      const sm = PiSessionAdapter.create({ cwd: "/ws", agentId: "a1", db })
      const id = sm.appendMessage(userMsg("hello"))
      expect(sm.getEntries()).toHaveLength(1)
      expect(sm.getLeafId()).toBe(id)
      const rows = db.select().from(sessionEntries).all()
      expect(rows).toHaveLength(1)
      expect(rows[0].type).toBe("message")
      expect(rows[0].seq).toBe(1)
      expect(rows[0].parentId).toBeNull()
      expect(rows[0].role).toBe("user")
      // body is the canonical envelope; identity columns are the row's.
      const body = JSON.parse(rows[0].body)
      expect(body).toEqual({
        kind: "message",
        payload: {
          message: {
            role: "user",
            content: "hello",
            timestamp: expect.any(Number),
          },
        },
      })
      expect(sm.getSessionId()).toBeTypeOf("string")
    } finally {
      close()
    }
  })

  test("REPLAY PARITY: reopen bulk-loads and reproduces the in-memory session", () => {
    const { db, close } = setup()
    try {
      const sm = PiSessionAdapter.create({ cwd: "/ws", agentId: "a1", db })
      exerciseAllKinds(sm)

      // Store → bulk load round trip: deep-equal state, same entry ids.
      const reopened = PiSessionAdapter.open(sm.getSessionId(), {
        agentId: "a1",
        db,
      })
      expect(snapshot(reopened)).toEqual(snapshot(sm))

      // The reopened manager keeps writing with continuing seqs.
      reopened.appendMessage(userMsg("after resume"))
      const rows = db
        .select()
        .from(sessionEntries)
        .orderBy(asc(sessionEntries.seq))
        .all()
      // exerciseAllKinds lands 13 rows; branch/resetLeaf only moved the leaf.
      // The resumed append continues the seq sequence at 14.
      expect(rows.map((r) => r.seq)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14,
      ])
    } finally {
      close()
    }
  })

  test("semantics match pi SessionManager.inMemory on the same sequence", () => {
    const { db, close } = setup()
    try {
      const ref = SessionManager.inMemory("/ws")
      const sm = PiSessionAdapter.create({ cwd: "/ws", agentId: "a1", db })
      const seq = [userMsg("a"), assistantMsg("b"), userMsg("c")]
      for (const m of seq) {
        ref.appendMessage(m)
        sm.appendMessage(m)
      }
      expect(sm.getEntries().map((e) => e.type)).toEqual(
        ref.getEntries().map((e) => e.type)
      )
      expect(sm.getBranch().map((e) => e.type)).toEqual(
        ref.getBranch().map((e) => e.type)
      )
      expect(sm.buildSessionContext().messages.map(role)).toEqual(
        ref.buildSessionContext().messages.map(role)
      )
    } finally {
      close()
    }
  })

  test("compaction persisted on write drives the same context rebuild after reopen", () => {
    const { db, close } = setup()
    try {
      const sm = PiSessionAdapter.create({ cwd: "/ws", agentId: "a1", db })
      for (const m of [
        userMsg("1"),
        assistantMsg("2"),
        userMsg("3"),
        assistantMsg("4"),
      ]) {
        sm.appendMessage(m)
      }
      const keptId = sm.getEntries()[2].id
      sm.appendCompaction("summary", keptId, 1000)

      const reopened = PiSessionAdapter.open(sm.getSessionId(), {
        agentId: "a1",
        db,
      })
      expect(reopened.buildContextEntries().map((e) => e.type)).toEqual(
        sm.buildContextEntries().map((e) => e.type)
      )
      expect(
        reopened
          .buildSessionContext()
          .messages.map((m: { role: string }) => m.role)
      ).toEqual(sm.buildSessionContext().messages.map(role))
      const compactionRows = db
        .select()
        .from(sessionEntries)
        .all()
        .filter((r) => r.type === "compaction")
      expect(compactionRows).toHaveLength(1)
      const body = JSON.parse(compactionRows[0].body)
      expect(body.kind).toBe("compaction")
      expect(body.summary).toBe("summary")
      expect(body.firstKeptEntryId).toBe(keptId)
      expect(body.tokensBefore).toBe(1000)
      expect(body.payload).toEqual({})
    } finally {
      close()
    }
  })

  test("branch position survives reopen (the persisted active leaf)", () => {
    const { db, close } = setup()
    try {
      const sm = PiSessionAdapter.create({ cwd: "/ws", agentId: "a1", db })
      const firstId = sm.appendMessage(userMsg("a"))
      sm.appendMessage(assistantMsg("trunk"))
      sm.branch(firstId)
      expect(
        db.select({ leaf: sessions.activeLeafId }).from(sessions).get()?.leaf
      ).toBe(firstId)
      sm.close()

      const reopened = PiSessionAdapter.open(sm.getSessionId(), {
        agentId: "a1",
        db,
      })
      expect(reopened.getLeafId()).toBe(firstId)
      const branchId = reopened.appendMessage(userMsg("branch"))
      const rows = db
        .select()
        .from(sessionEntries)
        .orderBy(asc(sessionEntries.seq))
        .all()
      expect(rows).toHaveLength(3)
      expect(rows[2].parentId).toBe(firstId)
      expect(rows[2].seq).toBe(3)
      expect(branchId).toBe(rows[2].id)
    } finally {
      close()
    }
  })

  test("resetLeaf persists (reopened leaf stays before the first entry)", () => {
    const { db, close } = setup()
    try {
      const sm = PiSessionAdapter.create({ cwd: "/ws", agentId: "a1", db })
      sm.appendMessage(userMsg("a"))
      sm.resetLeaf()
      sm.close()

      const reopened = PiSessionAdapter.open(sm.getSessionId(), {
        agentId: "a1",
        db,
      })
      expect(reopened.getLeafId()).toBeNull()
    } finally {
      close()
    }
  })

  test("backtrack: physical tail delete reopens at the last surviving row", () => {
    const { db, close } = setup()
    try {
      const sm = PiSessionAdapter.create({ cwd: "/ws", agentId: "a1", db })
      sm.appendMessage(userMsg("a"))
      sm.appendMessage(assistantMsg("b"))
      const thirdId = sm.appendMessage(userMsg("c"))
      sm.branch(sm.getEntries()[0].id)
      sm.close()

      // The backtrack store operation: DELETE WHERE seq > X.
      db.delete(sessionEntries)
        .where(
          and(
            eq(sessionEntries.sessionId, sm.getSessionId()),
            gt(sessionEntries.seq, 1)
          )
        )
        .run()

      const reopened = PiSessionAdapter.open(sm.getSessionId(), {
        agentId: "a1",
        db,
      })
      // The stored pointer was deleted with the tail; the leaf falls back to
      // the last surviving row and the column is normalized to match.
      expect(reopened.getLeafId()).not.toBe(thirdId)
      expect(reopened.getLeafId()).toBe(sm.getEntries()[0].id)
      expect(reopened.getEntries()).toHaveLength(1)
      expect(
        db.select({ leaf: sessions.activeLeafId }).from(sessions).get()?.leaf
      ).toBe(sm.getEntries()[0].id)
    } finally {
      close()
    }
  })

  test("close() rejects later writes and persists nothing", () => {
    const { db, close } = setup()
    try {
      const sm = PiSessionAdapter.create({ cwd: "/ws", agentId: "a1", db })
      const id = sm.appendMessage(userMsg("a"))
      sm.close()
      expect(() => sm.appendMessage(userMsg("late"))).toThrow(
        `PiSessionAdapter: appendMessage on closed session ${sm.getSessionId()}`
      )
      expect(() => sm.branch(id)).toThrow(/closed session/)
      expect(() => sm.resetLeaf()).toThrow(/closed session/)
      const rows = db.select().from(sessionEntries).all()
      expect(rows).toHaveLength(1)
      expect(JSON.parse(rows[0].body).payload.message.content).toBe("a")
    } finally {
      close()
    }
  })

  test("open rejects a missing session and a session owned by another agent", () => {
    const { db, close } = setup()
    try {
      const sm = PiSessionAdapter.create({ cwd: "/ws", agentId: "a1", db })
      expect(() =>
        PiSessionAdapter.open("nope", { agentId: "a1", db })
      ).toThrow("PiSessionAdapter: session nope not found")
      expect(() =>
        PiSessionAdapter.open(sm.getSessionId(), { agentId: "a2", db })
      ).toThrow(
        `PiSessionAdapter: session ${sm.getSessionId()} belongs to agent a1, not a2`
      )
    } finally {
      close()
    }
  })

  test("usage columns are extracted at write time (message, toolResult, compaction)", () => {
    const { db, close } = setup()
    try {
      const sm = PiSessionAdapter.create({ cwd: "/ws", agentId: "a1", db })
      sm.appendMessage(userMsg("a"))
      sm.appendMessage(assistantMsg("b"))
      sm.appendMessage(toolResultMsg("done", "bash"))
      sm.appendCompaction(
        "summary",
        sm.getEntries()[0].id,
        10,
        undefined,
        false,
        {
          input: 50,
          output: 5,
          cacheRead: 1,
          cacheWrite: 2,
          reasoning: 3,
          totalTokens: 58,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0.5,
          },
        }
      )

      const rows = db
        .select()
        .from(sessionEntries)
        .orderBy(asc(sessionEntries.seq))
        .all()
      expect(rows[0].role).toBe("user")
      expect(rows[0].inputTokens).toBeNull()
      expect(rows[1].role).toBe("assistant")
      expect(rows[1].inputTokens).toBe(1)
      expect(rows[1].outputTokens).toBe(1)
      expect(rows[1].cost).toBe(0)
      expect(rows[2].role).toBe("toolResult")
      expect(rows[2].toolName).toBe("bash")
      expect(rows[3].role).toBeNull()
      expect(rows[3].inputTokens).toBe(50)
      expect(rows[3].reasoningTokens).toBe(3)
      expect(rows[3].cost).toBeCloseTo(0.5)
    } finally {
      close()
    }
  })

  test("metaProvider lands in the row; onAppend fires post-persist with seqs", () => {
    const { db, close } = setup()
    try {
      const sm = PiSessionAdapter.create({ cwd: "/ws", agentId: "a1", db })
      sm.metaProvider = (entry) =>
        entry.type === "message" && entry.message.role === "assistant"
          ? { durationMs: 42 }
          : null
      const seen: Array<[SessionEntryView, number]> = []
      sm.onAppend = (entry, seq) => seen.push([entry, seq])

      sm.appendMessage(userMsg("a"))
      sm.appendMessage(assistantMsg("b"))

      const rows = db
        .select()
        .from(sessionEntries)
        .orderBy(asc(sessionEntries.seq))
        .all()
      expect(rows[0].meta).toBeNull()
      expect(JSON.parse(rows[1].meta!)).toEqual({ durationMs: 42 })
      expect(seen.map(([entry, seq]) => [entry.id, seq])).toEqual([
        [rows[0].id, 1],
        [rows[1].id, 2],
      ])
    } finally {
      close()
    }
  })

  test("canonical round trip: every kind + unknown-kind verbatim", () => {
    const base = {
      id: "e1",
      parentId: "p1",
      timestamp: "2025-01-01T00:00:00.000Z",
    }
    // Includes a deliberate unknown-kind entry no pi union can name.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const entries = [
      { ...base, type: "message", message: userMsg("hello") },
      { ...base, type: "thinking_level_change", thinkingLevel: "high" },
      { ...base, type: "model_change", provider: "prov", modelId: "m1" },
      {
        ...base,
        type: "compaction",
        summary: "s",
        firstKeptEntryId: "k",
        tokensBefore: 10,
        details: { structured: true },
        fromHook: false,
      },
      { ...base, type: "branch_summary", fromId: "root", summary: "s" },
      { ...base, type: "custom", customType: "ext", data: { a: 1 } },
      {
        ...base,
        type: "custom_message",
        customType: "extm",
        content: [{ type: "text", text: "n" }],
        display: true,
      },
      { ...base, type: "session_info", name: "Named" },
      { ...base, type: "label", targetId: "t1", label: "L" },
      // Unknown kind: default-accept, every field survives verbatim.
      {
        ...base,
        type: "future_thing",
        foo: { bar: 1 },
        payload: "reserved-name",
      },
    ] as unknown as SessionEntry[]

    for (const entry of entries) {
      const row = {
        id: entry.id,
        parentId: entry.parentId,
        createdAt: entry.timestamp,
        body: JSON.stringify(toCanonicalBody(entry)),
      }
      expect(entryFromRow(row)).toEqual(entry)
    }
  })
})
