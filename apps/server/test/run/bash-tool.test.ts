import { describe, expect, setSystemTime, test } from "bun:test"

import { verifyAgentToken } from "../../src/infrastructure/agent-credentials"
import { createBashTool } from "../../src/run/bash-tool"
import type { ContainerManager } from "../../src/run/container/container-manager"
import { sdkExecEnv } from "../../src/run/container/env-contract"
import { refine } from "../support"

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
      aborted: false,
    }
  }
  return refine<ContainerManager>({ exec })
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
    refine(undefined)
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
      refine(undefined)
    )
    expect(result.details).toMatchObject({ terminal: "cancelled" })
  })
})

describe("createBashTool exec env provider", () => {
  test("the provider is evaluated at each execute — tokens are minted lazily, never captured", async () => {
    const t0 = Date.parse("2026-01-01T00:00:00Z")
    setSystemTime(t0)
    try {
      const envs: Array<Record<string, string>> = []
      const exec = async (
        _name: string,
        _command: string,
        opts: { env?: string[] }
      ) => {
        const captured: Record<string, string> = {}
        for (const entry of opts.env ?? []) {
          const eq = entry.indexOf("=")
          captured[entry.slice(0, eq)] = entry.slice(eq + 1)
        }
        envs.push(captured)
        return { exitCode: 0, timedOut: false, aborted: false }
      }
      const manager = refine<ContainerManager>({ exec })
      const tool = createBashTool(
        "/workspace",
        "c",
        manager,
        sdkExecEnv("agent-9")
      )
      await invoke(tool, "echo 1")
      // A later execute re-mints (different exp → different token); 30min
      // keeps the first token inside its TTL for the verify below.
      setSystemTime(t0 + 1_800_000)
      await invoke(tool, "echo 2")

      expect(envs).toHaveLength(2)
      for (const env of envs) {
        expect(env["AEGISX_AGENT_ID"]).toBe("agent-9")
        expect(verifyAgentToken(env["AEGISX_TOKEN"] ?? "")).toEqual({
          agentId: "agent-9",
        })
      }
      expect(envs[1]["AEGISX_TOKEN"]).not.toBe(envs[0]["AEGISX_TOKEN"])
    } finally {
      setSystemTime()
    }
  })
})
