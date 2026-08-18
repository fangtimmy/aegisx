import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { SessionManager } from "@earendil-works/pi-coding-agent"
import { eq } from "drizzle-orm"

import { DbSessionManager } from "../../src/agents/db-session-manager"
import { createDatabase } from "../../src/db"
import { sessionEntries, sessions } from "../../src/db/schema"

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

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "aegisx-dbsm-"))
  const { db, sqlite, releaseLock } = createDatabase(dir)
  // The sessions/session_entries tables carry FK references to runs/agents.
  // These tests exercise DbSessionManager logic in isolation, so disable FK
  // enforcement to avoid seeding the full run/event/challenge chain.
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

describe("DbSessionManager", () => {
  test("create inserts a session row and starts empty", () => {
    const { db, close } = setup()
    try {
      const sm = DbSessionManager.create({
        cwd: "/ws",
        agentId: "a1",
        db,
      })
      const row = db
        .select()
        .from(sessions)
        .where(eq(sessions.id, sm.getSessionId()))
        .get()
      expect(row).toBeDefined()
      expect(row?.cwd).toBe("/ws")
      expect(sm.getEntries()).toEqual([])
      expect(sm.getLeafId()).toBeNull()
      expect(sm.getSessionFile()).toBe(sm.getSessionId())
      expect(sm.getHeader().type).toBe("session")
    } finally {
      close()
    }
  })

  test("appendMessage persists an entry and advances the leaf", () => {
    const { db, close } = setup()
    try {
      const sm = DbSessionManager.create({
        cwd: "/ws",
        agentId: "a1",
        db,
      })
      const id = sm.appendMessage(userMsg("hello"))
      expect(sm.getEntries()).toHaveLength(1)
      expect(sm.getLeafId()).toBe(id)
      const rows = db.select().from(sessionEntries).all()
      expect(rows).toHaveLength(1)
      expect(rows[0].type).toBe("message")
      expect(rows[0].seq).toBe(1)
      expect(rows[0].parentId).toBeNull()
      // data column is the full entry JSON
      const parsed = JSON.parse(rows[0].data)
      expect(parsed.type).toBe("message")
      expect(parsed.id).toBe(id)
      expect(parsed.message.content).toBe("hello")
    } finally {
      close()
    }
  })

  test("behavior matches pi SessionManager (in-memory) on the same sequence", () => {
    const { db, close } = setup()
    try {
      const ref = SessionManager.inMemory("/ws")
      const sm = DbSessionManager.create({
        cwd: "/ws",
        agentId: "a1",
        db,
      })
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

  test("compaction entry persists and drives context rebuild like pi", () => {
    const { db, close } = setup()
    try {
      const ref = SessionManager.inMemory("/ws")
      const sm = DbSessionManager.create({
        cwd: "/ws",
        agentId: "a1",
        db,
      })
      for (const m of [
        userMsg("1"),
        assistantMsg("2"),
        userMsg("3"),
        assistantMsg("4"),
      ]) {
        ref.appendMessage(m)
        sm.appendMessage(m)
      }
      // Keep from the 3rd entry (2nd user message) onward.
      const keptId = sm.getEntries()[2].id
      const refKeptId = ref.getEntries()[2].id
      sm.appendCompaction("summary", keptId, 1000)
      ref.appendCompaction("summary", refKeptId, 1000)

      expect(sm.buildContextEntries().map((e) => e.type)).toEqual(
        ref.buildContextEntries().map((e) => e.type)
      )
      expect(
        sm.buildSessionContext().messages.map((m: { role: string }) => m.role)
      ).toEqual(
        ref.buildSessionContext().messages.map((m: { role: string }) => m.role)
      )
      const compactionRows = db
        .select()
        .from(sessionEntries)
        .all()
        .filter((r) => r.type === "compaction")
      expect(compactionRows).toHaveLength(1)
      expect(JSON.parse(compactionRows[0].data).summary).toBe("summary")
    } finally {
      close()
    }
  })

  test("open restores entries, leaf, and context from the database", () => {
    const { db, close } = setup()
    try {
      const sm = DbSessionManager.create({
        cwd: "/ws",
        agentId: "a1",
        db,
      })
      sm.appendMessage(userMsg("a"))
      const lastId = sm.appendMessage(assistantMsg("b"))
      const id = sm.getSessionId()

      const reopened = DbSessionManager.open(id, {
        agentId: "a1",
        db,
      })
      expect(reopened.getEntries()).toHaveLength(2)
      expect(reopened.getLeafId()).toBe(lastId)
      expect(reopened.buildSessionContext().messages.map(role)).toEqual([
        "user",
        "assistant",
      ])
    } finally {
      close()
    }
  })

  test("branch + append produces an independent leaf path", () => {
    const { db, close } = setup()
    try {
      const ref = SessionManager.inMemory("/ws")
      const sm = DbSessionManager.create({
        cwd: "/ws",
        agentId: "a1",
        db,
      })
      sm.appendMessage(userMsg("a"))
      ref.appendMessage(userMsg("a"))
      const branchPoint = sm.getEntries()[0].id
      const refBranchPoint = ref.getEntries()[0].id

      sm.appendMessage(assistantMsg("trunk"))
      ref.appendMessage(assistantMsg("trunk"))

      sm.branch(branchPoint)
      ref.branch(refBranchPoint)
      sm.appendMessage(userMsg("branch"))
      ref.appendMessage(userMsg("branch"))

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

  test("labels are persisted and restored", () => {
    const { db, close } = setup()
    try {
      const sm = DbSessionManager.create({
        cwd: "/ws",
        agentId: "a1",
        db,
      })
      const msgId = sm.appendMessage(userMsg("a"))
      sm.appendLabelChange(msgId, "important")
      expect(sm.getLabel(msgId)).toBe("important")

      const reopened = DbSessionManager.open(sm.getSessionId(), {
        agentId: "a1",
        db,
      })
      expect(reopened.getLabel(msgId)).toBe("important")
      const labeled = reopened
        .getTree()
        .flatMap((n) => (n.label ? [n.label] : []))
      expect(labeled).toContain("important")
    } finally {
      close()
    }
  })
})
