import { describe, expect, test } from "bun:test"
import { defaultSettings } from "../../../shared"
import { resolveToolTimeoutMs } from "./managed-tools"

describe("resolveToolTimeoutMs", () => {
  const settings = {
    ...defaultSettings(),
    "tools.defaultTimeoutMs": 60_000,
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
