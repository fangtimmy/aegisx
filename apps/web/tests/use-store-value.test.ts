import { describe, expect, test } from "bun:test"

import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import type { EntryItem } from "@/api"
import { ConversationStore } from "@/stream/conversation-store"
import { useStoreValue } from "@/stream/use-store-value"

// The store batches notifications on rAF; the test env has no DOM, so shim it.
;(globalThis as { window?: unknown }).window ??= {
  requestAnimationFrame: (cb: () => void) =>
    setTimeout(cb, 0) as unknown as number,
  cancelAnimationFrame: (id: unknown) => clearTimeout(id as number),
}

function userItem(text: string, seq: number): EntryItem {
  return {
    seq,
    key: `u${seq}`,
    entry: {
      type: "message",
      id: `u${seq}`,
      timestamp: "2025-01-01T00:00:00Z",
      message: { role: "user", content: [{ type: "text", text }] },
    } as EntryItem["entry"],
  }
}

const store = new ConversationStore()
const selectItemCount = (view: ConversationStore, agentId: string) =>
  view.get(agentId).length

let latest = 0
function Probe({ agentId }: { agentId: string }) {
  latest = useStoreValue(store, agentId, selectItemCount)
  return null
}

function itemCount(agentId: string): number {
  renderToStaticMarkup(createElement(Probe, { agentId }))
  return latest
}

describe("useStoreValue", () => {
  test("reads the selected slice and re-reads after a store update", () => {
    expect(itemCount("a")).toBe(0)
    store.applySnapshot("a", [userItem("hi", 1)], 0)
    expect(itemCount("a")).toBe(1)
  })

  test("keys the snapshot by agentId", () => {
    expect(itemCount("b")).toBe(0)
    expect(itemCount("a")).toBe(1)
  })
})
