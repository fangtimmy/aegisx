import { describe, expect, test } from "bun:test"

import { createBashTool } from "../../src/run/bash-tool"
import type { ContainerManager } from "../../src/run/container/container-manager"

/** Minimal ContainerManager stub: drives onData with canned output, then
 * resolves the configured exit/timedOut state. */
function mockManager(opts: {
  output?: string
  exitCode?: number | null
  timedOut?: boolean
}): ContainerManager {
  const exec = async () => {
    if (opts.output) {
      // the tool passes an onData sink that consumes Buffers
    }
    return {
      exitCode: opts.exitCode ?? 0,
      timedOut: opts.timedOut ?? false,
    }
  }
  return { exec } as unknown as ContainerManager
}

const invoke = async (
  tool: ReturnType<typeof createBashTool>,
  command: string
) => {
  const signal = new AbortController().signal
  return tool.execute(
    "call-1",
    { command },
    signal,
    undefined,
    undefined as never
  )
}

describe("createBashTool result details", () => {
  test("success (exit 0): no terminal, details carry exitCode 0", async () => {
    const tool = createBashTool("/workspace", "c", mockManager({ exitCode: 0 }))
    const result = await invoke(tool, "echo ok")
    expect(result.details).toMatchObject({ exitCode: 0, terminal: undefined })
  })

  test("non-zero exit: terminal 'failed' + exitCode preserved (does not throw)", async () => {
    const tool = createBashTool("/workspace", "c", mockManager({ exitCode: 1 }))
    const result = await invoke(tool, "false")
    // The whole point: a structured result comes back instead of a throw, so
    // exitCode / terminal survive into the persisted toolResult for the UI.
    expect(result.details).toMatchObject({ exitCode: 1, terminal: "failed" })
    expect(result.content[0]).toMatchObject({ type: "text" })
  })

  test("timeout: terminal 'timed_out'", async () => {
    const tool = createBashTool(
      "/workspace",
      "c",
      mockManager({ exitCode: null, timedOut: true })
    )
    const result = await invoke(tool, "sleep 999")
    expect(result.details).toMatchObject({
      timedOut: true,
      terminal: "timed_out",
    })
  })

  test("aborted: terminal 'cancelled'", async () => {
    const tool = createBashTool("/workspace", "c", mockManager({ exitCode: 0 }))
    const controller = new AbortController()
    controller.abort()
    const result = await tool.execute(
      "call-1",
      { command: "sleep 1" },
      controller.signal,
      undefined,
      undefined as never
    )
    expect(result.details).toMatchObject({ terminal: "cancelled" })
  })
})
