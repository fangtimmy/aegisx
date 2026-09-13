import { describe, expect, test } from "bun:test"

import { isRecord } from "@aegisx/shared"
import { eq, type SQL } from "drizzle-orm"

import { sessionEntries, sessions } from "../../src/db/schema"
import {
  accumulateEntryUsage,
  type EntryUsage,
} from "../../src/run/host/entry-usage"
import { entryFromRow } from "../../src/run/host/session-entry-codec"
import {
  sumUsageTotals,
  usageTotalsSql,
} from "../../src/run/host/session-queries"
import { seedAgent, seedChallenge, seedEvent, setupDb, now } from "../helpers"

type Db = ReturnType<typeof setupDb>["db"]

/** Assistant-message usage payload (entry-usage.ts accumulator shape). */
function usage(overrides: Partial<EntryUsage> = {}): EntryUsage {
  return {
    input: 10,
    output: 5,
    cacheRead: 2,
    cacheWrite: 1,
    reasoning: 3,
    cost: { total: 0.25 },
    ...overrides,
  }
}

/** Seed one session the way the adapter would persist it: canonical body +
 * first-class columns extracted from the entry's usage. For non-message kinds
 * the usage object rides in `payload` (the fold reads it there); message rows
 * carry it inside `message`. */
function insertEntry(
  db: Db,
  agentId: string,
  sessionId: string,
  seq: number,
  entry: {
    kind: string
    typed?: Record<string, unknown>
    payload?: Record<string, unknown>
    usage?: EntryUsage
  }
) {
  const rawMessage = entry.payload?.message
  const message: Record<string, unknown> | undefined =
    entry.kind === "message" && isRecord(rawMessage)
      ? { ...rawMessage, usage: entry.usage }
      : undefined
  const messageRole = typeof message?.role === "string" ? message.role : null
  db.insert(sessionEntries)
    .values({
      id: `parity-${seq}`,
      sessionId,
      agentId,
      seq,
      type: entry.kind,
      role:
        messageRole === "user" ||
        messageRole === "assistant" ||
        messageRole === "toolResult"
          ? messageRole
          : null,
      inputTokens: entry.usage?.input ?? null,
      outputTokens: entry.usage?.output ?? null,
      cacheReadTokens: entry.usage?.cacheRead ?? null,
      cacheWriteTokens: entry.usage?.cacheWrite ?? null,
      reasoningTokens: entry.usage?.reasoning ?? null,
      cost: entry.usage?.cost?.total ?? null,
      createdAt: now(),
      body: JSON.stringify(
        message
          ? { kind: entry.kind, payload: { message } }
          : {
              kind: entry.kind,
              ...entry.typed,
              payload: { ...entry.payload, usage: entry.usage },
            }
      ),
    })
    .run()
}

/** JS side of the parity: de-canonicalize committed rows, skipping corrupt
 * ones (rows are typed at commit time by the adapter; the parse only guards
 * against corruption). */
function readEntries(db: Db, where: SQL) {
  const rows = db
    .select({
      id: sessionEntries.id,
      parentId: sessionEntries.parentId,
      createdAt: sessionEntries.createdAt,
      body: sessionEntries.body,
    })
    .from(sessionEntries)
    .where(where)
    .all()
  const entries = []
  for (const row of rows) {
    try {
      entries.push(entryFromRow(row))
    } catch {
      // skip corrupt
    }
  }
  return entries
}

function setup(db: Db) {
  seedEvent(db, "evt-1")
  seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
  seedAgent(db, { id: "a-1", challengeId: "ch-1", sessionFile: "sess-1" })
  db.insert(sessions)
    .values({
      id: "sess-1",
      agentId: "a-1",
      cwd: "/workspace",
      createdAt: now(),
    })
    .run()
}

const scopeOf = (_db: Db) => eq(sessionEntries.agentId, "a-1")

describe("usage aggregation column/fold parity", () => {
  test("mixed entry mix aggregates identically (tokens, cost, turns)", () => {
    const { db, close } = setupDb()
    try {
      setup(db)
      // assistant w/ usage, toolResult w/ usage, assistant w/o usage,
      // compaction w/ usage, branch_summary w/ usage, assistant w/o usage.
      insertEntry(db, "a-1", "sess-1", 1, {
        kind: "message",
        payload: { message: { role: "assistant" } },
        usage: usage({ input: 100, cost: { total: 2 } }),
      })
      insertEntry(db, "a-1", "sess-1", 2, {
        kind: "message",
        payload: { message: { role: "toolResult" } },
        usage: usage({ input: 7, output: 0 }),
      })
      insertEntry(db, "a-1", "sess-1", 3, {
        kind: "message",
        payload: { message: { role: "assistant" } }, // no usage at all
      })
      insertEntry(db, "a-1", "sess-1", 4, {
        kind: "compaction",
        typed: { summary: "s", firstKeptEntryId: "x", tokensBefore: 1000 },
        usage: usage({ input: 50, reasoning: 1, cost: { total: 0.5 } }),
      })
      insertEntry(db, "a-1", "sess-1", 5, {
        kind: "branch_summary",
        typed: { fromId: "root", summary: "s" },
        usage: usage({ input: 3, cost: { total: 0.1 } }),
      })
      insertEntry(db, "a-1", "sess-1", 6, {
        kind: "message",
        payload: { message: { role: "assistant", content: "hi" } },
      })

      const js = accumulateEntryUsage(readEntries(db, scopeOf(db)))
      const totals = usageTotalsSql(db, scopeOf(db))

      expect(totals.input).toBe(js.input)
      expect(totals.output).toBe(js.output)
      expect(totals.cacheRead).toBe(js.cacheRead)
      expect(totals.cacheWrite).toBe(js.cacheWrite)
      expect(totals.reasoning).toBe(js.reasoning)
      expect(totals.cost).toBe(js.cost)
      expect(totals.turns).toBe(js.turns)
      expect(totals.totalTokens).toBe(js.totalTokens)
      // Sanity on the actual values (3 assistant messages incl. the
      // usage-less one — turns counts assistant messages before the guard).
      expect(js.turns).toBe(3)
      expect(js.input).toBe(100 + 7 + 50 + 3)
    } finally {
      close()
    }
  })

  test("empty scope: SQL matches JS zeros; sumUsageTotals returns undefined", () => {
    const { db, close } = setupDb()
    try {
      setup(db)
      // A toolResult with zeroed usage: turns counts assistant messages only,
      // so turns=0 and every total is zero → sumUsageTotals stays undefined.
      insertEntry(db, "a-1", "sess-1", 1, {
        kind: "message",
        payload: { message: { role: "toolResult" } },
        usage: usage({
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          reasoning: 0,
          cost: { total: 0 },
        }),
      })

      const js = accumulateEntryUsage(readEntries(db, scopeOf(db)))
      const totals = usageTotalsSql(db, scopeOf(db))
      expect(totals.turns).toBe(js.turns)
      expect(totals.input).toBe(js.input)
      expect(totals.cost).toBe(js.cost)
      expect(totals.cacheHitRate).toBeNull()
      expect(js.turns).toBe(0)
      // All-zero → the sumUsageTotals "nothing used → undefined" rule.
      expect(sumUsageTotals(db, scopeOf(db))).toBeUndefined()
    } finally {
      close()
    }
  })

  test("cacheHitRate: the LATEST assistant row with prompt tokens wins (SQL matches fold)", () => {
    const { db, close } = setupDb()
    try {
      setup(db)
      insertEntry(db, "a-1", "sess-1", 1, {
        kind: "message",
        payload: { message: { role: "assistant" } },
        usage: usage({ input: 100, cacheRead: 50, cacheWrite: 0 }), // 50% hit
      })
      insertEntry(db, "a-1", "sess-1", 2, {
        kind: "message",
        payload: { message: { role: "assistant" } },
        usage: usage({ input: 100, cacheRead: 25, cacheWrite: 0 }), // 25% hit
      })
      // A later assistant with no prompt tokens must NOT overwrite the rate.
      insertEntry(db, "a-1", "sess-1", 3, {
        kind: "message",
        payload: { message: { role: "assistant" } },
        usage: usage({ input: 0, cacheRead: 0, cacheWrite: 0 }),
      })

      const js = accumulateEntryUsage(readEntries(db, scopeOf(db)))
      const totals = usageTotalsSql(db, scopeOf(db))
      // prompt = input + cacheRead + cacheWrite = 125 → 25/125 = 20%.
      expect(js.cacheHitRate).toBe(20)
      expect(totals.cacheHitRate).toBe(20)
    } finally {
      close()
    }
  })
})
