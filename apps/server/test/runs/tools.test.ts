import { describe, expect, test } from "bun:test"

import type { AgentSummary } from "@aegisx/shared/agent"
import type { TargetState } from "@aegisx/shared/target"
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
    spawnChild: async (input) => ({
      agentId: "child",
      name: input.name,
      status: "running",
    }),
    messageAgent: async () => ({ ok: true }),
    getAgent: () => undefined,
    listAgents: () => [],
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
  "spawn_agent",
  "message_agent",
  "read_agent",
  "list_agents",
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

  test("no finish_run in the snapshot → no finish_run tool (bootstrap case)", () => {
    const tools = createMainTools(mockCtx(), ["submit_flag", "read_agent"])
    expect(tools.map((t) => t.name)).not.toContain("finish_run")
  })

  test("executionMode: finish/submit/target sequential, spawn parallel", () => {
    const tools = createMainTools(mockCtx(), fullTools)
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

  test("read_agent rejects agents outside this run", async () => {
    const tools = createMainTools(mockCtx({ getAgent: () => undefined }), [
      "read_agent",
    ])
    const read = findTool(tools, "read_agent")
    await expect(invoke(read, { agent_id: "ghost" })).rejects.toThrow(
      /not found in this run/
    )
  })

  test("read_agent returns peer status + latest output", async () => {
    const peer: AgentSummary = {
      id: "peer",
      runId: "r",
      slot: "solver-b",
      role: "solver",
      parentAgentId: null,
      isEntry: false,
      name: "Solver B",
      task: null,
      status: "idle",
      sessionFile: null,
      createdAt: "",
      startedAt: null,
      updatedAt: "",
      completedAt: null,
      error: null,
    }
    const tools = createMainTools(
      mockCtx({
        getAgent: () => peer,
        lastAssistantText: () => "flag format is flag{...}",
      }),
      ["read_agent"]
    )
    const read = findTool(tools, "read_agent")
    const result = await invoke(read, { agent_id: "peer" })
    const body = JSON.parse(textOf(result))
    expect(body).toMatchObject({
      id: "peer",
      role: "solver",
      status: "idle",
      summary: "flag format is flag{...}",
    })
  })

  test("message_agent delivers text to the target agent", async () => {
    let delivered: { agentId: string; text: string } | null = null
    const tools = createMainTools(
      mockCtx({
        messageAgent: async (agentId, text) => {
          delivered = { agentId, text }
          return { ok: true }
        },
      }),
      ["message_agent"]
    )
    const message = findTool(tools, "message_agent")
    const result = await invoke(message, {
      agent_id: "solver-b",
      text: "  try the crypto angle  ",
    })
    expect(delivered as { agentId: string; text: string } | null).toEqual({
      agentId: "solver-b",
      text: "try the crypto angle",
    })
    expect(textOf(result)).toContain("solver-b")
  })

  test("message_agent surfaces delivery failures", async () => {
    const tools = createMainTools(
      mockCtx({
        messageAgent: async () => ({ ok: false, error: "Agent not found" }),
      }),
      ["message_agent"]
    )
    const message = findTool(tools, "message_agent")
    await expect(
      invoke(message, { agent_id: "ghost", text: "hi" })
    ).rejects.toThrow(/Agent not found/)
  })

  test("list_agents enumerates this run's agents", async () => {
    const agents: AgentSummary[] = [
      {
        id: "a1",
        runId: "r",
        slot: "solver-a",
        role: "solver",
        parentAgentId: null,
        isEntry: true,
        name: "Solver 1",
        task: null,
        status: "running",
        sessionFile: null,
        createdAt: "",
        startedAt: null,
        updatedAt: "",
        completedAt: null,
        error: null,
      },
      {
        id: "a2",
        runId: "r",
        slot: "observer",
        role: "observer",
        parentAgentId: null,
        isEntry: false,
        name: "Observer",
        task: null,
        status: "idle",
        sessionFile: null,
        createdAt: "",
        startedAt: null,
        updatedAt: "",
        completedAt: null,
        error: null,
      },
    ]
    const tools = createMainTools(mockCtx({ listAgents: () => agents }), [
      "list_agents",
    ])
    const list = findTool(tools, "list_agents")
    const result = await invoke(list, {})
    const body = JSON.parse(textOf(result)) as Array<{
      id: string
      role: string
      status: string
    }>
    expect(body).toHaveLength(2)
    expect(body[0]).toMatchObject({
      id: "a1",
      role: "solver",
      status: "running",
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
      ["spawn_agent"]
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
