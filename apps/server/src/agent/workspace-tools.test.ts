import { afterEach, describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createLocalBackend, createWorkspaceTools } from "./tools"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "aegisx-ws-"))
  roots.push(root)
  const tools = createWorkspaceTools(createLocalBackend(root))
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]))
  return { root, byName }
}

describe("workspace tools", () => {
  test("read numbers lines and paginates", async () => {
    const { root, byName } = workspace()
    writeFileSync(join(root, "a.txt"), "one\ntwo\nthree\nfour\n")
    const page = await byName.read.execute("r1", {
      filePath: "a.txt",
      offset: 2,
      limit: 2,
    })
    const text = page.content.find((part) => part.type === "text")?.text ?? ""
    expect(text).toContain("2: two")
    expect(text).toContain("3: three")
    expect(text).toContain("offset=4")
  })

  test("read reports image path without attaching bytes", async () => {
    const { root, byName } = workspace()
    // minimal PNG header
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00,
    ])
    writeFileSync(join(root, "x.png"), png)
    const result = await byName.read.execute("r2", { filePath: "x.png" })
    const text = result.content.find((part) => part.type === "text")?.text ?? ""
    expect(text).toContain("Image file: x.png")
    expect(text).toContain("image/png")
    expect(result.content.some((part) => part.type === "image")).toBe(false)
  })

  test("edit enforces uniqueness and returns diff", async () => {
    const { root, byName } = workspace()
    writeFileSync(join(root, "e.txt"), "aa bb aa\n")
    await expect(
      byName.edit.execute("e1", {
        filePath: "e.txt",
        oldString: "aa",
        newString: "AA",
      })
    ).rejects.toThrow(/Found 2 matches/)

    const ok = await byName.edit.execute("e2", {
      filePath: "e.txt",
      oldString: "aa",
      newString: "AA",
      replaceAll: true,
    })
    expect(readFileSync(join(root, "e.txt"), "utf8")).toBe("AA bb AA\n")
    expect(ok.details).toMatchObject({ replacements: 2, replaceAll: true })
    const text = ok.content.find((part) => part.type === "text")?.text ?? ""
    expect(text).toContain("-aa")
    expect(text).toContain("+AA")
  })

  test("write uses filePath", async () => {
    const { root, byName } = workspace()
    await byName.write.execute("w1", {
      filePath: "out.txt",
      content: "hello",
    })
    expect(readFileSync(join(root, "out.txt"), "utf8")).toBe("hello")
  })

  test("grep uses rg and defaults to files_with_matches", async () => {
    const { root, byName } = workspace()
    writeFileSync(join(root, "g.txt"), "needle here\n")
    const result = await byName.grep.execute("g1", { pattern: "needle" })
    const text = result.content.find((part) => part.type === "text")?.text ?? ""
    expect(text).toContain("g.txt")
    expect(text).not.toContain("needle here")
    expect(result.details).toMatchObject({
      outputMode: "files_with_matches",
    })

    const content = await byName.grep.execute("g2", {
      pattern: "needle",
      outputMode: "content",
    })
    const contentText =
      content.content.find((part) => part.type === "text")?.text ?? ""
    expect(contentText).toContain("needle here")
  })

  test("find uses fd when available", async () => {
    const check = Bun.spawnSync({
      cmd: ["sh", "-lc", "command -v fd || command -v fdfind"],
      stdout: "pipe",
      stderr: "pipe",
    })
    if (check.exitCode !== 0) {
      // Host without fd: tool must error clearly (no JS fallback).
      const { root, byName } = workspace()
      writeFileSync(join(root, "f.txt"), "x")
      await expect(
        byName.find.execute("f1", { pattern: "*.txt" })
      ).rejects.toThrow(/fd/)
      return
    }
    const { root, byName } = workspace()
    writeFileSync(join(root, "f.txt"), "x")
    const result = await byName.find.execute("f1", { pattern: "*.txt" })
    const text = result.content.find((part) => part.type === "text")?.text ?? ""
    expect(text).toContain("f.txt")
  })

  test("bash background returns pid and log", async () => {
    const { root, byName } = workspace()
    const result = await byName.bash.execute("b1", {
      command: "printf hi-bg",
      background: true,
    })
    const details = result.details as {
      pid: number
      logPath: string
      background: boolean
    }
    expect(details.background).toBe(true)
    expect(details.pid).toBeGreaterThan(0)
    expect(details.logPath).toMatch(/^\.aegisx\/bg\/.+\.log$/)
    const abs = join(root, details.logPath)
    const deadline = Date.now() + 2000
    while (!existsSync(abs) && Date.now() < deadline) {
      await Bun.sleep(20)
    }
    // process may still be flushing; wait briefly for content
    const contentDeadline = Date.now() + 2000
    let log = ""
    while (Date.now() < contentDeadline) {
      if (existsSync(abs)) {
        log = readFileSync(abs, "utf8")
        if (log.includes("hi-bg")) break
      }
      await Bun.sleep(20)
    }
    expect(log).toContain("hi-bg")
  })

  test("ls respects limit", async () => {
    const { root, byName } = workspace()
    writeFileSync(join(root, "a"), "1")
    writeFileSync(join(root, "b"), "2")
    writeFileSync(join(root, "c"), "3")
    const result = await byName.ls.execute("l1", { path: ".", limit: 2 })
    expect(result.details).toMatchObject({
      count: 2,
      total: 3,
      truncated: true,
    })
  })

  test("read suggests similar paths when missing", async () => {
    const { root, byName } = workspace()
    writeFileSync(join(root, "exploit.py"), "print(1)\n")
    await expect(
      byName.read.execute("r-miss", { filePath: "explot.py" })
    ).rejects.toThrow(/Did you mean[\s\S]*exploit\.py/)
  })

  test("bash workdir changes cwd", async () => {
    const { root, byName } = workspace()
    const sub = join(root, "sub")
    writeFileSync(join(root, "root.txt"), "r")
    mkdirSync(sub)
    writeFileSync(join(sub, "nested.txt"), "n")
    const result = await byName.bash.execute("b-wd", {
      command: "pwd && ls",
      workdir: "sub",
    })
    const text = result.content.find((part) => part.type === "text")?.text ?? ""
    expect(text).toContain("nested.txt")
    expect(text).not.toContain("root.txt")
  })

  test("grep supports offset and content context", async () => {
    const { root, byName } = workspace()
    writeFileSync(
      join(root, "g2.txt"),
      "line1 needle\nline2 needle\nline3 needle\n"
    )
    const page = await byName.grep.execute("g-off", {
      pattern: "needle",
      outputMode: "content",
      offset: 1,
      limit: 1,
    })
    const text = page.content.find((part) => part.type === "text")?.text ?? ""
    expect(text).toContain("line2 needle")
    expect(text).not.toContain("line1 needle")
  })
})
