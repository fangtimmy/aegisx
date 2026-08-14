import { describe, expect, test } from "bun:test"

import type { WorkspaceBackend } from "../../src/run/workspace/backend"
import { createWorkspaceTools } from "../../src/run/workspace/tools"

/** Minimal WorkspaceBackend stub returning a fixed byte payload for read. */
function mockBackend(bytes: Uint8Array): WorkspaceBackend {
  return {
    cwd: "/workspace",
    resolvePath: (p: string) => `/workspace/${p}`,
    async read() {
      return bytes
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

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
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
    // 6MB png header — exceeds the 5MB attach cap.
    const huge = new Uint8Array(6 * 1024 * 1024)
    huge.set(PNG.subarray(0, 8), 0)
    const result = await invoke(mockBackend(huge), true)
    expect(result.content).toHaveLength(1)
    expect(result.content[0]).toMatchObject({ type: "text" })
    expect(result.details).toMatchObject({ attached: false })
  })
})
