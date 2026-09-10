import { describe, expect, test } from "bun:test"

import type { SessionEntry } from "@earendil-works/pi-coding-agent"
import { eq, sql, type SQL } from "drizzle-orm"

import { sessionEntries, sessions } from "../../src/db/schema"
import { parseJson } from "../../src/lib/guards"
import {
  accumulateEntryUsage,
  type EntryUsage,
} from "../../src/run/host/entry-usage"
import {
  roleField,
  sumUsageTotals,
  usageField,
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

/** Insert a session entry with a given type + data (JSON), keeping the row's
 * `type` column and the entry's own `type` consistent (SQL reads the column,
 * the JS reader reads the JSON). */
function insertEntry(
  db: Db,
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

/** JS side of the parity: parse committed `data` rows, skipping malformed
 * ones (rows are typed at commit time by DbSessionManager; the parse only
 * guards against corrupt/truncated rows). */
function readEntries(db: Db, where: SQL): SessionEntry[] {
  const rows = db
    .select({ data: sessionEntries.data })
    .from(sessionEntries)
    .where(where)
    .all()
  const entries: SessionEntry[] = []
  for (const row of rows) {
    try {
      entries.push(parseJson<SessionEntry>(row.data))
    } catch {
      // skip malformed
    }
  }
  return entries
}

/** One guarded usage-field sum — structural replica of events/stats.ts's
 * `sumUsageField` (the sessionEntries JSON1 aggregation event stats actually
 * run). The JSON1 extractors are imported from production (session-queries);
 * if this CASE drifts from stats.ts, event stats drift from the JS totals. */
const statsSumField = (msgPath: string, entryPath: string) => sql<number>`
    SUM(
      CASE
        WHEN ${sessionEntries.type} IN ('compaction', 'branch_summary')
          THEN ${usageField(entryPath)}
        WHEN ${sessionEntries.type} = 'message'
          AND ${roleField} IN ('assistant', 'toolResult')
          THEN ${usageField(msgPath)}
        ELSE 0
      END
    )
  `

/** stats.ts-shaped one-pass aggregate over a scope. */
function statsUsageTotals(db: Db, where: SQL) {
  return db
    .select({
      input: statsSumField("$.message.usage.input", "$.usage.input"),
      output: statsSumField("$.message.usage.output", "$.usage.output"),
      cacheRead: statsSumField(
        "$.message.usage.cacheRead",
        "$.usage.cacheRead"
      ),
      cacheWrite: statsSumField(
        "$.message.usage.cacheWrite",
        "$.usage.cacheWrite"
      ),
      reasoning: statsSumField(
        "$.message.usage.reasoning",
        "$.usage.reasoning"
      ),
      cost: statsSumField("$.message.usage.cost.total", "$.usage.cost.total"),
      turns: sql<number>`SUM(CASE WHEN ${sessionEntries.type} = 'message' AND ${roleField} = 'assistant' THEN 1 ELSE 0 END)`,
    })
    .from(sessionEntries)
    .where(where)
    .get()
}

function setup(
  db: Db,
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

const scopeOf = (_db: Db) => eq(sessionEntries.agentId, "a-1")

describe("usage aggregation SQL/JS parity", () => {
  test("mixed entry mix aggregates identically (tokens, cost, turns)", () => {
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

      const js = accumulateEntryUsage(readEntries(db, scopeOf(db)))
      const stats = statsUsageTotals(db, scopeOf(db))
      const totals = usageTotalsSql(db, scopeOf(db))

      expect(stats?.input).toBe(js.input)
      expect(stats?.output).toBe(js.output)
      expect(stats?.cacheRead).toBe(js.cacheRead)
      expect(stats?.cacheWrite).toBe(js.cacheWrite)
      expect(stats?.reasoning).toBe(js.reasoning)
      expect(stats?.cost).toBe(js.cost)
      expect(stats?.turns).toBe(js.turns)
      // The per-agent/run aggregate (usageTotalsSql, the billing + overview
      // path) must agree with both.
      expect(totals.input).toBe(js.input)
      expect(totals.output).toBe(js.output)
      expect(totals.cacheRead).toBe(js.cacheRead)
      expect(totals.cacheWrite).toBe(js.cacheWrite)
      expect(totals.reasoning).toBe(js.reasoning)
      expect(totals.cost).toBe(js.cost)
      expect(totals.turns).toBe(js.turns)
      expect(totals.totalTokens).toBe(js.totalTokens)
      // Sanity on the actual values (3 assistant messages incl. the
      // garbage-usage one — turns counts assistant messages before the guard).
      expect(js.turns).toBe(3)
      expect(js.input).toBe(100 + 7 + 50 + 3)
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

      const js = accumulateEntryUsage(readEntries(db, scopeOf(db)))
      const stats = statsUsageTotals(db, scopeOf(db))
      const totals = usageTotalsSql(db, scopeOf(db))
      expect(stats?.turns).toBe(js.turns)
      expect(stats?.input).toBe(js.input)
      expect(stats?.cost).toBe(js.cost)
      expect(totals.turns).toBe(js.turns)
      expect(totals.totalTokens).toBe(js.totalTokens)
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

      // Pure-JS behavior guard: the accumulator's rate feeds the live context
      // snapshot (event-pipeline) — latest assistant WITH prompt tokens wins.
      const js = accumulateEntryUsage(readEntries(db, scopeOf(db)))
      // prompt = input + cacheRead + cacheWrite = 125 → 25/125 = 20%.
      expect(js.cacheHitRate).toBe(20)
    } finally {
      close()
    }
  })
})
