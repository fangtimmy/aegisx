import { describe, expect, test } from "bun:test"

import type { WorkspaceBackend } from "../../src/run/workspace/backend"
import { createWorkspaceTools } from "../../src/run/workspace/tools"

/** Minimal WorkspaceBackend stub returning a fixed byte payload for read. */
function mockBackend(bytes: Uint8Array): WorkspaceBackend {
  return {
    cwd: "/workspace",
    resolvePath: (p: string) => `/workspace/${p}`,
    async read() {
      return { data: bytes, truncated: false, totalBytes: bytes.byteLength }
    },
    async write() {},
    async list() {
      return []
    },
  } as unknown as WorkspaceBackend
}

const invoke = async (
  backend: WorkspaceBackend,
  multimodal: boolean,
  filePath = "img.png"
) => {
  const [read] = createWorkspaceTools(backend, { multimodal })
  const signal = new AbortController().signal
  return read.execute("id", { filePath }, signal, undefined, undefined as never)
}

// Minimal structurally valid 1×1 RGB PNG (signature + IHDR + IDAT + IEND) —
// file-type's core PNG detector parses the header, so truncated
// signature-only bytes no longer qualify as images.
const PNG = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0,
  0, 0, 1, 8, 2, 0, 0, 0, 144, 119, 83, 222, 0, 0, 0, 12, 73, 68, 65, 84, 120,
  156, 99, 248, 207, 192, 0, 0, 3, 1, 1, 0, 201, 254, 146, 239, 0, 0, 0, 0, 73,
  69, 78, 68, 174, 66, 96, 130,
])

describe("read tool image attach", () => {
  test("multimodal model: image bytes attached as ImageContent", async () => {
    const result = await invoke(mockBackend(PNG), true)
    expect(result.content).toHaveLength(2)
    expect(result.content[0]).toMatchObject({ type: "text" })
    expect(result.content[1]).toMatchObject({
      type: "image",
      mimeType: "image/png",
    })
    expect(result.details).toMatchObject({
      kind: "image",
      attached: true,
    })
  })

  test("text-only model: no image bytes, text hint + attached:false", async () => {
    const result = await invoke(mockBackend(PNG), false)
    expect(result.content).toHaveLength(1)
    expect(result.content[0]).toMatchObject({ type: "text" })
    expect(result.details).toMatchObject({ kind: "image", attached: false })
    // Hint should point the model at bash tooling.
    expect((result.content[0] as { text: string }).text).toContain("bash")
  })

  test("multimodal model but image too large: falls back to text hint", async () => {
    // 6MB png — exceeds the 5MB attach cap. file-type only parses the
    // header, so the trailing zero padding does not affect detection.
    const huge = new Uint8Array(6 * 1024 * 1024)
    huge.set(PNG, 0)
    const result = await invoke(mockBackend(huge), true)
    expect(result.content).toHaveLength(1)
    expect(result.content[0]).toMatchObject({ type: "text" })
    expect(result.details).toMatchObject({ attached: false })
  })
})
