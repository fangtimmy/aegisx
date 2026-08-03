import { describe, expect, test } from "bun:test"
import { execTimeoutMs } from "../../src/run/container-manager"

/**
 * Regression guard for the seconds→ms timeout contract. exec/capture receive a
 * timeout in seconds (bash tool schema / workspace file tools) and must hand
 * milliseconds to setTimeout. Before this helper existed the seconds value was
 * passed straight to setTimeout, so a 30s timeout fired at 30ms and every
 * "timed-out" bash call came back as "(no output)".
 */
describe("execTimeoutMs", () => {
  test("converts seconds to milliseconds", () => {
    expect(execTimeoutMs(1)).toBe(1000)
    expect(execTimeoutMs(10)).toBe(10_000)
    expect(execTimeoutMs(30)).toBe(30_000)
    expect(execTimeoutMs(120)).toBe(120_000)
  })

  test("returns undefined when no timeout applies", () => {
    expect(execTimeoutMs(undefined)).toBeUndefined()
    expect(execTimeoutMs(0)).toBeUndefined()
    expect(execTimeoutMs(-5)).toBeUndefined()
    expect(execTimeoutMs(NaN)).toBeUndefined()
  })
})
