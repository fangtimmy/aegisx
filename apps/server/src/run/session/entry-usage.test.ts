import { describe, expect, test } from "bun:test"
import type { SessionEntry } from "@earendil-works/pi-coding-agent"
import { accumulateEntryUsage, entryUsageOf } from "./entry-usage"

/**
 * Parity anchor for `accumulateEntryUsage` / `entryUsageOf`.
 *
 * These mirror pi's usage accumulation, which lives in two non-public spots:
 *   - pi-TUI footer: modes/interactive/components/footer.js (token/cost +
 *     cache-hit rate over ALL session entries)
 *   - AgentSession.getSessionStats(): core/agent-session.js (turn count + total
 *     formula = input + output + cacheRead + cacheWrite)
 * The package `exports` map blocks deep imports of `core/usage-totals.js`, so
 * the helper is mirrored in entry-usage.ts. On a pi upgrade, cross-check those
 * two files against the assertions here — they are the source of truth this
 * must track.
 *
 * Fixtures cast partial objects to SessionEntry because the accumulator is
 * structural (reads only type / message.role / message.usage / entry.usage).
 */

type UsageShape = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning?: number
  totalTokens: number
  cost: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    total: number
  }
}

function usage(over: Partial<UsageShape> = {}): UsageShape {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    ...over,
  }
}

let n = 0
const id = (p: string) => {
  n += 1
  return `${p}-${n}`
}
const ts = () => new Date().toISOString()

function assistant(u: UsageShape): SessionEntry {
  return {
    type: "message",
    id: id("a"),
    parentId: null,
    timestamp: ts(),
    message: { role: "assistant", usage: u },
  } as unknown as SessionEntry
}

/** An assistant message with no usage (aborted/error) — still a turn. */
function assistantNoUsage(): SessionEntry {
  return {
    type: "message",
    id: id("a"),
    parentId: null,
    timestamp: ts(),
    message: { role: "assistant" },
  } as unknown as SessionEntry
}

function toolResult(u: UsageShape): SessionEntry {
  return {
    type: "message",
    id: id("t"),
    parentId: null,
    timestamp: ts(),
    message: {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "bash",
      usage: u,
    },
  } as unknown as SessionEntry
}

function user(): SessionEntry {
  return {
    type: "message",
    id: id("u"),
    parentId: null,
    timestamp: ts(),
    message: { role: "user", content: "hi" },
  } as unknown as SessionEntry
}

function compaction(u: UsageShape): SessionEntry {
  return {
    type: "compaction",
    id: id("c"),
    parentId: null,
    timestamp: ts(),
    summary: "s",
    firstKeptEntryId: "k",
    tokensBefore: 1000,
    usage: u,
  } as unknown as SessionEntry
}

function branchSummary(u: UsageShape): SessionEntry {
  return {
    type: "branch_summary",
    id: id("b"),
    parentId: null,
    timestamp: ts(),
    fromId: "root",
    summary: "s",
    usage: u,
  } as unknown as SessionEntry
}

function custom(): SessionEntry {
  return {
    type: "custom",
    id: id("x"),
    parentId: null,
    timestamp: ts(),
    customType: "thing",
    data: { foo: 1 },
  } as unknown as SessionEntry
}

describe("entryUsageOf", () => {
  test("returns usage only for assistant / toolResult messages + compaction / branch_summary", () => {
    expect(entryUsageOf(assistant(usage()))).toBeDefined()
    expect(entryUsageOf(toolResult(usage()))).toBeDefined()
    expect(entryUsageOf(compaction(usage()))).toBeDefined()
    expect(entryUsageOf(branchSummary(usage()))).toBeDefined()
    // user / custom / custom_message carry no usage.
    expect(entryUsageOf(user())).toBeUndefined()
    expect(entryUsageOf(custom())).toBeUndefined()
  })

  test("toolResult without usage yields undefined", () => {
    const noUsage = {
      type: "message",
      id: "t",
      parentId: null,
      timestamp: ts(),
      message: { role: "toolResult", toolCallId: "c", toolName: "bash" },
    } as unknown as SessionEntry
    expect(entryUsageOf(noUsage)).toBeUndefined()
  })
})

describe("accumulateEntryUsage", () => {
  test("folds assistant + toolResult + compaction + branch_summary usage", () => {
    const entries = [
      user(),
      assistant(
        usage({
          input: 100,
          output: 50,
          cacheRead: 200,
          cacheWrite: 10,
          reasoning: 20,
          // Bogus: must be IGNORED — total uses the pi formula, not this field.
          totalTokens: 999,
          cost: { ...usage().cost, total: 0.01 },
        })
      ),
      toolResult(
        usage({ input: 10, output: 5, cost: { ...usage().cost, total: 0.002 } })
      ),
      compaction(
        usage({
          input: 500,
          output: 100,
          cost: { ...usage().cost, total: 0.05 },
        })
      ),
      branchSummary(
        usage({ input: 50, output: 20, cost: { ...usage().cost, total: 0.01 } })
      ),
      custom(),
    ]
    const totals = accumulateEntryUsage(entries)

    expect(totals.input).toBe(100 + 10 + 500 + 50) // 660
    expect(totals.output).toBe(50 + 5 + 100 + 20) // 175
    expect(totals.cacheRead).toBe(200)
    expect(totals.cacheWrite).toBe(10)
    expect(totals.reasoning).toBe(20)
    expect(totals.cost).toBeCloseTo(0.01 + 0.002 + 0.05 + 0.01, 5)
    // pi getSessionStats total = input + output + cacheRead + cacheWrite.
    expect(totals.totalTokens).toBe(660 + 175 + 200 + 10) // 1045, NOT 999
  })

  test("counts every assistant message as a turn, including ones without usage", () => {
    const totals = accumulateEntryUsage([
      assistant(usage()),
      assistantNoUsage(), // aborted/error: no usage, still a turn
      user(),
      toolResult(usage()),
    ])
    expect(totals.turns).toBe(2)
  })

  test("cacheHitRate is the latest assistant-with-usage rate (cacheRead / prompt * 100)", () => {
    const totals = accumulateEntryUsage([
      assistant(usage({ input: 100, cacheRead: 200, cacheWrite: 10 })),
      assistantNoUsage(), // no usage → does not overwrite the rate
    ])
    // 200 / (100 + 200 + 10) * 100
    expect(totals.cacheHitRate).toBeCloseTo((200 / 310) * 100, 5)
  })

  test("cacheHitRate is null when no assistant reported usage", () => {
    const totals = accumulateEntryUsage([
      assistantNoUsage(),
      user(),
      toolResult(usage()),
    ])
    expect(totals.cacheHitRate).toBeNull()
    expect(totals.turns).toBe(1)
  })

  test("totalTokens is the pi formula even when usage.totalTokens disagrees", () => {
    const totals = accumulateEntryUsage([
      assistant(
        usage({
          input: 1,
          output: 2,
          cacheRead: 3,
          cacheWrite: 4,
          totalTokens: 9999,
        })
      ),
    ])
    expect(totals.totalTokens).toBe(1 + 2 + 3 + 4) // 10, ignores 9999
  })

  test("empty / no-usage entries yield zero totals and null cacheHitRate", () => {
    const totals = accumulateEntryUsage([user(), custom()])
    expect(totals.input).toBe(0)
    expect(totals.totalTokens).toBe(0)
    expect(totals.cost).toBe(0)
    expect(totals.turns).toBe(0)
    expect(totals.cacheHitRate).toBeNull()
  })
})
