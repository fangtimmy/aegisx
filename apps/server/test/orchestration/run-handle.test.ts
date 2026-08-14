import { describe, expect, test } from "bun:test"

import type { agents } from "../../src/db/schema"
import {
  createRunHandle,
  RunEmitter,
  type FreshAgentInput,
  type RunHandleHost,
} from "../../src/orchestration/run-handle"
import type {
  AgentSlotSpec,
  PromptContext,
  SlotModel,
} from "../../src/orchestration/types"

type AgentRow = typeof agents.$inferSelect

const baseCtx: PromptContext = {
  event: { id: "e1", name: "Ev", platform: "ctfd", promptHint: "" },
  challenge: {
    id: "c1",
    name: "Ch",
    description: "d",
    category: "web",
    points: 100,
    attachments: [],
    attachmentPaths: [],
  },
  run: {
    id: "run-1",
    environment: "container",
    isContainer: true,
    workspace: "/workspace",
    targetSupported: true,
    platformIntegrated: true,
    containerImage: "img",
    cpus: 2,
    memoryMb: 1024,
    pidsLimit: 128,
  },
  capabilities: {
    canFinish: true,
    canSubmitFlag: true,
    canManageTarget: true,
    canSpawn: true,
  },
}

const fixedSlotModel: SlotModel = {
  ref: "p/m:off",
  thinkingLevel: "off",
  providerLabel: "P",
  modelLabel: "M",
  modelId: "m",
}

function fakeHost(opts: {
  ctx?: PromptContext
  initialPrompt?: string
  templateMap?: Map<string, string>
  existing?: Record<string, { id: string; role: string }>
  agents: AgentSlotSpec[]
  resolveSlotModel?: (slot: string) => SlotModel
}): { host: RunHandleHost; created: FreshAgentInput[] } {
  const created: FreshAgentInput[] = []
  const existing = new Map(Object.entries(opts.existing ?? {}))
  const host: RunHandleHost = {
    runId: "run-1",
    scope: "challenge",
    ctx: opts.ctx ?? baseCtx,
    initialPrompt: opts.initialPrompt ?? "GO",
    templateMap:
      opts.templateMap ??
      new Map([
        [
          "mainSystem",
          "PROMPT {{agent.name}} flag={{capabilities.canSubmitFlag}} finish={{capabilities.canFinish}}",
        ],
      ]),
    emitter: new RunEmitter(),
    agents: opts.agents,
    findAgentBySlot: (slot) => existing.get(slot) as AgentRow | undefined,
    createFreshAgent: (input) => {
      created.push(input)
      return `a-${created.length}`
    },
    resolveSlotModel: opts.resolveSlotModel ?? (() => fixedSlotModel),
    isAgentStreaming: () => false,
    prepareAgent: async () => {},
    sendToAgent: async () => {},
    abortAgent: async () => {},
  }
  return { host, created }
}

describe("createRunHandle (declarative slots, spec §3.2/§4.3)", () => {
  test("fresh: materializes declared agents, renders per-agent caps, tracks prime", () => {
    const { host, created } = fakeHost({
      agents: [
        {
          slot: "solver",
          name: "Solver",
          entry: true,
          systemPrompt: "mainSystem",
          tools: ["finish_run", "submit_flag"],
          prime: true,
        },
      ],
    })
    const handle = createRunHandle(host)

    expect(created).toHaveLength(1)
    const agent = created[0]!
    expect(agent.slot).toBe("solver")
    expect(agent.role).toBe("solver")
    expect(agent.isEntry).toBe(true)
    expect(agent.tools).toEqual(["finish_run", "submit_flag"])
    expect(agent.model).toBe("p/m:off")
    // capabilities derived from the tool list injected into the render.
    expect(agent.systemPrompt).toBe("PROMPT Solver flag=true finish=true")
    expect(handle.primeSpecs).toEqual([
      { agentId: "a-1", slot: "solver", prime: "GO" },
    ])
  })

  test("fresh: caps derived from tools, not from run-level ctx", () => {
    const { host, created } = fakeHost({
      agents: [
        {
          slot: "probe",
          name: "Probe",
          systemPrompt: "mainSystem",
          tools: ["finish_run"], // no submit_flag
        },
      ],
    })
    createRunHandle(host)
    expect(created[0]!.systemPrompt).toBe("PROMPT Probe flag=false finish=true")
  })

  test("restore: reuses existing row (snapshot priority), does NOT re-persist", () => {
    const { host, created } = fakeHost({
      existing: { solver: { id: "existing-1", role: "solver" } },
      agents: [
        {
          slot: "solver",
          name: "Solver",
          entry: true,
          systemPrompt: "mainSystem", // ignored on restore
          tools: ["finish_run"], // ignored on restore
          prime: true,
        },
      ],
    })
    const handle = createRunHandle(host)
    // No fresh insert happened (snapshot priority).
    expect(created).toHaveLength(0)
    // The existing id/role are reused.
    expect(handle.agent("solver").id).toBe("existing-1")
    expect(handle.agent("solver").role).toBe("solver")
    // prime is still collected; the SERVICE ignores it on restore.
    expect(handle.primeSpecs.map((p) => p.agentId)).toContain("existing-1")
  })

  test("agent(slot) / agents return declared handles; unknown slot throws", () => {
    const { host } = fakeHost({
      agents: [
        { slot: "solver", name: "S", systemPrompt: "mainSystem", tools: [] },
      ],
    })
    const handle = createRunHandle(host)
    expect(handle.agent("solver").slot).toBe("solver")
    expect(handle.agents).toHaveLength(1)
    expect(() => handle.agent("nope")).toThrow(
      "No agent declared for slot: nope"
    )
  })

  test("tools builder receives the run context (conditional target tools)", () => {
    const seen: boolean[] = []
    const { host, created } = fakeHost({
      ctx: { ...baseCtx, run: { ...baseCtx.run!, targetSupported: false } },
      agents: [
        {
          slot: "solver",
          name: "S",
          systemPrompt: "mainSystem",
          tools: (ctx) => {
            seen.push(ctx.run?.targetSupported ?? false)
            return ["finish_run"]
          },
        },
      ],
    })
    createRunHandle(host)
    expect(seen).toEqual([false])
    expect(created[0]!.tools).toEqual(["finish_run"])
  })

  test("render: resolves against the in-memory map with extraVars overlay", () => {
    const map = new Map([["greet", "Hi {{agent.name}} on {{run.id}}"]])
    const { host } = fakeHost({
      templateMap: map,
      agents: [],
    })
    const handle = createRunHandle(host)
    expect(
      handle.render("greet", {
        agent: { role: "x", isMain: true, name: "Bot", task: null },
      })
    ).toBe("Hi Bot on run-1")
    expect(() => handle.render("missing")).toThrow(
      "Prompt template not found: missing"
    )
  })

  test("on(): run-level + agent-level filtering, callbacks wrapped in try/catch", () => {
    const { host } = fakeHost({
      agents: [
        { slot: "solver", name: "S", systemPrompt: "mainSystem", tools: [] },
      ],
    })
    const handle = createRunHandle(host)
    const runSeen: string[] = []
    const agentSeen: string[] = []
    handle.on("turnEnded", () => {
      runSeen.push("run")
    })
    handle.agent("solver").on("turnEnded", () => {
      agentSeen.push("agent")
    })
    // A throwing callback must not abort dispatch to the others.
    handle.on("turnEnded", () => {
      throw new Error("boom")
    })
    // emit goes to run-level + the solver's agent-level subscribers.
    expect(() => host.emitter.emit("a-1", { type: "turnEnded" })).not.toThrow()
    expect(runSeen).toEqual(["run"])
    expect(agentSeen).toEqual(["agent"])
    // A non-matching agent id gets run-level only.
    host.emitter.emit("other", { type: "turnEnded" })
    expect(runSeen).toEqual(["run", "run"])
    expect(agentSeen).toEqual(["agent"])
  })
})
