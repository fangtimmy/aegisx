import { describe, expect, test } from "bun:test"
import { resolveToolTimeoutMs } from "./managed-tools"

describe("resolveToolTimeoutMs", () => {
  const settings = {
    defaultToolTimeoutMs: 60_000,
    toolTimeouts: {} as Record<string, number>,
  }

  test("bash timeout seconds map to ms with slack", () => {
    expect(
      resolveToolTimeoutMs("bash", { command: "x", timeout: 2 }, settings)
    ).toBe(3000)
  })

  test("bash background uses short spawn budget", () => {
    expect(
      resolveToolTimeoutMs(
        "bash",
        { command: "x", background: true, timeout: 3600 },
        settings
      )
    ).toBe(15_000)
  })
})
