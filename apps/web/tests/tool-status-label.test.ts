import { describe, expect, test } from "bun:test"
import {
  extractBashCommentLabel,
  toolStatusLabel,
  toolStatusParts,
} from "@/domain/conversation"
import { stripAnsi } from "@/features/runs/tool-render"

describe("toolStatusLabel", () => {
  test("uses filePath for read/write/edit", () => {
    expect(toolStatusLabel("read", { filePath: "src/exploit.py" }, false)).toBe(
      "Read src/exploit.py"
    )
    expect(
      toolStatusLabel(
        "edit",
        { filePath: "a/b/c.py", oldString: "x", newString: "y" },
        true
      )
    ).toBe("Editing a/b/c.py")
    expect(
      toolStatusLabel("write", { filePath: "out.txt", content: "hi" }, false)
    ).toBe("Wrote out.txt")
  })

  test("falls back to legacy path", () => {
    expect(toolStatusLabel("read", { path: "legacy.py" }, false)).toBe(
      "Read legacy.py"
    )
  })

  test("bash prefers comment label and marks background", () => {
    expect(
      toolStatusLabel(
        "bash",
        {
          command: "# probe target\ncurl -I http://x",
          background: true,
        },
        true
      )
    ).toBe("Background probe target")
    expect(toolStatusLabel("bash", { command: "echo hi" }, false)).toBe(
      "Ran echo hi"
    )
  })

  test("extractBashCommentLabel ignores shebang", () => {
    expect(extractBashCommentLabel("#!/bin/sh\necho hi")).toBeUndefined()
    expect(extractBashCommentLabel("# hello\necho hi")).toBe("hello")
  })

  test("path subjects keep full path in parts", () => {
    const parts = toolStatusParts(
      "read",
      { filePath: "very/long/path/to/file.py" },
      false
    )
    expect(parts.subjectKind).toBe("path")
    expect(parts.subject).toBe("very/long/path/to/file.py")
  })
})

describe("stripAnsi", () => {
  test("removes color codes", () => {
    expect(stripAnsi("\u001b[31mred\u001b[0m plain")).toBe("red plain")
  })
})
