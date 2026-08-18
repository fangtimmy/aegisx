import { describe, expect, test } from "bun:test"

import { eq } from "drizzle-orm"

import {
  accumulateEntryUsage,
  type EntryUsage,
} from "../../src/agents/entry-usage"
import {
  cacheHitRateSql,
  readSessionEntries,
  sumUsageTotals,
  usageTotalsSql,
} from "../../src/agents/session-queries"
import { sessionEntries, sessions } from "../../src/db/schema"
import { seedAgent, seedChallenge, seedEvent, setupDb, now } from "../helpers"

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

/** Insert a session entry with a given type + data (JSON), keeping the row's
 * `type` column and the entry's own `type` consistent (SQL reads the column,
 * readSessionEntries reads the JSON). */
function insertEntry(
  db: ReturnType<typeof setupDb>["db"],
  agentId: string,
  sessionId: string,
  seq: number,
  entry: {
    type: string
    message?: { role: string; usage?: unknown }
    usage?: EntryUsage
  }
) {
  db.insert(sessionEntries)
    .values({
      id: `parity-${seq}`,
      sessionId,
      agentId,
      seq,
      type: entry.type,
      data: JSON.stringify(entry),
      createdAt: now(),
    })
    .run()
}

function setup(
  db: ReturnType<typeof setupDb>["db"],
  _sqlite: ReturnType<typeof setupDb>["sqlite"],
  _dir: string
) {
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

const scopeOf = (_db: ReturnType<typeof setupDb>["db"]) =>
  eq(sessionEntries.agentId, "a-1")

describe("usage aggregation SQL/JS parity (code-review P4.1)", () => {
  test("mixed entry mix aggregates identically (tokens, cost, turns, cacheHitRate)", () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      setup(db, sqlite, dir)
      // assistant w/ usage, toolResult w/ usage, assistant w/o usage,
      // compaction w/ usage, branch_summary w/ usage, malformed usage field,
      // and a row whose data is not JSON at all.
      insertEntry(db, "a-1", "sess-1", 1, {
        type: "message",
        message: {
          role: "assistant",
          usage: usage({ input: 100, cost: { total: 2 } }),
        },
      })
      insertEntry(db, "a-1", "sess-1", 2, {
        type: "message",
        message: { role: "toolResult", usage: usage({ input: 7, output: 0 }) },
      })
      insertEntry(db, "a-1", "sess-1", 3, {
        type: "message",
        message: { role: "assistant" }, // no usage at all
      })
      insertEntry(db, "a-1", "sess-1", 4, {
        type: "compaction",
        usage: usage({ input: 50, reasoning: 1, cost: { total: 0.5 } }),
      })
      insertEntry(db, "a-1", "sess-1", 5, {
        type: "branch_summary",
        usage: usage({ input: 3, cost: { total: 0.1 } }),
      })
      insertEntry(db, "a-1", "sess-1", 6, {
        type: "message",
        message: { role: "assistant", usage: "garbage" }, // non-object usage
      })
      // The JS side skips malformed data; json_extract yields NULL (→ 0).
      db.insert(sessionEntries)
        .values({
          id: "parity-bad-json",
          sessionId: "sess-1",
          agentId: "a-1",
          seq: 7,
          type: "message",
          data: "{not json",
          createdAt: now(),
        })
        .run()

      const js = accumulateEntryUsage(readSessionEntries(db, scopeOf(db)))
      const totals = usageTotalsSql(db, scopeOf(db))
      const cacheHitRate = cacheHitRateSql(db, scopeOf(db))

      expect(totals.input).toBe(js.input)
      expect(totals.output).toBe(js.output)
      expect(totals.cacheRead).toBe(js.cacheRead)
      expect(totals.cacheWrite).toBe(js.cacheWrite)
      expect(totals.reasoning).toBe(js.reasoning)
      expect(totals.cost).toBe(js.cost)
      expect(totals.turns).toBe(js.turns)
      expect(totals.totalTokens).toBe(js.totalTokens)
      expect(cacheHitRate).toBe(js.cacheHitRate)
      // Sanity on the actual values (5 assistant/toolResult messages incl. the
      // garbage-usage one — turns counts assistant messages before the guard).
      expect(totals.turns).toBe(3)
      expect(totals.input).toBe(100 + 7 + 50 + 3)
    } finally {
      close()
    }
  })

  test("empty scope: SQL matches JS zeros; sumUsageTotals returns undefined", () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      setup(db, sqlite, dir)
      // A toolResult with zeroed usage: turns counts assistant messages only,
      // so turns=0 and every total is zero → sumUsageTotals stays undefined.
      insertEntry(db, "a-1", "sess-1", 1, {
        type: "message",
        message: {
          role: "toolResult",
          usage: usage({
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            reasoning: 0,
            cost: { total: 0 },
          }),
        },
      })

      const js = accumulateEntryUsage(readSessionEntries(db, scopeOf(db)))
      const totals = usageTotalsSql(db, scopeOf(db))
      const cacheHitRate = cacheHitRateSql(db, scopeOf(db))
      expect(totals.turns).toBe(js.turns)
      expect(totals.input).toBe(js.input)
      expect(totals.cost).toBe(js.cost)
      expect(totals.totalTokens).toBe(js.totalTokens)
      expect(cacheHitRate).toBe(js.cacheHitRate)
      expect(js.turns).toBe(0)
      // All-zero → the sumUsageTotals "nothing used → undefined" rule.
      expect(sumUsageTotals(db, scopeOf(db))).toBeUndefined()
    } finally {
      close()
    }
  })

  test("cacheHitRate reflects the LATEST assistant message with prompt tokens", () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      setup(db, sqlite, dir)
      insertEntry(db, "a-1", "sess-1", 1, {
        type: "message",
        message: {
          role: "assistant",
          usage: usage({ input: 100, cacheRead: 50, cacheWrite: 0 }), // 50% hit
        },
      })
      insertEntry(db, "a-1", "sess-1", 2, {
        type: "message",
        message: {
          role: "assistant",
          usage: usage({ input: 100, cacheRead: 25, cacheWrite: 0 }), // 25% hit
        },
      })
      // A later assistant with no prompt tokens must NOT overwrite the rate.
      insertEntry(db, "a-1", "sess-1", 3, {
        type: "message",
        message: {
          role: "assistant",
          usage: usage({ input: 0, cacheRead: 0, cacheWrite: 0 }),
        },
      })

      const js = accumulateEntryUsage(readSessionEntries(db, scopeOf(db)))
      const cacheHitRate = cacheHitRateSql(db, scopeOf(db))
      expect(cacheHitRate).toBe(js.cacheHitRate)
      // prompt = input + cacheRead + cacheWrite = 125 → 25/125 = 20%.
      expect(cacheHitRate).toBe(20)
    } finally {
      close()
    }
  })
})
