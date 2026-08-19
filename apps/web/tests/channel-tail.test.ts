import { describe, expect, test } from "bun:test"

import type { ChannelMessagePublic } from "@/api"
import {
  appendChannelMessage,
  mergeChannelMessages,
} from "@/features/runs/channel-tail"

function message(id: number): ChannelMessagePublic {
  return {
    id,
    channelKey: "team:c1",
    authorType: "user",
    authorAgentId: null,
    authorName: "user",
    body: `m${id}`,
    meta: {},
    createdAt: "2025-01-01T00:00:00Z",
    files: [],
  }
}

describe("mergeChannelMessages", () => {
  test("appends new messages and drops duplicates by id", () => {
    const prev = [message(1), message(2)]
    const merged = mergeChannelMessages(prev, [message(2), message(3)])
    expect(merged.map((m) => m.id)).toEqual([1, 2, 3])
    // No-op merge returns the same reference so state updates stay cheap.
    expect(mergeChannelMessages(prev, [message(1)])).toBe(prev)
  })

  test("keeps ascending order when the initial HTTP window resolves late", () => {
    // The SSE snapshot pushed message 55 before the after=0 window arrived.
    const prev = [message(55)]
    const merged = mergeChannelMessages(prev, [
      message(51),
      message(55),
      message(60),
    ])
    expect(merged.map((m) => m.id)).toEqual([51, 55, 60])
  })
})

describe("appendChannelMessage", () => {
  test("seeds an empty cache entry and advances nextAfter", () => {
    const next = appendChannelMessage(undefined, message(7))
    expect(next.items.map((m) => m.id)).toEqual([7])
    expect(next.nextAfter).toBe(7)
    expect(next.hasMore).toBe(false)
  })

  test("ignores an already-present message but keeps the cursor monotonic", () => {
    const prev = {
      items: [message(3), message(5)],
      nextAfter: 5,
      hasMore: true,
    }
    const next = appendChannelMessage(prev, message(5))
    expect(next.items).toHaveLength(2)
    expect(next.nextAfter).toBe(5)
    expect(next.hasMore).toBe(true)

    const advanced = appendChannelMessage(next, message(9))
    expect(advanced.items.map((m) => m.id)).toEqual([3, 5, 9])
    expect(advanced.nextAfter).toBe(9)
    expect(advanced.hasMore).toBe(true)
  })
})
