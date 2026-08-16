import { describe, expect, test } from "bun:test"

import type { TargetState } from "@aegisx/shared/domain"
import type { ToolDefinition } from "@earendil-works/pi-coding-agent"

import { createMainTools, type RunToolContext } from "../../src/run/tools"

function mockCtx(overrides: Partial<RunToolContext> = {}): RunToolContext {
  return {
    runId: "r",
    challengeId: "c",
    agentId: "main",
    submitFlag: async () => ({ status: "accepted" }),
    targetAction: async () => ({
      status: "running",
      endpoints: [],
      expiresAt: null,
    }),
    requestFinish: () => {},
    hasAcceptedFlag: () => true,
    finishFlagWarned: () => false,
    markFinishFlagWarned: () => {},
    lastAssistantText: () => null,
    ...overrides,
  }
}

const fullTools = [
  "finish_run",
  "submit_flag",
  "get_target",
  "start_target",
  "extend_target",
  "stop_target",
]

const textOf = (result: { content: Array<{ type: string; text?: string }> }) =>
  (result.content[0] as { text: string }).text

/** Find a tool by name, failing loudly if it is missing. */
const findTool = (tools: ToolDefinition[], name: string): ToolDefinition => {
  const tool = tools.find((t) => t.name === name)
  if (!tool) throw new Error(`Tool not found: ${name}`)
  return tool
}

/**
 * Invoke a tool's execute with the trailing SDK args stubbed out. The generic
 * param schema is erased (`as never`) since tests pass ad-hoc objects.
 */
const invoke = (tool: ToolDefinition, params: object) =>
  Promise.resolve(
    tool.execute(
      "id",
      params as never,
      undefined,
      undefined,
      undefined as never
    )
  )

describe("createMainTools", () => {
  test("grants exactly the tools listed in the snapshot", () => {
    const tools = createMainTools(mockCtx(), fullTools)
    expect(tools.map((t) => t.name).sort()).toEqual([...fullTools].sort())
  })

  test("empty snapshot grants no native tools (file tools are always on)", () => {
    const tools = createMainTools(mockCtx(), [])
    expect(tools).toEqual([])
  })

  test("names of the removed inter-agent tools are never granted (v9)", () => {
    const tools = createMainTools(mockCtx(), [
      "spawn_agent",
      "read_agent",
      "message_agent",
      "list_agents",
    ])
    expect(tools).toEqual([])
  })

  test("no finish_run in the snapshot → no finish_run tool", () => {
    const tools = createMainTools(mockCtx(), ["submit_flag"])
    expect(tools.map((t) => t.name)).not.toContain("finish_run")
  })

  test("executionMode: finish/submit/target sequential", () => {
    const tools = createMainTools(mockCtx(), fullTools)
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]))
    expect(byName.finish_run.executionMode).toBe("sequential")
    expect(byName.submit_flag.executionMode).toBe("sequential")
    expect(byName.get_target.executionMode).toBe("sequential")
    expect(byName.stop_target.executionMode).toBe("sequential")
  })

  test("finish_run requires the target to be stopped", async () => {
    const tools = createMainTools(
      mockCtx({
        targetAction: async () => ({
          status: "running",
          endpoints: [],
          expiresAt: null,
        }),
      }),
      ["finish_run", "get_target", "stop_target"]
    )
    const finish = findTool(tools, "finish_run")
    await expect(invoke(finish, { summary: "s" })).rejects.toThrow(
      /Stop the remote target/
    )
  })

  test("finish_run requests finish + terminates when gates pass", async () => {
    let finished: string | null = null
    const tools = createMainTools(
      mockCtx({
        targetAction: async () => ({
          status: "absent",
          endpoints: [],
          expiresAt: null,
        }),
        requestFinish: (s) => {
          finished = s
        },
      }),
      ["finish_run", "get_target", "stop_target"]
    )
    const finish = findTool(tools, "finish_run")
    const result = await invoke(finish, { summary: "  done  " })
    expect(finished as string | null).toBe("done")
    expect(result.terminate).toBe(true)
  })

  test("finish_run warns once when no flag accepted, then finishes", async () => {
    let finished = 0
    let warned = false
    const tools = createMainTools(
      mockCtx({
        hasAcceptedFlag: () => false,
        finishFlagWarned: () => warned,
        markFinishFlagWarned: () => {
          warned = true
        },
        requestFinish: () => {
          finished += 1
        },
      }),
      ["finish_run"]
    )
    const finish = findTool(tools, "finish_run")

    // First call without an accepted flag → warning, no finish, no terminate.
    const warn = await invoke(finish, { summary: "solved" })
    expect(finished).toBe(0)
    expect(warn.terminate).not.toBe(true)
    const first = warn.content[0]
    const warnText = first && "text" in first ? String(first.text) : ""
    expect(warnText).toContain("submit_flag")

    // Second call (still no flag, but already warned) → finishes normally.
    const done = await invoke(finish, { summary: "unsolved" })
    expect(finished).toBe(1)
    expect(done.terminate).toBe(true)
  })

  test("target tool surfaces endpoint guidance (wsrx connect hint)", async () => {
    const state: TargetState = {
      status: "running",
      expiresAt: null,
      endpoints: [
        {
          name: "port 1337",
          address: "ws://x/traffic/t?port=1337",
          protocol: "ws",
          guidance: [
            "This is a Ret2Shell WSRX tunnel endpoint.",
            "Start a local tunnel with: wsrx connect 'ws://x/traffic/t?port=1337' --host 127.0.0.1 --port <local-port>",
          ],
        },
      ],
    }
    const tools = createMainTools(
      mockCtx({ targetAction: async () => state }),
      ["get_target"]
    )
    const getTarget = findTool(tools, "get_target")
    const result = await invoke(getTarget, {})
    expect(textOf(result)).toContain("wsrx connect")
  })
})
