import { describe, expect, test } from "bun:test"
import { createDockerExecBackend } from "../../src/run/workspace/backend"

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
