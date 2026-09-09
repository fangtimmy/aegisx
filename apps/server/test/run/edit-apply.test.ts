import { describe, expect, test } from "bun:test"

import type { WorkspaceBackend } from "../../src/run/workspace/backend"
import { applyExactEdit } from "../../src/run/workspace/edit-apply"
import { createWorkspaceTools } from "../../src/run/workspace/tools"
import { refine } from "../support"

describe("applyExactEdit", () => {
  test("single exact match is replaced; content and diff are exact", () => {
    const result = applyExactEdit(
      "function hello() {\n  return 1;\n}\n",
      "src/app.ts",
      "  return 1;",
      "  return 42;"
    )
    expect(result.content).toBe("function hello() {\n  return 42;\n}\n")
    expect(result.replacements).toBe(1)
    expect(result.usedFuzzyMatch).toBe(false)
    expect(result.diff).toBe(
      [
        "--- a/src/app.ts",
        "+++ b/src/app.ts",
        "@@ -2,1 +2,1 @@ 1 replacement",
        "-  return 1;",
        "+  return 42;",
      ].join("\n")
    )
  })

  test("multiple occurrences are rejected; replaceAll replaces every one", () => {
    const original = "foo\nbar\nfoo\n"
    expect(() => applyExactEdit(original, "notes.txt", "foo", "baz")).toThrow(
      "Found 2 matches for oldString in notes.txt. Provide more surrounding lines to identify the correct match, or set replaceAll: true."
    )
    const result = applyExactEdit(original, "notes.txt", "foo", "baz", true)
    expect(result.content).toBe("baz\nbar\nbaz\n")
    expect(result.replacements).toBe(2)
  })

  test("no match at all is the documented not-found failure", () => {
    expect(() => applyExactEdit("a\nb\n", "notes.txt", "missing", "x")).toThrow(
      "oldString not found in content of notes.txt. Tried exact match and fuzzy match (smart quotes, dashes, trailing whitespace). Provide more surrounding context."
    )
  })

  describe("line-ending normalization", () => {
    test("CRLF file + LF search: matches after normalization, output keeps CRLF", () => {
      const result = applyExactEdit(
        "first\r\nsecond\r\n",
        "win.txt",
        "first\nsecond",
        "first\nchanged"
      )
      expect(result.content).toBe("first\r\nchanged\r\n")
      expect(result.replacements).toBe(1)
      expect(result.usedFuzzyMatch).toBe(false)
    })

    test("CRLF file + CRLF search: same normalized path", () => {
      const result = applyExactEdit(
        "first\r\nsecond\r\n",
        "win.txt",
        "first\r\nsecond",
        "x"
      )
      expect(result.content).toBe("x\r\n")
    })

    test("LF file + CRLF search: output keeps LF", () => {
      const result = applyExactEdit(
        "first\nsecond\n",
        "unix.txt",
        "first\r\nsecond",
        "changed\r\nsecond"
      )
      expect(result.content).toBe("changed\nsecond\n")
      expect(result.usedFuzzyMatch).toBe(false)
    })
  })

  test("BOM is stripped for matching and preserved on output", () => {
    const result = applyExactEdit(
      "\uFEFFname,value\na,b\n",
      "data.csv",
      "name,value",
      "name;value"
    )
    expect(result.content).toBe("\uFEFFname;value\na,b\n")
    expect(result.replacements).toBe(1)
  })

  describe("fuzzy fallback", () => {
    test("trailing-whitespace mismatch matches once and replaces the original span", () => {
      const result = applyExactEdit(
        "hello   \nworld\n",
        "fuzz.txt",
        "hello\nworld",
        "hi\nworld"
      )
      expect(result.usedFuzzyMatch).toBe(true)
      expect(result.content).toBe("hi\nworld\n")
      expect(result.replacements).toBe(1)
    })

    test("smart quotes are canonicalized before matching", () => {
      const result = applyExactEdit(
        "it’s broken\n",
        "fuzz.txt",
        "it's broken",
        "it's fixed"
      )
      expect(result.usedFuzzyMatch).toBe(true)
      expect(result.content).toBe("it's fixed\n")
    })

    test("two fuzzy candidates are rejected", () => {
      const original = "alpha \nb\nmid\nalpha \nb\n"
      expect(() =>
        applyExactEdit(original, "fuzz.txt", "alpha\nb", "x")
      ).toThrow(
        "Found 2 fuzzy matches for oldString in fuzz.txt. Provide more surrounding lines to identify the correct match, or set replaceAll: true."
      )
    })

    test("a fuzzy match whose replacement is identical reports no-op instead of writing", () => {
      // "ab " normalizes to "ab", which then replaces the span "ab" with
      // itself — the guard must catch it, not silently "succeed".
      expect(() => applyExactEdit("ab\ncd", "f.txt", "ab ", "ab")).toThrow(
        "No changes made to f.txt. The replacement produced identical content."
      )
    })
  })

  test("CJK content round-trips uncorrupted", () => {
    const result = applyExactEdit(
      "标题：机密信息\n其他内容\n",
      "报告.md",
      "机密信息",
      "公开资料"
    )
    expect(result.content).toBe("标题：公开资料\n其他内容\n")
    expect(result.replacements).toBe(1)
    expect(result.usedFuzzyMatch).toBe(false)
  })

  describe("empty-string contract", () => {
    test("empty newString deletes the matched span", () => {
      const result = applyExactEdit(
        "keep\nremove-me\nafter\n",
        "notes.txt",
        "remove-me\n",
        ""
      )
      expect(result.content).toBe("keep\nafter\n")
      expect(result.replacements).toBe(1)
    })

    test("empty oldString is rejected", () => {
      expect(() => applyExactEdit("abc", "f.txt", "", "x")).toThrow(
        "oldString must not be empty in f.txt."
      )
    })

    test("identical oldString/newString is rejected before any matching", () => {
      expect(() => applyExactEdit("abc", "f.txt", "same", "same")).toThrow(
        "No changes to apply: oldString and newString are identical."
      )
      // The identical check fires before the empty check.
      expect(() => applyExactEdit("abc", "f.txt", "", "")).toThrow(
        "No changes to apply: oldString and newString are identical."
      )
    })
  })
})

/** In-memory WorkspaceBackend: read serves the current content, write
 * records it — enough to observe what the edit tool persists. */
function memoryBackend(initial: string) {
  const state = { content: initial, writes: 0 }
  const stub = {
    cwd: "/workspace",
    resolvePath: (p: string) => `/workspace/${p}`,
    async read() {
      const data = new TextEncoder().encode(state.content)
      return { data, truncated: false, totalBytes: data.byteLength }
    },
    async write(_path: string, content: string) {
      state.writes += 1
      state.content = content
    },
    async list() {
      return []
    },
  }
  return { backend: refine<WorkspaceBackend>(stub), state }
}

async function runEdit(
  backend: WorkspaceBackend,
  params: {
    filePath: string
    oldString: string
    newString: string
    replaceAll?: boolean
  }
) {
  const [, , edit] = createWorkspaceTools(backend)
  if (!edit) throw new Error("edit tool missing")
  return edit.execute(
    "t1",
    params,
    new AbortController().signal,
    undefined,
    refine(undefined)
  )
}

describe("edit tool wiring", () => {
  test("params flow through applyExactEdit and the result is written back", async () => {
    const { backend, state } = memoryBackend("alpha\nbeta\n")
    const result = await runEdit(backend, {
      filePath: "notes.txt",
      oldString: "beta",
      newString: "beta!",
    })
    expect(state.content).toBe("alpha\nbeta!\n")
    expect(state.writes).toBe(1)
    expect(result.details).toMatchObject({
      filePath: "notes.txt",
      replacements: 1,
      usedFuzzyMatch: false,
    })
    expect(refine<{ text: string }>(result.content[0]).text).toBe(
      [
        "--- a/notes.txt",
        "+++ b/notes.txt",
        "@@ -2,1 +2,1 @@ 1 replacement",
        "-beta",
        "+beta!",
      ].join("\n")
    )
  })

  test("replaceAll param passes through", async () => {
    const { backend, state } = memoryBackend("dup\ndup\n")
    const result = await runEdit(backend, {
      filePath: "notes.txt",
      oldString: "dup",
      newString: "uniq",
      replaceAll: true,
    })
    expect(state.content).toBe("uniq\nuniq\n")
    expect(result.details).toMatchObject({ replacements: 2 })
  })

  test("apply failure propagates and nothing is written", async () => {
    const { backend, state } = memoryBackend("foo\nbar\nfoo\n")
    await expect(
      runEdit(backend, {
        filePath: "notes.txt",
        oldString: "foo",
        newString: "baz",
      })
    ).rejects.toThrow(
      "Found 2 matches for oldString in notes.txt. Provide more surrounding lines to identify the correct match, or set replaceAll: true."
    )
    expect(state.content).toBe("foo\nbar\nfoo\n")
    expect(state.writes).toBe(0)
  })
})
