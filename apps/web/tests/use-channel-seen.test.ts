import { describe, expect, test } from "bun:test"

import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { useChannelSeen } from "@/features/runs/use-channel-seen"

// The test env has no DOM storage (mirrors the window shim in
// conversation-store.test.ts): a Map-backed localStorage stands in. The
// store reads it lazily, so installing the shim after import is fine.
const storage = new Map<string, string>()
;(globalThis as Record<string, unknown>).localStorage ??= {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => {
    storage.set(key, value)
  },
}

const T0 = "2026-01-01T00:00:00.000Z"
const T1 = "2026-01-01T00:05:00.000Z"

type Seen = ReturnType<typeof useChannelSeen>

let latest: Seen | undefined
function Probe() {
  latest = useChannelSeen()
  return null
}

/** Each render is an independent hook consumer (surface) over the shared
   module store — the two-badge setup the store must keep in agreement. */
function render(): Seen {
  renderToStaticMarkup(createElement(Probe))
  return latest!
}

describe("useChannelSeen", () => {
  test("unread flips on markSeen (new message unread, viewing clears it)", () => {
    const first = render()
    // No marker yet: first sighting — the backlog never counts as unread.
    expect(first.isUnread({ key: "team:flip", lastMessageAt: null })).toBe(
      false
    )
    expect(first.isUnread({ key: "team:flip", lastMessageAt: T0 })).toBe(false)

    first.markSeen({ key: "team:flip", lastMessageAt: T0 })
    const seen = render()
    // A newer message on a seen channel is unread...
    expect(seen.isUnread({ key: "team:flip", lastMessageAt: T1 })).toBe(true)
    // ...and entering the channel clears it.
    seen.markSeen({ key: "team:flip", lastMessageAt: T1 })
    expect(render().isUnread({ key: "team:flip", lastMessageAt: T1 })).toBe(
      false
    )
  })

  test("markers persist across store instances and into localStorage", () => {
    render().markSeen({ key: "dm:persist", lastMessageAt: T0 })
    const stored: unknown = JSON.parse(
      localStorage.getItem("aegisx:channel-seen")!
    )
    expect(stored).toMatchObject({ "dm:persist": Date.parse(T0) })

    // The other surface (fresh consumer instance) reads the same marker:
    // seen at T0, unread once the server reports newer activity.
    const other = render()
    expect(other.isUnread({ key: "dm:persist", lastMessageAt: T0 })).toBe(false)
    expect(other.isUnread({ key: "dm:persist", lastMessageAt: T1 })).toBe(true)
  })
})
