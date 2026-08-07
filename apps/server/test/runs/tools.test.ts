import { describe, expect, test } from "bun:test"

import type { AgentSummary } from "@aegisx/shared/agent"
import type { TargetState } from "@aegisx/shared/target"
import type { ToolDefinition } from "@earendil-works/pi-coding-agent"

import {
  createMainTools,
  type RunToolContext,
  type ToolCapabilities,
} from "../../src/run/tools"

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
    spawnChild: async (input) => ({
      agentId: "child",
      name: input.name,
      status: "running",
    }),
    getAgent: () => undefined,
    lastAssistantText: () => null,
    ...overrides,
  }
}

const allCaps: ToolCapabilities = {
  canSubmitFlag: true,
  canManageTarget: true,
  canSpawnAgent: true,
}

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
  tool.execute("id", params as never, undefined, undefined, undefined as never)

describe("createMainTools", () => {
  test("tool names use v2 verb_noun targets and include inspect_agent", () => {
    const tools = createMainTools(mockCtx(), allCaps)
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual(
      [
        "finish_run",
        "submit_flag",
        "get_target",
        "start_target",
        "extend_target",
        "stop_target",
        "spawn_agent",
        "inspect_agent",
      ].sort()
    )
  })

  test("only finish_run remains when no capabilities are granted", () => {
    const tools = createMainTools(mockCtx(), {
      canSubmitFlag: false,
      canManageTarget: false,
      canSpawnAgent: false,
    })
    expect(tools.map((t) => t.name)).toEqual(["finish_run"])
  })

  test("executionMode: finish/submit/target sequential, spawn parallel", () => {
    const tools = createMainTools(mockCtx(), allCaps)
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]))
    expect(byName.finish_run.executionMode).toBe("sequential")
    expect(byName.submit_flag.executionMode).toBe("sequential")
    expect(byName.get_target.executionMode).toBe("sequential")
    expect(byName.stop_target.executionMode).toBe("sequential")
    expect(byName.spawn_agent.executionMode).toBe("parallel")
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
      { canSubmitFlag: true, canManageTarget: true, canSpawnAgent: false }
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
      { canSubmitFlag: true, canManageTarget: true, canSpawnAgent: false }
    )
    const finish = findTool(tools, "finish_run")
    const result = await invoke(finish, { summary: "  done  " })
    expect(finished as string | null).toBe("done")
    expect(result.terminate).toBe(true)
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
      { canSubmitFlag: false, canManageTarget: true, canSpawnAgent: false }
    )
    const getTarget = findTool(tools, "get_target")
    const result = await invoke(getTarget, {})
    expect(textOf(result)).toContain("wsrx connect")
  })

  test("inspect_agent rejects children not owned by this parent", async () => {
    const foreignChild: AgentSummary = {
      id: "child",
      runId: "r",
      role: "child",
      parentAgentId: "other-parent",
      name: "Child",
      task: "t",
      status: "completed",
      sessionFile: null,
      createdAt: "",
      startedAt: null,
      updatedAt: "",
      completedAt: null,
      error: null,
    }
    const tools = createMainTools(mockCtx({ getAgent: () => foreignChild }), {
      canSubmitFlag: false,
      canManageTarget: false,
      canSpawnAgent: true,
    })
    const inspect = findTool(tools, "inspect_agent")
    await expect(invoke(inspect, { agent_id: "child" })).rejects.toThrow(
      /not found/
    )
  })

  test("inspect_agent returns owned child status + latest output", async () => {
    const child: AgentSummary = {
      id: "child",
      runId: "r",
      role: "child",
      parentAgentId: "main",
      name: "Child",
      task: "t",
      status: "completed",
      sessionFile: null,
      createdAt: "",
      startedAt: null,
      updatedAt: "",
      completedAt: null,
      error: null,
    }
    const tools = createMainTools(
      mockCtx({ getAgent: () => child, lastAssistantText: () => "flag found" }),
      { canSubmitFlag: false, canManageTarget: false, canSpawnAgent: true }
    )
    const inspect = findTool(tools, "inspect_agent")
    const result = await invoke(inspect, { agent_id: "child" })
    const body = JSON.parse(textOf(result))
    expect(body).toMatchObject({
      id: "child",
      status: "completed",
      summary: "flag found",
    })
  })

  test("spawn_agent starts in background and returns the new agent id", async () => {
    let spawned: { name: string; task: string } | null = null
    const tools = createMainTools(
      mockCtx({
        spawnChild: async (input) => {
          spawned = input
          return { agentId: "child-1", name: input.name, status: "running" }
        },
      }),
      { canSubmitFlag: false, canManageTarget: false, canSpawnAgent: true }
    )
    const spawn = findTool(tools, "spawn_agent")
    const result = await invoke(spawn, { name: "Probe", task: "scan" })
    expect(spawned as { name: string; task: string } | null).toEqual({
      name: "Probe",
      task: "scan",
    })
    const body = textOf(result)
    expect(body).toContain("child-1")
    expect(body).toContain("background")
    expect(body).toContain("automatically")
  })
})
