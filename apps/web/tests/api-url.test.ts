import { describe, expect, test } from "bun:test"

import { apiUrl } from "@/api/client"

describe("apiUrl", () => {
  test("prefixes the API mount exactly once", () => {
    expect(apiUrl("/settings")).toBe("/api/settings")
    expect(apiUrl("/events/e1/stats")).toBe("/api/events/e1/stats")
    expect(apiUrl("/providers/p1/test")).toBe("/api/providers/p1/test")
  })
})
