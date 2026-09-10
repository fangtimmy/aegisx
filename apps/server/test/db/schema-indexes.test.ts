import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createDatabase } from "../../src/db/index"
import { agents, events } from "../../src/db/schema"

/** Insert payload with only the token varying — every other column is the
 * minimum the NOT NULL/FK surface requires (events row seeded per test). */
function agentRow(id: string, token: string) {
  return {
    id,
    token,
    eventId: "evt-1",
    role: "solver" as const,
    model: "m",
    systemPrompt: "",
    tools: "[]",
    status: "idle" as const,
    createdAt: "t",
    updatedAt: "t",
  }
}

describe("agents.token index", () => {
  test("agent-auth token lookups use the partial unique index, not a table scan", () => {
    const dir = mkdtempSync(join(tmpdir(), "aegisx-idx-"))
    try {
      const { sqlite, releaseLock } = createDatabase(dir)
      // The exact predicate shape agent-auth resolves principals with (the
      // token != '' term is required — SQLite will not use a partial index
      // unless the query itself implies its WHERE clause).
      const plan = sqlite
        .query<{ detail: string }, []>(
          `EXPLAIN QUERY PLAN SELECT id FROM agents WHERE "agents"."token" = 'x' AND "agents"."token" != ''`
        )
        .all()
        .map((row) => row.detail)
        .join("\n")
      expect(plan).toContain("agents_token_unique")
      expect(plan).not.toContain("SCAN agents")
      sqlite.close()
      releaseLock()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("duplicate non-empty tokens conflict; the '' default does not", () => {
    const dir = mkdtempSync(join(tmpdir(), "aegisx-idx-dup-"))
    try {
      const { db, sqlite, releaseLock } = createDatabase(dir)
      db.insert(events)
        .values({ id: "evt-1", name: "e", createdAt: "t", updatedAt: "t" })
        .run()
      db.insert(agents).values(agentRow("a-1", "shared-token")).run()
      expect(() =>
        db.insert(agents).values(agentRow("a-2", "shared-token")).run()
      ).toThrow(/UNIQUE/i)
      // Partial index: any number of rows may sit on the column default.
      db.insert(agents).values(agentRow("a-3", "")).run()
      db.insert(agents).values(agentRow("a-4", "")).run()
      expect(
        sqlite
          .query<{ n: number }, []>("SELECT count(*) AS n FROM agents")
          .get()?.n
      ).toBe(3)
      sqlite.close()
      releaseLock()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
