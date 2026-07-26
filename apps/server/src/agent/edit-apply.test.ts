import { describe, expect, test } from "bun:test"
import { applyExactEdit } from "./edit-apply"

describe("applyExactEdit", () => {
  test("replaces a unique occurrence", () => {
    const result = applyExactEdit(
      "alpha\nbeta\ngamma\n",
      "f.txt",
      "beta",
      "BETA"
    )
    expect(result.content).toBe("alpha\nBETA\ngamma\n")
    expect(result.replacements).toBe(1)
    expect(result.diff).toContain("-beta")
    expect(result.diff).toContain("+BETA")
    expect(result.diff).toContain("@@ -2,1 +2,1 @@")
  })

  test("fails when oldString is not unique without replaceAll", () => {
    expect(() => applyExactEdit("x y x", "f.txt", "x", "z")).toThrow(
      /Found 2 matches/
    )
  })

  test("replaceAll replaces every occurrence", () => {
    const result = applyExactEdit("x y x", "f.txt", "x", "z", true)
    expect(result.content).toBe("z y z")
    expect(result.replacements).toBe(2)
  })

  test("fails when not found", () => {
    expect(() => applyExactEdit("hello", "f.txt", "missing", "x")).toThrow(
      /not found/
    )
  })

  test("fails when oldString equals newString", () => {
    expect(() => applyExactEdit("hello", "f.txt", "hello", "hello")).toThrow(
      /identical/
    )
  })

  test("preserves CRLF line endings", () => {
    const result = applyExactEdit("a\r\nb\r\n", "f.txt", "b", "B")
    expect(result.content).toBe("a\r\nB\r\n")
  })

  test("fuzzy-matches smart quotes", () => {
    const result = applyExactEdit(
      "say \u201Chello\u201D now\n",
      "f.txt",
      'say "hello" now',
      "say hi now"
    )
    expect(result.content).toBe("say hi now\n")
    expect(result.usedFuzzyMatch).toBe(true)
  })

  test("fuzzy-matches trailing whitespace on lines", () => {
    const result = applyExactEdit(
      "alpha  \nbeta\n",
      "f.txt",
      "alpha\nbeta",
      "ALPHA\nBETA"
    )
    expect(result.content).toBe("ALPHA\nBETA\n")
    expect(result.usedFuzzyMatch).toBe(true)
  })
})
