import { expect, test } from "bun:test"
import { normalizePreviewCode } from "../src/components/code-preview"

test("strips read-tool line prefixes and keeps footer", () => {
  const input =
    "10: def add(a, b):\n11:     return a + b\n\nShowing lines 10-11 of 40."
  const result = normalizePreviewCode(input)
  expect(result.startLine).toBe(10)
  expect(result.code).toBe("def add(a, b):\n    return a + b")
  expect(result.footer).toContain("Showing lines")
})

test("leaves normal code unchanged", () => {
  const input = "def add(a, b):\n    return a + b\n"
  const result = normalizePreviewCode(input)
  expect(result.startLine).toBe(1)
  expect(result.code).toBe(input)
  expect(result.footer).toBe("")
})
