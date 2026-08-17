import { describe, expect, test } from "bun:test"

import { extract } from "tar-stream"

import {
  buildSingleFileTar,
  createDockerExecBackend,
} from "../../src/run/workspace/backend"

/** manager is only touched by read/write/list/exec; resolvePath is pure. */
const backend = createDockerExecBackend("container", {} as never, "/workspace")

/** Fake manager returning a fixed capture result (the backend only forwards
 * maxCapture; the cap enforcement itself is tested in container-manager). */
function fakeCaptureManager(result: {
  stdout: Buffer
  totalBytes: number
  truncated?: boolean
}) {
  return {
    capture: async (
      _name: string,
      _command: string,
      opts?: { maxCapture?: number }
    ) => ({
      stdout:
        opts?.maxCapture !== undefined
          ? result.stdout.subarray(0, opts.maxCapture)
          : result.stdout,
      stderr: "",
      exitCode: 0,
      truncated: result.truncated ?? false,
      totalBytes: result.totalBytes,
    }),
  } as never
}

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

/**
 * Memory-bound contract: read/exec must surface truncated + true byte counts
 * instead of silently buffering a multi-GB output whole (the container-manager
 * sink drops beyond the cap; this pins the backend's reporting of it).
 */
describe("DockerExecBackend capture caps", () => {
  test("read returns truncated + totalBytes beyond the 64MB cap", async () => {
    const big = createDockerExecBackend(
      "c",
      fakeCaptureManager({
        stdout: Buffer.alloc(1024 * 1024, 0x61),
        totalBytes: 200 * 1024 * 1024,
        truncated: true,
      }),
      "/workspace"
    )
    const result = await big.read("big.bin")
    expect(result.truncated).toBe(true)
    expect(result.totalBytes).toBe(200 * 1024 * 1024)
    expect(result.data.byteLength).toBe(1024 * 1024)
  })

  test("exec marks truncated and reports the true outputBytes", async () => {
    const big = createDockerExecBackend(
      "c",
      fakeCaptureManager({
        stdout: Buffer.from("partial output"),
        totalBytes: 200 * 1024 * 1024,
        truncated: true,
      }),
      "/workspace"
    )
    const result = await big.exec("cat huge.log")
    expect(result.truncated).toBe(true)
    expect(result.outputBytes).toBe(200 * 1024 * 1024)
    expect(result.stdout).toBe("partial output")
  })

  test("read without truncation returns the full data", async () => {
    const small = createDockerExecBackend(
      "c",
      fakeCaptureManager({
        stdout: Buffer.from("hello world\n"),
        totalBytes: 12,
      }),
      "/workspace"
    )
    const result = await small.read("small.txt")
    expect(result.truncated).toBe(false)
    expect(new TextDecoder().decode(result.data)).toBe("hello world\n")
  })
})

function extractSingle(
  tar: Buffer
): Promise<{ name: string; content: string; bytes: Uint8Array }> {
  return new Promise((resolve, reject) => {
    const extractStream = extract()
    extractStream.on("entry", (header, stream, next) => {
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
    extractStream.on("error", reject)
    extractStream.end(tar)
  })
}
