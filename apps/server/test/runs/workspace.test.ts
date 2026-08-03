import { describe, expect, test } from "bun:test"
import tarStream from "tar-stream"
import {
  buildSingleFileTar,
  createDockerExecBackend,
} from "../../src/run/workspace/backend"

/** manager is only touched by read/write/list/exec; resolvePath is pure. */
const backend = createDockerExecBackend("container", {} as never)

describe("DockerExecBackend.resolvePath", () => {
  test("relative path → under /workspace", () => {
    expect(backend.resolvePath("exploit.py")).toBe("/workspace/exploit.py")
    expect(backend.resolvePath("sub/dir/x")).toBe("/workspace/sub/dir/x")
  })

  test("/workspace/x is idempotent", () => {
    expect(backend.resolvePath("/workspace/exploit.py")).toBe(
      "/workspace/exploit.py"
    )
  })

  test("read-only keeps other absolute paths (e.g. /opt/solver/**)", () => {
    expect(backend.resolvePath("/opt/solver/ENVIRONMENT.md")).toBe(
      "/opt/solver/ENVIRONMENT.md"
    )
  })

  test("write is constrained to the workspace root", () => {
    expect(backend.resolvePath("/workspace/exploit.py", true)).toBe(
      "/workspace/exploit.py"
    )
    expect(backend.resolvePath("exploit.py", true)).toBe(
      "/workspace/exploit.py"
    )
    expect(() => backend.resolvePath("/opt/solver/x", true)).toThrow(
      /outside the allowed workspace/
    )
    expect(() => backend.resolvePath("../etc/passwd", true)).toThrow(
      /outside the allowed workspace/
    )
    expect(() => backend.resolvePath("/workspace/../etc", true)).toThrow(
      /outside the allowed workspace/
    )
  })
})

describe("buildSingleFileTar", () => {
  test("round-trips name + text content", async () => {
    const tar = await buildSingleFileTar("exploit.py", "print('hi')\n")
    const got = await extractSingle(tar)
    expect(got.name).toBe("exploit.py")
    expect(got.content).toBe("print('hi')\n")
  })

  test("preserves binary bytes", async () => {
    const bytes = new Uint8Array([0, 255, 10, 137, 80, 78, 71])
    const tar = await buildSingleFileTar("blob.bin", bytes)
    const got = await extractSingle(tar)
    expect(Array.from(got.bytes)).toEqual(Array.from(bytes))
  })
})

function extractSingle(
  tar: Buffer
): Promise<{ name: string; content: string; bytes: Uint8Array }> {
  return new Promise((resolve, reject) => {
    const extract = tarStream.extract()
    extract.on("entry", (header, stream, next) => {
      const chunks: Buffer[] = []
      stream.on("data", (c: Uint8Array) => chunks.push(Buffer.from(c)))
      stream.on("error", reject)
      stream.on("end", () => {
        const content = Buffer.concat(chunks)
        resolve({
          name: header.name,
          content: content.toString("utf8"),
          bytes: new Uint8Array(content),
        })
        next()
      })
    })
    extract.on("error", reject)
    extract.end(tar)
  })
}
