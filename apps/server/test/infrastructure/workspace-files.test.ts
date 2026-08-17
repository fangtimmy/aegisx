import { afterEach, describe, expect, test } from "bun:test"
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  readWorkspacePath,
  WorkspaceFileError,
  workspaceDownload,
} from "../../src/infrastructure/workspace-files"

const tempDirs: string[] = []

afterEach(() => {
  for (const path of tempDirs.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "aegisx-ws-"))
  tempDirs.push(root)
  return root
}

describe("readWorkspacePath traversal guards", () => {
  test("reads a text file by relative path", () => {
    const root = makeWorkspace()
    writeFileSync(join(root, "note.txt"), "hello")
    const result = readWorkspacePath(root, "note.txt")
    expect(result.type).toBe("text")
    if (result.type !== "text") return
    expect(result.content).toBe("hello")
    expect(result.path).toBe("note.txt")
  })

  test("rejects '..' escapes", () => {
    const root = makeWorkspace()
    expect(() => readWorkspacePath(root, "../outside")).toThrow(
      "File path is outside the run workspace"
    )
    expect(() => readWorkspacePath(root, "sub/../../outside")).toThrow(
      "File path is outside the run workspace"
    )
  })

  test("rejects absolute paths", () => {
    const root = makeWorkspace()
    expect(() => readWorkspacePath(root, "/etc/passwd")).toThrow(
      "File path is outside the run workspace"
    )
  })

  test("rejects NUL bytes", () => {
    const root = makeWorkspace()
    expect(() => readWorkspacePath(root, "a\0b")).toThrow(
      "File path is outside the run workspace"
    )
  })

  test("rejects a symlink escaping the workspace", () => {
    const root = makeWorkspace()
    const outside = mkdtempSync(join(tmpdir(), "aegisx-out-"))
    tempDirs.push(outside)
    writeFileSync(join(outside, "secret.txt"), "secret")
    symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"))
    expect(() => readWorkspacePath(root, "link.txt")).toThrow(
      "File path is outside the run workspace"
    )
  })

  test("rejects a /dev/fd symlink (fd redirection guard)", () => {
    const root = makeWorkspace()
    symlinkSync("/dev/fd/0", join(root, "fdlink"))
    expect(() => readWorkspacePath(root, "fdlink")).toThrow(
      "File path is outside the run workspace"
    )
  })

  test("allows traversal through a directory symlink that stays inside", () => {
    const root = makeWorkspace()
    mkdirSync(join(root, "real"))
    symlinkSync("real", join(root, "sub"))
    writeFileSync(join(root, "real", "note.txt"), "hi")
    const result = readWorkspacePath(root, "sub/note.txt")
    expect(result.type).toBe("text")
    if (result.type !== "text") return
    expect(result.content).toBe("hi")
  })

  test("rejects a directory symlink escaping the workspace", () => {
    const root = makeWorkspace()
    const outside = mkdtempSync(join(tmpdir(), "aegisx-out-"))
    tempDirs.push(outside)
    writeFileSync(join(outside, "secret.txt"), "secret")
    symlinkSync(outside, join(root, "sub"))
    expect(() => readWorkspacePath(root, "sub/secret.txt")).toThrow(
      "File path is outside the run workspace"
    )
  })

  test("refuses a final-component symlink even when it stays inside (O_NOFOLLOW)", () => {
    const root = makeWorkspace()
    writeFileSync(join(root, "real.txt"), "hi")
    symlinkSync("real.txt", join(root, "alias.txt"))
    // O_NOFOLLOW turns the open into ELOOP, surfaced as not_found.
    expect(() => readWorkspacePath(root, "alias.txt")).toThrow(
      "Workspace file not found"
    )
  })

  test("missing files are not_found", () => {
    const root = makeWorkspace()
    expect(() => readWorkspacePath(root, "nope.txt")).toThrow(
      "Workspace file not found"
    )
  })

  test("lists directories with dirs-first sorted entries", () => {
    const root = makeWorkspace()
    mkdirSync(join(root, "sub"))
    writeFileSync(join(root, "b.txt"), "b")
    writeFileSync(join(root, "a.txt"), "a")
    const result = readWorkspacePath(root, "")
    expect(result.type).toBe("directory")
    if (result.type !== "directory") return
    expect(result.entries.map((entry) => entry.name)).toEqual([
      "sub",
      "a.txt",
      "b.txt",
    ])
  })

  test("flags binary files", () => {
    const root = makeWorkspace()
    writeFileSync(join(root, "blob.bin"), Buffer.from([0, 1, 2, 0]))
    const result = readWorkspacePath(root, "blob.bin")
    expect(result.type).toBe("binary")
  })

  test("flags files over the preview cap as truncated", () => {
    const root = makeWorkspace()
    writeFileSync(join(root, "big.txt"), "x".repeat(1024 * 1024 + 10))
    const result = readWorkspacePath(root, "big.txt")
    expect(result.type).toBe("text")
    if (result.type !== "text") return
    expect(result.truncated).toBe(true)
    expect(result.content.length).toBeLessThanOrEqual(1024 * 1024)
  })
})

describe("workspaceDownload", () => {
  test("streams a file with its basename", async () => {
    const root = makeWorkspace()
    writeFileSync(join(root, "solve.py"), "print('x')")
    const download = workspaceDownload(root, "solve.py")
    expect(download.filename).toBe("solve.py")
    const bytes = new Uint8Array(
      await new Response(download.stream as unknown as BodyInit).arrayBuffer()
    )
    expect(new TextDecoder().decode(bytes)).toBe("print('x')")
  })

  test("rejects directories", () => {
    const root = makeWorkspace()
    mkdirSync(join(root, "sub"))
    expect(() => workspaceDownload(root, "sub")).toThrow("Path is not a file")
  })

  test("rejects traversal", () => {
    const root = makeWorkspace()
    expect(() => workspaceDownload(root, "../x")).toThrow(
      "File path is outside the run workspace"
    )
  })
})

describe("WorkspaceFileError codes", () => {
  test("carries the discriminating code", () => {
    const root = makeWorkspace()
    try {
      readWorkspacePath(root, "../x")
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspaceFileError)
      expect((error as WorkspaceFileError).code).toBe("invalid_path")
      return
    }
    throw new Error("expected a throw")
  })
})
